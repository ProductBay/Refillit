const express = require("express");
const crypto = require("node:crypto");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { Order, User, PharmacyProfile, PatientProfile } = require("../models");
const { writeAudit } = require("../utils/audit");
const { sendDispatchOtpWithFallback } = require("../utils/dispatchOtpNotifier");
const { sendCourierMessageFanout } = require("../utils/dispatchCommNotifier");
const { encryptValue } = require("../utils/fieldCrypto");

const router = express.Router();

const DISPATCH_TRANSITIONS = {
  none: new Set(["queued", "assigned"]),
  queued: new Set(["assigned"]),
  assigned: new Set(["accepted", "picked_up", "arrived", "delivered", "failed"]),
  accepted: new Set(["picked_up", "arrived", "delivered", "failed"]),
  picked_up: new Set(["arrived", "delivered", "failed"]),
  arrived: new Set(["picked_up", "delivered", "failed"]),
  delivered: new Set([]),
  failed: new Set(["assigned"]),
};
const courierAvailabilityState = new Map();
const courierHeartbeatState = new Map();

const FAIL_REASONS = new Set([
  "no_answer",
  "wrong_address",
  "patient_unavailable",
  "safety_issue",
  "other",
]);
const COURIER_MESSAGE_TEMPLATES = [
  {
    key: "arriving_10",
    label: "Arriving in 10 min",
    text: "Your courier is arriving in about {etaMinutes} minutes.",
  },
  {
    key: "need_gate_code",
    label: "Need gate code",
    text: "Please share your gate/building access code for delivery.",
  },
  {
    key: "handoff_ready",
    label: "Ready for handoff",
    text: "Courier has arrived. Please be ready with your OTP or QR code.",
  },
];

const OTP_TTL_MINUTES = Math.max(1, Number(process.env.DISPATCH_OTP_TTL_MINUTES || 10));
const OTP_MAX_ATTEMPTS = Math.max(1, Number(process.env.DISPATCH_OTP_MAX_ATTEMPTS || 5));
const OTP_LENGTH = 6;
const GEOFENCE_RADIUS_METERS = Math.max(50, Number(process.env.DISPATCH_GEOFENCE_RADIUS_METERS || 250));
const REQUIRE_IDENTITY_CHECKLIST = /^(1|true|yes|on)$/i.test(
  String(process.env.DISPATCH_REQUIRE_IDENTITY_CHECKLIST || "").trim()
);
const NAV_AVG_SPEED_KMH = Math.max(10, Number(process.env.DISPATCH_NAV_AVG_SPEED_KMH || 28));
const POD_HASH_ALGORITHM = "sha256";
const DISPATCH_QR_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.DISPATCH_QR_TOKEN_TTL_MS || 10 * 60 * 1000));
const DISPATCH_QR_SECRET = String(
  process.env.DISPATCH_QR_SECRET
  || process.env.JWT_SECRET
  || process.env.ACCESS_TOKEN_SECRET
  || "dev-dispatch-qr-secret"
);

const nowIso = () => new Date().toISOString();
const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());
const randomOtp = () =>
  String(Math.floor(Math.random() * 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
const hashOtp = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");
const toDate = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};
const toNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const percent = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(1)) : 0);
const dayKeyUtc = (value) => {
  const d = toDate(value);
  if (!d) return "";
  return d.toISOString().slice(0, 10);
};
const maskPhone = (value) => {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return null;
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
};
const maskEmail = (value) => {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  const [name, domain] = email.split("@");
  const left = name.slice(0, 1) || "*";
  return `${left}***@${domain}`;
};
const buildCoachingPrompts = ({ recentOrders, failed, exceptionRate, checklistRate }) => {
  const prompts = [];
  if (failed >= 3) {
    prompts.push({
      id: "coach-fail-volume",
      level: "high",
      text: "High daily failure count detected. Review unsafe-action flow and early escalation.",
    });
  }
  if (exceptionRate >= 25) {
    prompts.push({
      id: "coach-exception-rate",
      level: "medium",
      text: "Exception rate is elevated. Use ETA updates earlier and confirm destination before arrival.",
    });
  }
  if (checklistRate < 70) {
    prompts.push({
      id: "coach-checklist",
      level: "medium",
      text: "Checklist completion is below target. Complete all handoff checks before POD.",
    });
  }
  const failReasonCounts = new Map();
  for (const order of recentOrders) {
    const reason = String(order.dispatchFailureReason || order.failureReason || "").trim().toLowerCase();
    if (!reason) continue;
    failReasonCounts.set(reason, Number(failReasonCounts.get(reason) || 0) + 1);
  }
  const repeated = Array.from(failReasonCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])[0];
  if (repeated) {
    prompts.push({
      id: "coach-repeated-pattern",
      level: "high",
      text: `Repeated failure pattern: "${repeated[0]}" (${repeated[1]} times). Escalate route/instruction issues early.`,
    });
  }
  return prompts.slice(0, 4);
};

const haversineMeters = (from, to) => {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat))
      * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const hashValue = (value) =>
  crypto.createHash(POD_HASH_ALGORITHM).update(String(value || "")).digest("hex");
const toBase64Url = (value) =>
  Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
const fromBase64Url = (value) => {
  const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${raw}${"=".repeat((4 - (raw.length % 4 || 4)) % 4)}`;
  return Buffer.from(padded, "base64").toString("utf8");
};
const signQrPayload = (payloadBase64) =>
  crypto
    .createHmac(POD_HASH_ALGORITHM, DISPATCH_QR_SECRET)
    .update(String(payloadBase64 || ""))
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
const generateOtpQrToken = ({ orderId, otpHash, expiresAt }) => {
  const expiresDate = toDate(expiresAt);
  const nowMs = Date.now();
  const expMs = expiresDate
    ? Math.min(expiresDate.getTime(), nowMs + DISPATCH_QR_TOKEN_TTL_MS)
    : nowMs + DISPATCH_QR_TOKEN_TTL_MS;
  const payload = {
    oid: String(orderId || ""),
    oh: String(otpHash || ""),
    exp: expMs,
    iat: nowMs,
  };
  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const sig = signQrPayload(payloadEncoded);
  return `RFOTP|${payloadEncoded}|${sig}`;
};
const verifyOtpQrToken = ({ token, order }) => {
  const raw = String(token || "").trim();
  if (!raw) {
    return { ok: false, error: "OTP QR token is required", code: "OTP_QR_REQUIRED" };
  }
  // Support both current token format (RFOTP|payload|sig) and legacy (rfotp.payload.sig).
  let parts = null;
  let isLegacy = false;
  if (raw.startsWith("RFOTP|")) {
    parts = raw.split("|");
    isLegacy = false;
  } else {
    parts = raw.split(".");
    isLegacy = true;
  }
  if (!parts || parts.length !== 3) {
    return { ok: false, error: "Invalid OTP QR token", code: "OTP_QR_INVALID" };
  }
  if (!isLegacy && parts[0] !== "RFOTP") {
    return { ok: false, error: "Invalid OTP QR token", code: "OTP_QR_INVALID" };
  }
  if (isLegacy && parts[0] !== "rfotp") {
    return { ok: false, error: "Invalid OTP QR token", code: "OTP_QR_INVALID" };
  }
  const payloadEncoded = parts[1];
  const signature = parts[2];
  const expected = signQrPayload(payloadEncoded);
  const sigBuf = Buffer.from(String(signature || ""));
  const expectedBuf = Buffer.from(String(expected || ""));
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, error: "Invalid OTP QR signature", code: "OTP_QR_INVALID" };
  }

  let payload = null;
  try {
    payload = JSON.parse(fromBase64Url(payloadEncoded));
  } catch (_err) {
    return { ok: false, error: "Invalid OTP QR payload", code: "OTP_QR_INVALID" };
  }
  const tokenOrderId = String(payload?.oid || "");
  const tokenOtpHash = String(payload?.oh || "");
  const tokenExpMs = Number(payload?.exp || 0);
  if (!tokenOrderId || tokenOrderId !== String(order?.id || "")) {
    return { ok: false, error: "OTP QR does not match this order", code: "OTP_QR_ORDER_MISMATCH" };
  }
  if (!tokenOtpHash || tokenOtpHash !== String(order?.deliveryOtp?.hash || "")) {
    return { ok: false, error: "OTP QR is not valid for current OTP", code: "OTP_QR_OTP_MISMATCH" };
  }
  if (!Number.isFinite(tokenExpMs) || Date.now() > tokenExpMs) {
    return { ok: false, error: "OTP QR token expired", code: "OTP_QR_EXPIRED" };
  }
  return { ok: true, payload };
};
const normalizeCapturedMedia = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!raw.startsWith("data:")) return null;
  const commaIdx = raw.indexOf(",");
  if (commaIdx < 0) return null;
  const meta = raw.slice(0, commaIdx);
  const body = raw.slice(commaIdx + 1);
  const mimeMatch = /^data:([^;]+);base64$/i.exec(meta);
  if (!mimeMatch || !mimeMatch[1]) return null;
  if (!body) return null;
  return {
    mimeType: String(mimeMatch[1]).toLowerCase(),
    dataUrl: raw,
    bytes: Math.round((body.length * 3) / 4),
  };
};

const resolveOrderDestination = (order) => {
  const snap = order?.deliveryAddressSnapshot || {};
  const prefAddress = order?.deliveryPreferences?.deliveryAddress || {};
  const lat =
    toNum(snap.lat)
    ?? toNum(snap.latitude)
    ?? toNum(snap.location?.lat)
    ?? toNum(snap.location?.latitude)
    ?? toNum(prefAddress.lat)
    ?? toNum(prefAddress.latitude);
  const lng =
    toNum(snap.lng)
    ?? toNum(snap.longitude)
    ?? toNum(snap.location?.lng)
    ?? toNum(snap.location?.longitude)
    ?? toNum(prefAddress.lng)
    ?? toNum(prefAddress.longitude);
  if (lat === null || lng === null) return null;
  return { lat, lng };
};

const resolveOrderDestinationText = (order) => {
  const snap = order?.deliveryAddressSnapshot || {};
  const prefAddress = order?.deliveryPreferences?.deliveryAddress || {};
  const addressLine = String(
    snap.addressLine
    || snap.address
    || prefAddress.addressLine
    || prefAddress.address
    || ""
  ).trim();
  const city = String(snap.city || prefAddress.city || "").trim();
  const parish = String(snap.parish || prefAddress.parish || "").trim();
  const postalCode = String(snap.postalCode || prefAddress.postalCode || "").trim();
  const parts = [addressLine, city, parish, postalCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

const buildNavigationLinks = ({ destination, origin }) => {
  if (!destination) return null;
  const destinationRaw = `${destination.lat},${destination.lng}`;
  const originRaw = origin ? `${origin.lat},${origin.lng}` : "";
  const google = originRaw
    ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originRaw)}&destination=${encodeURIComponent(destinationRaw)}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destinationRaw)}&travelmode=driving`;
  const apple = originRaw
    ? `https://maps.apple.com/?saddr=${encodeURIComponent(originRaw)}&daddr=${encodeURIComponent(destinationRaw)}&dirflg=d`
    : `https://maps.apple.com/?daddr=${encodeURIComponent(destinationRaw)}&dirflg=d`;
  return { google, apple };
};

const estimateTravelMinutes = ({ from, to }) => {
  if (!from || !to) return null;
  const meters = haversineMeters(from, to);
  const km = meters / 1000;
  const mins = Math.ceil((km / NAV_AVG_SPEED_KMH) * 60);
  return Math.max(3, Math.min(180, mins));
};

const resolvePodLocation = ({ body, order }) => {
  const lat =
    toNum(body?.location?.lat ?? body?.location?.latitude)
    ?? toNum(body?.lat ?? body?.latitude)
    ?? toNum(order?.dispatchLastLocation?.lat ?? order?.dispatchLastLocation?.latitude);
  const lng =
    toNum(body?.location?.lng ?? body?.location?.longitude)
    ?? toNum(body?.lng ?? body?.longitude)
    ?? toNum(order?.dispatchLastLocation?.lng ?? order?.dispatchLastLocation?.longitude);
  if (lat === null || lng === null) return null;
  const accuracyMeters =
    toNum(body?.location?.accuracyMeters ?? body?.location?.accuracy)
    ?? toNum(body?.accuracyMeters ?? body?.accuracy);
  const capturedAtRaw = String(
    body?.location?.capturedAt
    || body?.location?.timestamp
    || body?.capturedAt
    || nowIso()
  ).trim();
  const capturedDate = toDate(capturedAtRaw);
  return {
    lat,
    lng,
    accuracyMeters: Number.isFinite(accuracyMeters) ? accuracyMeters : null,
    capturedAt: capturedDate ? capturedDate.toISOString() : nowIso(),
  };
};

const evaluateGeofence = ({ order, location }) => {
  const target = resolveOrderDestination(order);
  const lat = toNum(location?.lat ?? location?.latitude);
  const lng = toNum(location?.lng ?? location?.longitude);
  if (!target || lat === null || lng === null) {
    return { checked: false, reason: "missing_coordinates" };
  }
  const distanceMeters = haversineMeters({ lat, lng }, target);
  const withinRadius = distanceMeters <= GEOFENCE_RADIUS_METERS;
  return {
    checked: true,
    withinRadius,
    distanceMeters: Math.round(distanceMeters),
    radiusMeters: GEOFENCE_RADIUS_METERS,
    location: { lat, lng },
    target,
  };
};

const normalizeDispatchStatus = (order) => {
  const status = String(order?.dispatchStatus || "").trim().toLowerCase();
  if (DISPATCH_TRANSITIONS[status]) return status;
  if (String(order?.orderStatus || "").toLowerCase() === "assigned") return "assigned";
  if (String(order?.orderStatus || "").toLowerCase() === "completed") return "delivered";
  if (String(order?.orderStatus || "").toLowerCase() === "failed") return "failed";
  if (String(order?.deliveryOption || "").toLowerCase() === "delivery") return "queued";
  return "none";
};

const validateDispatchTransition = ({ current, next }) => {
  const currentKey = String(current || "none").toLowerCase();
  const nextKey = String(next || "").toLowerCase();
  if (!DISPATCH_TRANSITIONS[currentKey]) {
    return { ok: false, error: "Unknown current dispatch status", code: "DISPATCH_INVALID_STATE" };
  }
  if (!DISPATCH_TRANSITIONS[currentKey].has(nextKey)) {
    return { ok: false, error: `Invalid transition from ${currentKey} to ${nextKey}`, code: "DISPATCH_INVALID_TRANSITION" };
  }
  return { ok: true };
};

const applyOrderStatusMirror = (order) => {
  const status = normalizeDispatchStatus(order);
  if (status === "delivered") {
    order.orderStatus = "completed";
    return;
  }
  if (status === "failed") {
    order.orderStatus = "failed";
    return;
  }
  if (["assigned", "accepted", "picked_up", "arrived"].includes(status)) {
    order.orderStatus = "assigned";
  }
};

const pushDispatchTimeline = (order, type, actorUserId, meta = {}) => {
  const events = Array.isArray(order.dispatchTimeline) ? order.dispatchTimeline : [];
  events.push({
    id: `dsp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    at: nowIso(),
    actorUserId,
    meta,
  });
  order.dispatchTimeline = events.slice(-100);
};

const resolvePharmacyScope = async (userId) => {
  const profile = await PharmacyProfile.findOne({ where: { userId } });
  return { userId: String(userId || ""), pharmacyProfileId: String(profile?.id || "") };
};

const canAccessOrder = ({ order, role, userId, pharmacyScope }) => {
  if (!order) return false;
  const orderPharmacyId = String(order.pharmacyId || "");
  if (role === "admin") return true;
  if (role === "courier") return String(order.courierId || "") === String(userId || "");
  if (role === "pharmacy") {
    return (
      !orderPharmacyId ||
      orderPharmacyId === String(pharmacyScope?.userId || "") ||
      orderPharmacyId === String(pharmacyScope?.pharmacyProfileId || "")
    );
  }
  if (role === "patient") return String(order.patientId || "") === String(userId || "");
  return false;
};

const buildOrderView = async (order) => {
  const patient = order.patientId ? await User.findByPk(order.patientId) : null;
  const pharmacy = order.pharmacyId ? await User.findByPk(order.pharmacyId) : null;
  const pharmacyProfile = order.pharmacyId
    ? await PharmacyProfile.findOne({ where: { userId: order.pharmacyId } })
    : null;
  const courier = order.courierId ? await User.findByPk(order.courierId) : null;
  const otpDelivery = Array.isArray(order.dispatchOtpDeliveries) ? order.dispatchOtpDeliveries : [];
  const latestOtpDelivery = otpDelivery[otpDelivery.length - 1] || null;
  const destination = resolveOrderDestination(order);
  const origin = order.dispatchLastLocation || null;
  const destinationAddress = resolveOrderDestinationText(order);
  const deliveryInstructions = String(order?.deliveryPreferences?.instructions || "").trim() || null;
  const otpDeliverySummary = latestOtpDelivery
    ? {
      success: Boolean(latestOtpDelivery.success),
      deliveredVia: latestOtpDelivery.deliveredVia || null,
      attemptedAt: latestOtpDelivery.attemptedAt || null,
      channels: Array.isArray(latestOtpDelivery.channels) ? latestOtpDelivery.channels : [],
    }
    : null;
  return {
    ...order,
    dispatchStatus: normalizeDispatchStatus(order),
    sla: getSlaMeta(order),
    patientName: patient?.fullName || null,
    pharmacyName: pharmacy?.fullName || null,
    pharmacyLocation: (function () {
      try {
        const branches = Array.isArray(pharmacyProfile?.branches) ? pharmacyProfile.branches : [];
        const primary = branches[0] || null;
        const coords = primary?.coords || null;
        if (!coords) return null;
        const lat = Number(coords.lat ?? coords.latitude);
        const lng = Number(coords.lng ?? coords.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng, branchId: primary.branchId || null, address: primary.address || null };
      } catch (e) {
        return null;
      }
    })(),
    pharmacyDistanceMeters: (function () {
      try {
        const p = (function () {
          try {
            const branches = Array.isArray(pharmacyProfile?.branches) ? pharmacyProfile.branches : [];
            const primary = branches[0] || null;
            const coords = primary?.coords || null;
            if (!coords) return null;
            const lat = Number(coords.lat ?? coords.latitude);
            const lng = Number(coords.lng ?? coords.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return { lat, lng };
          } catch (e) {
            return null;
          }
        })();
        if (!p || !origin) return null;
        const meters = haversineMeters({ lat: Number(origin.lat), lng: Number(origin.lng) }, { lat: Number(p.lat), lng: Number(p.lng) });
        return Number.isFinite(meters) ? Math.round(meters) : null;
      } catch (e) {
        return null;
      }
    })(),
    pharmacyEtaMinutes: (function () {
      try {
        const p = (function () {
          try {
            const branches = Array.isArray(pharmacyProfile?.branches) ? pharmacyProfile.branches : [];
            const primary = branches[0] || null;
            const coords = primary?.coords || null;
            if (!coords) return null;
            const lat = Number(coords.lat ?? coords.latitude);
            const lng = Number(coords.lng ?? coords.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            return { lat, lng };
          } catch (e) {
            return null;
          }
        })();
        if (!p || !origin) return null;
        const eta = estimateTravelMinutes({ from: { lat: Number(origin.lat), lng: Number(origin.lng) }, to: { lat: Number(p.lat), lng: Number(p.lng) } });
        return Number.isFinite(eta) ? eta : null;
      } catch (e) {
        return null;
      }
    })(),
    deliveryDistanceMeters: (function () {
      try {
        if (!origin || !destination) return null;
        const fromLat = Number(origin.lat);
        const fromLng = Number(origin.lng);
        const toLat = Number(destination.lat);
        const toLng = Number(destination.lng);
        if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) return null;
        if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) return null;
        const meters = haversineMeters(
          { lat: fromLat, lng: fromLng },
          { lat: toLat, lng: toLng }
        );
        return Number.isFinite(meters) ? Math.round(meters) : null;
      } catch (e) {
        return null;
      }
    })(),
    deliveryEtaMinutes: (function () {
      try {
        if (!origin || !destination) return null;
        const fromLat = Number(origin.lat);
        const fromLng = Number(origin.lng);
        const toLat = Number(destination.lat);
        const toLng = Number(destination.lng);
        if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) return null;
        if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) return null;
        const eta = estimateTravelMinutes({
          from: { lat: fromLat, lng: fromLng },
          to: { lat: toLat, lng: toLng },
        });
        return Number.isFinite(eta) ? eta : null;
      } catch (e) {
        return null;
      }
    })(),
    courierName: courier?.fullName || null,
    destinationAddress,
    deliveryInstructions,
    dispatchChecklist: order.dispatchChecklist || null,
    dispatchChecklistComplete: Boolean(order?.dispatchChecklist?.completed),
    otpDeliverySummary,
    navigationLinks: buildNavigationLinks({ destination, origin }),
  };
};

const requireCourierOrderAccess = (order, userId) => {
  if (!order.courierId || String(order.courierId) === String(userId)) return true;
  return false;
};

const getMutationKey = (req) =>
  String(req.headers["x-idempotency-key"] || req.body?.idempotencyKey || "").trim();

const isSameDispatchMutation = (order, action, mutationKey) => {
  if (!mutationKey) return false;
  const last = order?.lastDispatchMutation || null;
  return Boolean(last && last.key === mutationKey && last.action === action);
};

const setDispatchMutation = (order, action, mutationKey, userId) => {
  if (!mutationKey) return;
  order.lastDispatchMutation = {
    key: mutationKey,
    action,
    at: nowIso(),
    by: userId,
  };
};

const pushNotificationEvents = (order, eventType, actorUserId, meta = {}) => {
  const notifications = Array.isArray(order.dispatchNotifications) ? order.dispatchNotifications : [];
  const recipients = [
    { channel: "patient_portal", recipientUserId: order.patientId || null, audience: "patient" },
    { channel: "pharmacy_portal", recipientUserId: order.pharmacyId || null, audience: "pharmacy" },
  ].filter((entry) => entry.recipientUserId);
  for (const recipient of recipients) {
    notifications.push({
      id: `ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: eventType,
      at: nowIso(),
      actorUserId,
      recipientUserId: recipient.recipientUserId,
      audience: recipient.audience,
      channel: recipient.channel,
      status: "queued",
      meta,
    });
  }
  order.dispatchNotifications = notifications.slice(-200);
};

const canRunSupervisorOverride = async (req, order) => {
  const role = String(req.user?.role || "").toLowerCase();
  if (role === "admin") return true;
  if (role === "moh" && String(req.user?.mohRole || "").toLowerCase() === "supervisor") return true;
  if (role === "pharmacy") {
    const scope = await resolvePharmacyScope(req.user.id);
    return canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope });
  }
  return false;
};

const canIssueOtpForOrder = async ({ req, order }) => {
  const role = String(req.user.role || "").toLowerCase();
  if (role === "admin") return true;
  if (role === "courier") return requireCourierOrderAccess(order, req.user.id);
  if (role === "pharmacy") {
    const scope = await resolvePharmacyScope(req.user.id);
    return canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope });
  }
  return false;
};

const buildOtpMeta = (deliveryOtp) => {
  if (!deliveryOtp) return null;
  const expiresAt = deliveryOtp.expiresAt || null;
  const attempts = Number(deliveryOtp.attempts || 0);
  return {
    issuedAt: deliveryOtp.issuedAt || null,
    expiresAt,
    attempts,
    maxAttempts: OTP_MAX_ATTEMPTS,
    locked: attempts >= OTP_MAX_ATTEMPTS,
  };
};

const recordOtpDeliveryNotifications = (order, actorUserId, deliveryResult) => {
  const notifications = Array.isArray(order.dispatchNotifications) ? order.dispatchNotifications : [];
  const channels = Array.isArray(deliveryResult?.channels) ? deliveryResult.channels : [];
  for (const channelResult of channels) {
    notifications.push({
      id: `ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "otp_delivery",
      at: channelResult.at || nowIso(),
      actorUserId,
      recipientUserId: order.patientId || null,
      audience: "patient",
      channel: channelResult.channel || "unknown",
      status: channelResult.status || "failed",
      provider: channelResult.provider || null,
      error: channelResult.error || null,
      meta: {
        orderId: order.id,
        attemptsUsed: Number(channelResult.attemptsUsed || 1),
      },
    });
  }
  order.dispatchNotifications = notifications.slice(-300);
};

const recordCourierMessageNotifications = (order, actorUserId, deliveryResult, meta = {}) => {
  const notifications = Array.isArray(order.dispatchNotifications) ? order.dispatchNotifications : [];
  const channels = Array.isArray(deliveryResult?.channels) ? deliveryResult.channels : [];
  for (const channelResult of channels) {
    notifications.push({
      id: `ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "courier_message_delivery",
      at: channelResult.at || nowIso(),
      actorUserId,
      recipientUserId: order.patientId || null,
      audience: "patient",
      channel: channelResult.channel || "unknown",
      status: channelResult.status || "failed",
      provider: channelResult.provider || null,
      error: channelResult.error || null,
      meta: {
        orderId: order.id,
        strategy: deliveryResult?.strategy || "fanout",
        templateKey: meta.templateKey || null,
      },
    });
  }
  order.dispatchNotifications = notifications.slice(-350);
};

const getSlaMeta = (order) => {
  const status = normalizeDispatchStatus(order);
  const terminal = new Set(["delivered", "failed"]);
  const createdAt = toDate(order.createdAt) || new Date();
  const now = Date.now();
  const openMinutes = Math.max(0, Math.floor((now - createdAt.getTime()) / 60000));
  const breachAt = Number(process.env.DISPATCH_SLA_BREACH_MINUTES || 60);
  const riskAt = Number(process.env.DISPATCH_SLA_RISK_MINUTES || 30);
  const minutesToBreach = breachAt - openMinutes;
  const etaEndDate = toDate(order.dispatchEtaEnd);
  const etaOverdueMinutes =
    etaEndDate && !terminal.has(status) && now > etaEndDate.getTime()
      ? Math.floor((now - etaEndDate.getTime()) / 60000)
      : 0;
  return {
    openMinutes,
    riskAtMinutes: riskAt,
    breachAtMinutes: breachAt,
    atRisk: !terminal.has(status) && openMinutes >= riskAt && openMinutes < breachAt,
    breached: !terminal.has(status) && (openMinutes >= breachAt || etaOverdueMinutes > 0),
    minutesToBreach,
    etaOverdueMinutes,
  };
};

const inferZone = (order) => {
  const snap = order?.deliveryAddressSnapshot || {};
  return String(snap.zone || snap.parish || snap.city || "unassigned").trim().toLowerCase();
};

const getCourierZone = (courier) =>
  String(courier?.dispatchZone || courier?.serviceZone || "").trim().toLowerCase();
const getCourierAvailability = (courierOrId) => {
  const courierId = String(
    typeof courierOrId === "object" && courierOrId !== null ? courierOrId.id : courierOrId || ""
  ).trim();
  if (!courierId) return { online: true, updatedAt: null, updatedBy: null };
  const snapshot = courierAvailabilityState.get(courierId);
  if (!snapshot) return { online: true, updatedAt: null, updatedBy: null };
  return {
    online: snapshot.online !== false,
    updatedAt: snapshot.updatedAt || null,
    updatedBy: snapshot.updatedBy || null,
  };
};
const setCourierAvailability = ({ courierId, online, actorUserId = null }) => {
  const id = String(courierId || "").trim();
  if (!id) return null;
  const snapshot = {
    online: online !== false,
    updatedAt: nowIso(),
    updatedBy: actorUserId ? String(actorUserId) : null,
  };
  courierAvailabilityState.set(id, snapshot);
  return snapshot;
};
const upsertCourierHeartbeat = ({ courierId, lat, lng, actorUserId = null, source = "manual" }) => {
  const id = String(courierId || "").trim();
  const nLat = toNum(lat);
  const nLng = toNum(lng);
  if (!id || nLat === null || nLng === null) return null;
  const snapshot = {
    lat: nLat,
    lng: nLng,
    at: nowIso(),
    by: actorUserId ? String(actorUserId) : null,
    source: String(source || "manual").trim() || "manual",
  };
  courierHeartbeatState.set(id, snapshot);
  return snapshot;
};

router.get(
  "/queue",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const statusFilter = String(req.query.status || "").trim().toLowerCase();
    const search = String(req.query.search || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

    const allOrders = await Order.findAll({});
    const visible = allOrders.filter((order) =>
      canAccessOrder({
        order,
        role,
        userId: req.user.id,
        pharmacyScope: scope,
      })
    );

    const rows = [];
    for (const order of visible) {
      // eslint-disable-next-line no-await-in-loop
      const row = await buildOrderView(order);
      if (statusFilter && String(row.dispatchStatus || "").toLowerCase() !== statusFilter) continue;
      if (search) {
        const haystack = [row.id, row.patientName, row.pharmacyName, row.courierName, row.prescId]
          .map((value) => String(value || "").toLowerCase())
          .join(" ");
        if (!haystack.includes(search)) continue;
      }
      rows.push(row);
    }

    rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ orders: rows.slice(0, limit) });
  }
);

router.get("/my-jobs", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const allOrders = await Order.findAll({});
  const mine = allOrders.filter((order) => String(order.courierId || "") === String(req.user.id));
  const rows = [];
  for (const order of mine) {
    // eslint-disable-next-line no-await-in-loop
    const row = await buildOrderView(order);
    if (statusFilter && String(row.dispatchStatus || "").toLowerCase() !== statusFilter) continue;
    rows.push(row);
  }
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ orders: rows });
});

router.get("/courier-availability/me", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const snapshot = getCourierAvailability(req.user.id);
  return res.json({
    courierId: String(req.user.id || ""),
    online: snapshot.online !== false,
    updatedAt: snapshot.updatedAt || null,
    updatedBy: snapshot.updatedBy || null,
  });
});

router.post("/courier-availability/me", requireAuth, requireRoles(["courier"]), async (req, res) => {
  if (typeof req.body?.online !== "boolean") {
    return res.status(400).json({
      error: "online must be boolean",
      code: "COURIER_AVAILABILITY_INVALID",
    });
  }
  const snapshot = setCourierAvailability({
    courierId: req.user.id,
    online: req.body.online,
    actorUserId: req.user.id,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.courier.availability.update",
    entityType: "user",
    entityId: String(req.user.id || ""),
    metadata: {
      online: snapshot.online,
      updatedAt: snapshot.updatedAt,
    },
  });
  return res.json({
    courierId: String(req.user.id || ""),
    online: snapshot.online,
    updatedAt: snapshot.updatedAt,
    updatedBy: snapshot.updatedBy,
  });
});

// Allow ops (pharmacy / admin) to toggle courier availability on behalf of couriers
router.post(
  "/couriers/:courierId/availability",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const courierId = String(req.params.courierId || "").trim();
    if (!courierId) {
      return res.status(400).json({ error: "courierId is required", code: "COURIER_ID_REQUIRED" });
    }
    if (typeof req.body?.online !== "boolean") {
      return res.status(400).json({ error: "online must be boolean", code: "COURIER_AVAILABILITY_INVALID" });
    }
    const snapshot = setCourierAvailability({ courierId, online: req.body.online, actorUserId: req.user.id });
    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.courier.availability.update_by_ops",
      entityType: "user",
      entityId: String(courierId || ""),
      metadata: {
        online: snapshot.online,
        updatedAt: snapshot.updatedAt,
        updatedBy: snapshot.updatedBy,
      },
    });
    return res.json({ courierId: String(courierId || ""), online: snapshot.online, updatedAt: snapshot.updatedAt, updatedBy: snapshot.updatedBy });
  }
);

router.get("/message-templates", requireAuth, requireRoles(["courier"]), async (_req, res) => {
  return res.json({ templates: COURIER_MESSAGE_TEMPLATES });
});

router.get("/scorecard/my", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const allOrders = await Order.findAll({});
  const mine = allOrders.filter((order) => String(order.courierId || "") === String(req.user.id || ""));
  const todayKey = dayKeyUtc(nowIso());
  const todayOrders = mine.filter((order) => dayKeyUtc(order.dispatchAssignedAt || order.updatedAt || order.createdAt) === todayKey);
  const deliveredToday = todayOrders.filter((order) => normalizeDispatchStatus(order) === "delivered");
  const failedToday = todayOrders.filter((order) => normalizeDispatchStatus(order) === "failed");
  const onTimeDelivered = deliveredToday.filter((order) => {
    const etaEnd = toDate(order.dispatchEtaEnd);
    const deliveredAt = toDate(order.dispatchDeliveredAt);
    if (!deliveredAt) return false;
    if (!etaEnd) return true;
    return deliveredAt.getTime() <= etaEnd.getTime();
  }).length;
  const checklistCompleted = todayOrders.filter((order) => Boolean(order?.dispatchChecklist?.completed)).length;
  const completedOrFailed = deliveredToday.length + failedToday.length;
  const exceptionRate = percent(failedToday.length, Math.max(1, todayOrders.length));
  const scorecard = {
    day: todayKey,
    assigned: todayOrders.length,
    delivered: deliveredToday.length,
    failed: failedToday.length,
    onTimeRate: percent(onTimeDelivered, Math.max(1, deliveredToday.length)),
    completionRate: percent(deliveredToday.length, Math.max(1, completedOrFailed)),
    exceptionRate,
    checklistCompletionRate: percent(checklistCompleted, Math.max(1, todayOrders.length)),
  };
  const recentOrders = mine
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, 20);
  const prompts = buildCoachingPrompts({
    recentOrders,
    failed: failedToday.length,
    exceptionRate: scorecard.exceptionRate,
    checklistRate: scorecard.checklistCompletionRate,
  });
  return res.json({ scorecard, prompts });
});

router.post("/:id/checklist", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;
  const ack = req.body?.acknowledgements || {};
  const checklist = {
    readInstructions: ack.readInstructions === true,
    confirmedAddress: ack.confirmedAddress === true,
    confirmedRecipient: ack.confirmedRecipient === true,
    askedGateCode: ack.askedGateCode === true,
    note: String(ack.note || "").trim() || null,
    updatedAt: nowIso(),
    updatedBy: req.user.id,
  };
  checklist.completed = checklist.readInstructions && checklist.confirmedAddress && checklist.confirmedRecipient;
  order.dispatchChecklist = checklist;
  pushDispatchTimeline(order, "checklist_updated", req.user.id, { completed: checklist.completed });
  await order.save();
  return res.json({ order, checklist });
});

router.post("/:id/comm/session", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;
  const patient = order.patientId ? await User.findByPk(order.patientId) : null;
  const patientProfile = order.patientId ? await PatientProfile.findOne({ where: { userId: order.patientId } }) : null;
  const masked = {
    phone: maskPhone(order?.deliveryPreferences?.recipientPhone || patientProfile?.phone || ""),
    email: maskEmail(patient?.email || ""),
    chatHandle: `dispatch-${String(order.id || "").slice(0, 8)}`,
  };
  const session = {
    id: `com-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: nowIso(),
    createdBy: req.user.id,
    masked,
    channels: ["masked_call", "in_app_chat"],
  };
  order.dispatchCommSessions = [
    ...(Array.isArray(order.dispatchCommSessions) ? order.dispatchCommSessions : []),
    session,
  ].slice(-30);
  pushDispatchTimeline(order, "comm_session_started", req.user.id, { channels: session.channels });
  await order.save();
  return res.json({ order, session });
});

router.post("/:id/comm/message", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;
  const templateKey = String(req.body?.templateKey || "").trim();
  const customText = String(req.body?.customText || "").trim();
  const etaMinutes = Math.max(1, Math.min(180, Number(req.body?.etaMinutes || 10) || 10));
  let text = "";
  if (templateKey) {
    const template = COURIER_MESSAGE_TEMPLATES.find((entry) => entry.key === templateKey);
    if (!template) {
      return res.status(400).json({ error: "Invalid message template", code: "MESSAGE_TEMPLATE_INVALID" });
    }
    text = template.text.replace("{etaMinutes}", String(etaMinutes));
  } else if (customText) {
    text = customText;
  } else {
    return res.status(400).json({
      error: "templateKey or customText is required",
      code: "MESSAGE_CONTENT_REQUIRED",
    });
  }
  if (text.length > 280) {
    return res.status(400).json({ error: "Message too long (max 280 chars)", code: "MESSAGE_TOO_LONG" });
  }
  const messageEvent = {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    templateKey: templateKey || null,
    text,
    by: req.user.id,
    at: nowIso(),
    channel: "secure_dispatch_message",
  };
  const patient = order.patientId ? await User.findByPk(order.patientId) : null;
  const patientProfile = order.patientId ? await PatientProfile.findOne({ where: { userId: order.patientId } }) : null;
  const deliveryResult = await sendCourierMessageFanout({
    orderId: order.id,
    text,
    courierUserId: req.user.id,
    patientUser: patient,
    patientProfile,
    recipientPhone: order?.deliveryPreferences?.recipientPhone || "",
  });
  messageEvent.deliveries = deliveryResult;
  order.dispatchMessages = [
    ...(Array.isArray(order.dispatchMessages) ? order.dispatchMessages : []),
    messageEvent,
  ].slice(-60);
  order.dispatchMessageDeliveries = [
    ...(Array.isArray(order.dispatchMessageDeliveries) ? order.dispatchMessageDeliveries : []),
    {
      id: `msgdlv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: nowIso(),
      templateKey: templateKey || null,
      text,
      by: req.user.id,
      delivery: deliveryResult,
    },
  ].slice(-80);
  pushDispatchTimeline(order, "courier_message_sent", req.user.id, {
    templateKey: templateKey || "custom",
    deliveredChannels: deliveryResult.deliveredChannels || [],
  });
  pushNotificationEvents(order, "courier_message", req.user.id, {
    text,
    templateKey: templateKey || "custom",
    deliveredChannels: deliveryResult.deliveredChannels || [],
  });
  recordCourierMessageNotifications(order, req.user.id, deliveryResult, {
    templateKey: templateKey || "custom",
  });
  await order.save();
  return res.json({ order, message: messageEvent, delivery: deliveryResult });
});

router.get("/next-stops", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const limit = Math.max(1, Math.min(20, Number(req.query.limit || 8) || 8));
  const allOrders = await Order.findAll({});
  const active = allOrders.filter((order) =>
    String(order.courierId || "") === String(req.user.id || "")
    && ["assigned", "accepted", "picked_up", "arrived"].includes(normalizeDispatchStatus(order))
  );
  if (!active.length) {
    return res.json({
      generatedAt: nowIso(),
      courierLocation: null,
      stops: [],
    });
  }

  let courierLocation = null;
  for (const order of active) {
    const point = order.dispatchLastLocation || null;
    if (!point) continue;
    const pointAt = toDate(point.at || point.capturedAt || point.timestamp || null);
    if (!pointAt) continue;
    if (!courierLocation || pointAt.getTime() > courierLocation.atMs) {
      courierLocation = { lat: point.lat, lng: point.lng, at: pointAt.toISOString(), atMs: pointAt.getTime() };
    }
  }

  const scored = [];
  for (const order of active) {
    // eslint-disable-next-line no-await-in-loop
    const row = await buildOrderView(order);
    const destination = resolveOrderDestination(order);
    const from =
      courierLocation && Number.isFinite(Number(courierLocation.lat)) && Number.isFinite(Number(courierLocation.lng))
        ? { lat: Number(courierLocation.lat), lng: Number(courierLocation.lng) }
        : null;
    const to =
      destination && Number.isFinite(Number(destination.lat)) && Number.isFinite(Number(destination.lng))
        ? { lat: Number(destination.lat), lng: Number(destination.lng) }
        : null;
    const distanceMeters =
      from && to ? Math.round(haversineMeters(from, to)) : null;
    const etaMinutes = estimateTravelMinutes({ from, to });
    const sla = row.sla || getSlaMeta(order);
    let score = 0;
    if (sla.breached) score += 1000;
    if (sla.atRisk) score += 500;
    score += Math.max(0, Number(sla.etaOverdueMinutes || 0) * 10);
    if (Number.isFinite(Number(sla.minutesToBreach))) {
      score += Math.max(0, 120 - Number(sla.minutesToBreach));
    }
    if (Number.isFinite(Number(distanceMeters))) {
      score -= Math.round(Number(distanceMeters) / 250);
    }
    scored.push({
      ...row,
      distanceMeters,
      suggestedEtaMinutes: etaMinutes,
      navigationLinks: buildNavigationLinks({ destination: to, origin: from }),
      sequenceScore: score,
    });
  }

  scored.sort((a, b) => {
    const scoreDiff = Number(b.sequenceScore || 0) - Number(a.sequenceScore || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(a.distanceMeters || Number.MAX_SAFE_INTEGER) - Number(b.distanceMeters || Number.MAX_SAFE_INTEGER);
  });

  return res.json({
    generatedAt: nowIso(),
    courierLocation: courierLocation
      ? { lat: Number(courierLocation.lat), lng: Number(courierLocation.lng), at: courierLocation.at }
      : null,
    stops: scored.slice(0, limit).map((entry, index) => ({ ...entry, sequenceRank: index + 1 })),
  });
});

router.post("/courier/location", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const lat = toNum(req.body?.lat ?? req.body?.location?.lat);
  const lng = toNum(req.body?.lng ?? req.body?.location?.lng);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required", code: "LOCATION_REQUIRED" });
  }
  const point = upsertCourierHeartbeat({
    courierId: req.user.id,
    lat,
    lng,
    actorUserId: req.user.id,
    source: req.body?.source || "manual",
  });
  return res.json({
    courierId: String(req.user.id || ""),
    location: point,
  });
});

router.post("/:id/location", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  const lat = toNum(req.body?.lat ?? req.body?.location?.lat);
  const lng = toNum(req.body?.lng ?? req.body?.location?.lng);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: "lat and lng are required", code: "LOCATION_REQUIRED" });
  }

  const point = {
    lat,
    lng,
    at: nowIso(),
    by: req.user.id,
  };
  upsertCourierHeartbeat({
    courierId: req.user.id,
    lat,
    lng,
    actorUserId: req.user.id,
    source: "order_location",
  });
  order.dispatchLastLocation = point;
  const crumbs = Array.isArray(order.dispatchBreadcrumbs) ? order.dispatchBreadcrumbs : [];
  crumbs.push(point);
  order.dispatchBreadcrumbs = crumbs.slice(-180);
  pushDispatchTimeline(order, "location_update", req.user.id, { lat, lng });
  await order.save();

  return res.json({ order, location: point });
});

router.get(
  "/live-map",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const allOrders = await Order.findAll({});
    const activeStatuses = new Set(["assigned", "accepted", "picked_up", "arrived"]);
    const visible = allOrders.filter((order) =>
      canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })
    );

    const orders = [];
    for (const order of visible) {
      const status = normalizeDispatchStatus(order);
      if (!activeStatuses.has(status)) continue;
      // eslint-disable-next-line no-await-in-loop
      const row = await buildOrderView(order);
      const geofence = evaluateGeofence({
        order,
        location: order.dispatchLastLocation || null,
      });
      orders.push({
        ...row,
        destination: resolveOrderDestination(order),
        breadcrumbs: Array.isArray(order.dispatchBreadcrumbs) ? order.dispatchBreadcrumbs : [],
        courierPosition: order.dispatchLastLocation || null,
        geofence,
        routeDeviation: geofence.checked ? !geofence.withinRadius : null,
      });
    }
    return res.json({
      generatedAt: nowIso(),
      geofenceRadiusMeters: GEOFENCE_RADIUS_METERS,
      orders,
    });
  }
);

router.post(
  "/auto-dispatch",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const reason = String(req.body?.reason || "").trim();
    if (!reason || reason.length < 8) {
      return res.status(400).json({
        error: "Auto-dispatch requires a reason (min 8 chars)",
        code: "AUTO_DISPATCH_REASON_REQUIRED",
      });
    }

    const allOrders = await Order.findAll({});
    const queued = allOrders.filter((order) => {
      if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) return false;
      if (String(order.deliveryOption || "").toLowerCase() !== "delivery") return false;
      if (normalizeDispatchStatus(order) !== "queued") return false;
      return true;
    });
    if (!queued.length) return res.json({ assignments: [], reason, generatedAt: nowIso() });

    const users = await User.findAll({});
    const couriers = users.filter((user) => String(user.role || "").toLowerCase() === "courier");
    if (!couriers.length) {
      return res.status(409).json({ error: "No courier users available", code: "NO_COURIERS_AVAILABLE" });
    }
    const onlineCouriers = couriers.filter((courier) => getCourierAvailability(courier).online !== false);
    if (!onlineCouriers.length) {
      return res.status(409).json({ error: "No online courier users available", code: "NO_COURIERS_ONLINE" });
    }

    const loadByCourierId = new Map(onlineCouriers.map((courier) => [String(courier.id), 0]));
    for (const order of allOrders) {
      const dispatchStatus = normalizeDispatchStatus(order);
      if (!["assigned", "accepted", "picked_up", "arrived"].includes(dispatchStatus)) continue;
      if (order.courierId && loadByCourierId.has(String(order.courierId))) {
        loadByCourierId.set(
          String(order.courierId),
          Number(loadByCourierId.get(String(order.courierId)) || 0) + 1
        );
      }
    }

    const rankedOrders = [...queued].sort((a, b) => {
      const as = getSlaMeta(a);
      const bs = getSlaMeta(b);
      if (as.breached !== bs.breached) return as.breached ? -1 : 1;
      if (as.atRisk !== bs.atRisk) return as.atRisk ? -1 : 1;
      return bs.openMinutes - as.openMinutes;
    });

    const assignments = [];
    for (const order of rankedOrders) {
      const zone = inferZone(order);
      const preferred = onlineCouriers.filter((courier) => {
        const cz = getCourierZone(courier);
        if (!zone || zone === "unassigned") return true;
        return cz && cz === zone;
      });
      const pool = preferred.length ? preferred : onlineCouriers;
      const picked = [...pool].sort((a, b) => {
        const aLoad = Number(loadByCourierId.get(String(a.id)) || 0);
        const bLoad = Number(loadByCourierId.get(String(b.id)) || 0);
        if (aLoad !== bLoad) return aLoad - bLoad;
        return String(a.fullName || "").localeCompare(String(b.fullName || ""));
      })[0];
      if (!picked) continue;

      order.courierId = picked.id;
      order.dispatchStatus = "assigned";
      order.dispatchAssignedAt = nowIso();
      order.dispatchPriority = order.dispatchPriority || "normal";
      applyOrderStatusMirror(order);
      pushDispatchTimeline(order, "auto_assigned", req.user.id, {
        reason,
        zone,
        courierId: picked.id,
      });
      pushNotificationEvents(order, "assigned", req.user.id, {
        courierId: picked.id,
        source: "auto_dispatch",
        reason,
      });
      await order.save();
      loadByCourierId.set(String(picked.id), Number(loadByCourierId.get(String(picked.id)) || 0) + 1);

      assignments.push({
        orderId: order.id,
        courierId: picked.id,
        courierName: picked.fullName || null,
        zone,
      });
    }

    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.auto_dispatch.run",
      entityType: "dispatch_batch",
      entityId: `auto-${Date.now().toString(36)}`,
      metadata: {
        reason,
        assignmentCount: assignments.length,
      },
    });
    return res.json({ assignments, reason, generatedAt: nowIso() });
  }
);

router.get(
  "/courier-workload",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const allOrders = await Order.findAll({});
    const visible = allOrders.filter((order) =>
      canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })
    );

    const users = await User.findAll({});
    const couriers = users.filter((user) => String(user.role || "").toLowerCase() === "courier");
    const workload = new Map(
      couriers.map((courier) => [
        String(courier.id),
        {
          courierId: courier.id,
          courierName: courier.fullName || null,
          zone: getCourierZone(courier) || null,
          activeJobs: 0,
          overdueJobs: 0,
          assignedTotal: 0,
          lastAssignedAt: null,
        },
      ])
    );

    for (const order of visible) {
      const courierId = String(order.courierId || "").trim();
      if (!courierId || !workload.has(courierId)) continue;
      const row = workload.get(courierId);
      row.assignedTotal += 1;
      const assignedAt = toDate(order.dispatchAssignedAt || order.updatedAt || order.createdAt);
      if (assignedAt && (!row.lastAssignedAt || assignedAt.getTime() > new Date(row.lastAssignedAt).getTime())) {
        row.lastAssignedAt = assignedAt.toISOString();
      }
      const status = normalizeDispatchStatus(order);
      const active = ["assigned", "accepted", "picked_up", "arrived"].includes(status);
      if (!active) continue;
      row.activeJobs += 1;
      const sla = getSlaMeta(order);
      if (sla.breached || Number(sla.etaOverdueMinutes || 0) > 0) {
        row.overdueJobs += 1;
      }
    }

    const rows = Array.from(workload.values())
      .map((entry) => ({
        ...entry,
        online: getCourierAvailability(entry.courierId).online !== false,
        loadBand:
          getCourierAvailability(entry.courierId).online === false
            ? "offline"
            : entry.activeJobs >= 8
              ? "critical"
              : entry.activeJobs >= 5
                ? "high"
                : entry.activeJobs >= 3
                  ? "medium"
                  : entry.activeJobs >= 1
                    ? "low"
                    : "idle",
      }))
      .sort((a, b) => {
        if (b.overdueJobs !== a.overdueJobs) return b.overdueJobs - a.overdueJobs;
        if (b.activeJobs !== a.activeJobs) return b.activeJobs - a.activeJobs;
        return String(a.courierName || "").localeCompare(String(b.courierName || ""));
      });

    return res.json({
      generatedAt: nowIso(),
      summary: {
        couriers: rows.length,
        activeJobs: rows.reduce((sum, row) => sum + Number(row.activeJobs || 0), 0),
        overdueJobs: rows.reduce((sum, row) => sum + Number(row.overdueJobs || 0), 0),
      },
      couriers: rows,
    });
  }
);

router.get(
  "/couriers/:courierId/location",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const courierId = String(req.params.courierId || "").trim();
    if (!courierId) {
      return res.status(400).json({ error: "courierId is required", code: "COURIER_ID_REQUIRED" });
    }

    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const allOrders = await Order.findAll({});
    const visible = allOrders.filter((order) =>
      canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })
      && String(order.courierId || "").trim() === courierId
    );

    let latest = null;
    for (const order of visible) {
      const point = order.dispatchLastLocation || null;
      if (!point) continue;
      const lat = toNum(point.lat ?? point.latitude);
      const lng = toNum(point.lng ?? point.longitude);
      if (lat === null || lng === null) continue;
      const atIso = String(point.at || order.updatedAt || order.createdAt || "").trim();
      const atMs = new Date(atIso || 0).getTime() || 0;
      if (!latest || atMs >= latest.atMs) {
        latest = {
          courierId,
          orderId: String(order.id || ""),
          location: {
            lat,
            lng,
            at: atIso || null,
            accuracyMeters: toNum(point.accuracyMeters ?? point.accuracy) ?? null,
          },
          atMs,
        };
      }
    }

    const heartbeat = courierHeartbeatState.get(courierId) || null;
    if (heartbeat) {
      const hbLat = toNum(heartbeat.lat);
      const hbLng = toNum(heartbeat.lng);
      const hbAtIso = String(heartbeat.at || "").trim();
      const hbAtMs = new Date(hbAtIso || 0).getTime() || 0;
      if (hbLat !== null && hbLng !== null) {
        if (!latest || hbAtMs >= Number(latest.atMs || 0)) {
          latest = {
            courierId,
            orderId: latest?.orderId || null,
            location: {
              lat: hbLat,
              lng: hbLng,
              at: hbAtIso || null,
              accuracyMeters: null,
              source: heartbeat.source || "heartbeat",
            },
            atMs: hbAtMs,
          };
        }
      }
    }

    if (!latest) {
      return res.json({
        courierId,
        found: false,
        location: null,
      });
    }

    return res.json({
      courierId: latest.courierId,
      orderId: latest.orderId,
      found: true,
      location: latest.location,
    });
  }
);

router.get(
  "/sla-cockpit",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const allOrders = await Order.findAll({});
    const active = allOrders.filter((order) => {
      if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) return false;
      const status = normalizeDispatchStatus(order);
      return ["queued", "assigned", "accepted", "picked_up", "arrived"].includes(status);
    });

    const breaches = [];
    const atRisk = [];
    for (const order of active) {
      // eslint-disable-next-line no-await-in-loop
      const row = await buildOrderView(order);
      const sla = getSlaMeta(order);
      const payload = { ...row, sla };
      if (sla.breached) breaches.push(payload);
      else if (sla.atRisk) atRisk.push(payload);
    }
    breaches.sort((a, b) => Number(b.sla.openMinutes || 0) - Number(a.sla.openMinutes || 0));
    atRisk.sort((a, b) => Number(b.sla.openMinutes || 0) - Number(a.sla.openMinutes || 0));

    return res.json({
      generatedAt: nowIso(),
      summary: {
        active: active.length,
        breached: breaches.length,
        atRisk: atRisk.length,
      },
      breaches: breaches.slice(0, 120),
      atRisk: atRisk.slice(0, 120),
    });
  }
);

router.post(
  "/:id/escalate",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
    if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) {
      return res.status(403).json({ error: "Forbidden order scope", code: "FORBIDDEN_ORDER_SCOPE" });
    }
    const reason = String(req.body?.reason || "").trim();
    if (!reason || reason.length < 8) {
      return res.status(400).json({
        error: "Escalation reason is required (min 8 chars)",
        code: "ESCALATION_REASON_REQUIRED",
      });
    }

    order.dispatchPriority = "high";
    order.dispatchEscalated = true;
    order.dispatchEscalatedAt = nowIso();
    order.dispatchEscalationReason = reason;
    order.dispatchEscalations = [
      ...(Array.isArray(order.dispatchEscalations) ? order.dispatchEscalations : []),
      {
        id: `esc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: nowIso(),
        by: req.user.id,
        reason,
      },
    ].slice(-80);
    pushDispatchTimeline(order, "escalated", req.user.id, { reason });
    await order.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.order.escalate",
      entityType: "order",
      entityId: order.id,
      metadata: { reason },
    });
    return res.json({ order });
  }
);

router.get(
  "/exceptions",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const allOrders = await Order.findAll({});
    const visible = allOrders.filter((order) =>
      canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })
    );

    const rows = [];
    for (const order of visible) {
      const dispatchStatus = normalizeDispatchStatus(order);
      const timeline = Array.isArray(order.dispatchTimeline) ? order.dispatchTimeline : [];
      const otpFailures = timeline.filter((event) => event?.type === "otp_failed").length;
      if (
        dispatchStatus === "failed" ||
        Boolean(order.dispatchFailureReason) ||
        otpFailures > 0
      ) {
        // eslint-disable-next-line no-await-in-loop
        const row = await buildOrderView(order);
        rows.push({
          ...row,
          otpFailures,
          latestExceptionAt:
            timeline
              .filter((event) => ["failed", "otp_failed"].includes(String(event?.type || "").toLowerCase()))
              .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0]?.at || row.updatedAt || row.createdAt,
        });
      }
    }

    rows.sort((a, b) => new Date(b.latestExceptionAt || 0) - new Date(a.latestExceptionAt || 0));
    return res.json({ exceptions: rows.slice(0, 120) });
  }
);

router.post("/assign", requireAuth, requireRoles(["pharmacy", "admin"]), async (req, res) => {
  const { orderId, courierId } = req.body || {};
  const order = await Order.findByPk(orderId);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "assign", mutationKey)) {
    return res.json({ order, idempotent: true });
  }

  if (String(order.deliveryOption || "").toLowerCase() !== "delivery") {
    return res.status(409).json({ error: "Order is not a delivery order", code: "ORDER_NOT_DISPATCHABLE" });
  }

  const role = String(req.user.role || "").toLowerCase();
  if (role === "pharmacy") {
    const scope = await resolvePharmacyScope(req.user.id);
    if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) {
      return res.status(403).json({ error: "Forbidden order scope", code: "FORBIDDEN_ORDER_SCOPE" });
    }
  }

  const courier = await User.findByPk(courierId);
  if (!courier || String(courier.role || "").toLowerCase() !== "courier") {
    return res.status(400).json({ error: "Invalid courierId", code: "COURIER_NOT_FOUND" });
  }
  if (getCourierAvailability(courier).online === false) {
    return res.status(409).json({
      error: "Selected courier is offline and cannot receive assignments",
      code: "COURIER_OFFLINE",
    });
  }

  const current = normalizeDispatchStatus(order);
  const next = "assigned";
  const transition = validateDispatchTransition({ current, next });
  if (!transition.ok && !(current === "assigned" && String(order.courierId || "") === String(courierId || ""))) {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  order.dispatchStatus = next;
  order.courierId = courierId;
  order.dispatchPriority = String(req.body?.priority || order.dispatchPriority || "normal").toLowerCase();
  order.dispatchAssignedAt = nowIso();
  if (req.body?.etaStart) order.dispatchEtaStart = req.body.etaStart;
  if (req.body?.etaEnd) order.dispatchEtaEnd = req.body.etaEnd;
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "assigned", req.user.id, {
    courierId,
    priority: order.dispatchPriority || "normal",
  });
  pushNotificationEvents(order, "assigned", req.user.id, {
    courierId,
    etaStart: order.dispatchEtaStart || null,
    etaEnd: order.dispatchEtaEnd || null,
  });
  setDispatchMutation(order, "assign", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.assign",
    entityType: "order",
    entityId: order.id,
    metadata: { courierId },
  });

  return res.json({ order });
});

router.post(
  "/batch-action",
  requireAuth,
  requireRoles(["pharmacy", "admin"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const action = String(req.body?.action || "").trim().toLowerCase();
    const reason = String(req.body?.reason || "").trim();
    const orderIds = Array.isArray(req.body?.orderIds)
      ? req.body.orderIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    if (!orderIds.length) {
      return res.status(400).json({ error: "orderIds is required", code: "BATCH_ORDER_IDS_REQUIRED" });
    }
    if (!reason || reason.length < 8) {
      return res.status(400).json({
        error: "Batch action reason is required (min 8 chars)",
        code: "BATCH_REASON_REQUIRED",
      });
    }
    if (!["assign", "escalate", "set_priority"].includes(action)) {
      return res.status(400).json({ error: "Unsupported batch action", code: "BATCH_ACTION_INVALID" });
    }

    const uniqueOrderIds = Array.from(new Set(orderIds)).slice(0, 120);
    const courierId = String(req.body?.courierId || "").trim();
    const nextPriority = String(req.body?.priority || "").trim().toLowerCase();
    if (action === "assign") {
      if (!courierId) {
        return res.status(400).json({
          error: "courierId is required for assign batch action",
          code: "BATCH_COURIER_REQUIRED",
        });
      }
      const courier = await User.findByPk(courierId);
      if (!courier || String(courier.role || "").toLowerCase() !== "courier") {
        return res.status(400).json({ error: "Invalid courierId", code: "COURIER_NOT_FOUND" });
      }
      if (getCourierAvailability(courier).online === false) {
        return res.status(409).json({
          error: "Selected courier is offline and cannot receive assignments",
          code: "COURIER_OFFLINE",
        });
      }
    }
    if (action === "set_priority" && !["low", "normal", "high", "urgent"].includes(nextPriority)) {
      return res.status(400).json({
        error: "priority must be one of low, normal, high, urgent",
        code: "BATCH_PRIORITY_INVALID",
      });
    }

    const results = [];
    for (const orderId of uniqueOrderIds) {
      // eslint-disable-next-line no-await-in-loop
      const order = await Order.findByPk(orderId);
      if (!order) {
        results.push({ orderId, ok: false, code: "ORDER_NOT_FOUND", error: "Order not found" });
        continue;
      }
      if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) {
        results.push({ orderId, ok: false, code: "FORBIDDEN_ORDER_SCOPE", error: "Forbidden order scope" });
        continue;
      }
      if (String(order.deliveryOption || "").toLowerCase() !== "delivery") {
        results.push({ orderId, ok: false, code: "ORDER_NOT_DISPATCHABLE", error: "Order is not a delivery order" });
        continue;
      }

      try {
        if (action === "assign") {
          const current = normalizeDispatchStatus(order);
          const transition = validateDispatchTransition({ current, next: "assigned" });
          if (!transition.ok && !(current === "assigned" && String(order.courierId || "") === courierId)) {
            results.push({ orderId, ok: false, code: transition.code, error: transition.error });
            continue;
          }
          order.dispatchStatus = "assigned";
          order.courierId = courierId;
          order.dispatchAssignedAt = nowIso();
          applyOrderStatusMirror(order);
          pushDispatchTimeline(order, "batch_assigned", req.user.id, { reason, courierId });
          pushNotificationEvents(order, "assigned", req.user.id, {
            courierId,
            source: "batch_action",
            reason,
          });
        } else if (action === "escalate") {
          order.dispatchPriority = "high";
          order.dispatchEscalated = true;
          order.dispatchEscalatedAt = nowIso();
          order.dispatchEscalationReason = reason;
          order.dispatchEscalations = [
            ...(Array.isArray(order.dispatchEscalations) ? order.dispatchEscalations : []),
            {
              id: `esc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              at: nowIso(),
              by: req.user.id,
              reason,
              source: "batch_action",
            },
          ].slice(-80);
          pushDispatchTimeline(order, "batch_escalated", req.user.id, { reason });
          pushNotificationEvents(order, "escalated", req.user.id, { reason, source: "batch_action" });
        } else if (action === "set_priority") {
          order.dispatchPriority = nextPriority;
          pushDispatchTimeline(order, "batch_priority_updated", req.user.id, {
            reason,
            priority: nextPriority,
          });
          pushNotificationEvents(order, "priority_updated", req.user.id, {
            reason,
            priority: nextPriority,
            source: "batch_action",
          });
        }
        // eslint-disable-next-line no-await-in-loop
        await order.save();
        results.push({ orderId, ok: true });
      } catch (err) {
        results.push({ orderId, ok: false, code: "BATCH_ITEM_ERROR", error: err.message });
      }
    }

    const success = results.filter((entry) => entry.ok).length;
    const failed = results.length - success;
    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.batch_action.run",
      entityType: "dispatch_batch",
      entityId: `batch-${Date.now().toString(36)}`,
      metadata: {
        action,
        reason,
        success,
        failed,
      },
    });
    return res.json({
      action,
      reason,
      total: results.length,
      success,
      failed,
      results,
    });
  }
);

router.post(
  "/:id/otp/issue",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
    const mutationKey = getMutationKey(req);
    if (isSameDispatchMutation(order, "otp_issue", mutationKey)) {
      return res.json({
        order,
        otpMeta: buildOtpMeta(order.deliveryOtp),
        otpDelivery: order.dispatchOtpLastDelivery || null,
        idempotent: true,
      });
    }

    if (!(await canIssueOtpForOrder({ req, order }))) {
      return res.status(403).json({ error: "Forbidden order scope", code: "FORBIDDEN_ORDER_SCOPE" });
    }

    if (String(order.deliveryOption || "").toLowerCase() !== "delivery") {
      return res.status(409).json({ error: "Order is not a delivery order", code: "ORDER_NOT_DISPATCHABLE" });
    }

    const otp = randomOtp();
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
    const otpHash = hashOtp(otp);
    const otpQrToken = generateOtpQrToken({ orderId: order.id, otpHash, expiresAt });
    order.deliveryOtp = {
      hash: otpHash,
      issuedAt,
      expiresAt,
      attempts: 0,
      issuedBy: req.user.id,
      consumedAt: null,
      qrToken: otpQrToken,
      qrIssuedAt: issuedAt,
      patientCodeCipher: encryptValue(otp),
    };
    pushDispatchTimeline(order, "otp_issued", req.user.id, {
      expiresAt,
      ttlMinutes: OTP_TTL_MINUTES,
    });

    const patientUser = order.patientId ? await User.findByPk(order.patientId) : null;
    const patientProfile = order.patientId
      ? await PatientProfile.findOne({ where: { userId: order.patientId } })
      : null;
    const otpDeliveryResult = await sendDispatchOtpWithFallback({
      orderId: order.id,
      otp,
      expiresAt,
      patientUser,
      patientProfile,
    });
    order.dispatchOtpDeliveries = [
      ...(Array.isArray(order.dispatchOtpDeliveries) ? order.dispatchOtpDeliveries : []),
      otpDeliveryResult,
    ].slice(-50);
    order.dispatchOtpLastDelivery = otpDeliveryResult;
    recordOtpDeliveryNotifications(order, req.user.id, otpDeliveryResult);
    pushDispatchTimeline(order, "otp_delivery_attempt", req.user.id, {
      success: Boolean(otpDeliveryResult.success),
      deliveredVia: otpDeliveryResult.deliveredVia || null,
      attemptedAt: otpDeliveryResult.attemptedAt || nowIso(),
    });
    setDispatchMutation(order, "otp_issue", mutationKey, req.user.id);
    await order.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.order.otp_issue",
      entityType: "order",
      entityId: order.id,
      metadata: {
        expiresAt,
        ttlMinutes: OTP_TTL_MINUTES,
        otpDeliverySuccess: Boolean(otpDeliveryResult.success),
        otpDeliveryChannel: otpDeliveryResult.deliveredVia || null,
        otpQrEnabled: true,
      },
    });

    const includeOtpDebug =
      String(process.env.DISPATCH_RETURN_OTP_IN_RESPONSE || "false").toLowerCase() === "true"
      && String(req.user?.role || "").toLowerCase() === "admin";

    return res.json({
      order,
      otpMeta: buildOtpMeta(order.deliveryOtp),
      otpDelivery: order.dispatchOtpLastDelivery || null,
      otpQrToken,
      otp: includeOtpDebug ? otp : undefined,
    });
  }
);

router.post("/:id/accept", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "accept", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  if (!order.courierId) order.courierId = req.user.id;
  const current = normalizeDispatchStatus(order);
  const transition = validateDispatchTransition({ current, next: "accepted" });
  if (!transition.ok && current !== "accepted") {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  order.dispatchStatus = "accepted";
  order.dispatchAcceptedAt = nowIso();
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "accepted", req.user.id);
  setDispatchMutation(order, "accept", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.accept",
    entityType: "order",
    entityId: order.id,
  });

  return res.json({ order });
});

router.post("/:id/pickup", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "pickup", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  if (!order.courierId) order.courierId = req.user.id;
  const current = normalizeDispatchStatus(order);
  const transition = validateDispatchTransition({ current, next: "picked_up" });
  if (!transition.ok && current !== "picked_up") {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  order.dispatchStatus = "picked_up";
  order.dispatchPickedUpAt = nowIso();
  if (req.body?.location) {
    order.dispatchLastLocation = {
      lat: req.body.location.lat,
      lng: req.body.location.lng,
      at: nowIso(),
    };
  }
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "picked_up", req.user.id, {
    pickupNote: String(req.body?.pickupNote || "").trim() || null,
  });
  setDispatchMutation(order, "pickup", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.pickup",
    entityType: "order",
    entityId: order.id,
  });

  return res.json({ order });
});

router.post("/:id/arrived", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "arrived", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  if (!order.courierId) order.courierId = req.user.id;
  const current = normalizeDispatchStatus(order);
  const transition = validateDispatchTransition({ current, next: "arrived" });
  if (!transition.ok && current !== "arrived") {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  const geofence = evaluateGeofence({
    order,
    location: req.body?.location || order.dispatchLastLocation || null,
  });
  if (geofence.checked && !geofence.withinRadius) {
    const enforced = isTruthy(process.env.DISPATCH_GEOFENCE_ENFORCE);
    const geofenceMeta = {
      ...geofence,
      enforced,
      action: "arrived",
    };
    order.lastGeofenceCheck = geofenceMeta;
    pushDispatchTimeline(order, "geofence_warning", req.user.id, geofenceMeta);
    if (enforced) {
      await order.save();
      return res.status(409).json({
        error: "Courier is outside delivery geofence radius",
        code: "GEOFENCE_VIOLATION",
        geofence: geofenceMeta,
      });
    }
  } else if (geofence.checked) {
    order.lastGeofenceCheck = {
      ...geofence,
      enforced: isTruthy(process.env.DISPATCH_GEOFENCE_ENFORCE),
      action: "arrived",
    };
  }
  order.dispatchStatus = "arrived";
  order.dispatchArrivedAt = nowIso();
  if (req.body?.location) {
    order.dispatchLastLocation = {
      lat: req.body.location.lat,
      lng: req.body.location.lng,
      at: nowIso(),
    };
  }
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "arrived", req.user.id, {
    note: String(req.body?.note || "").trim() || null,
  });
  pushNotificationEvents(order, "arrived", req.user.id, {
    geofenceChecked: Boolean(geofence.checked),
    geofenceWithinRadius: geofence.checked ? Boolean(geofence.withinRadius) : null,
  });
  setDispatchMutation(order, "arrived", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.arrived",
    entityType: "order",
    entityId: order.id,
  });

  return res.json({ order, geofence: order.lastGeofenceCheck || null });
});

router.post("/:id/eta", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "eta", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;

  const etaStart = String(req.body?.etaStart || "").trim();
  const etaEnd = String(req.body?.etaEnd || "").trim();
  if (!etaStart && !etaEnd) {
    return res.status(400).json({ error: "etaStart or etaEnd is required", code: "ETA_REQUIRED" });
  }

  if (etaStart) order.dispatchEtaStart = etaStart;
  if (etaEnd) order.dispatchEtaEnd = etaEnd;
  pushDispatchTimeline(order, "eta_updated", req.user.id, {
    etaStart: order.dispatchEtaStart || null,
    etaEnd: order.dispatchEtaEnd || null,
  });
  pushNotificationEvents(order, "eta_updated", req.user.id, {
    etaStart: order.dispatchEtaStart || null,
    etaEnd: order.dispatchEtaEnd || null,
  });
  setDispatchMutation(order, "eta", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.eta",
    entityType: "order",
    entityId: order.id,
    metadata: { etaStart: order.dispatchEtaStart || null, etaEnd: order.dispatchEtaEnd || null },
  });

  return res.json({ order });
});

router.post("/:id/reroute", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;

  const destination = resolveOrderDestination(order);
  const fallback = order.dispatchLastLocation || null;
  const fromLat = toNum(req.body?.location?.lat ?? req.body?.lat ?? fallback?.lat);
  const fromLng = toNum(req.body?.location?.lng ?? req.body?.lng ?? fallback?.lng);
  if (!destination || fromLat === null || fromLng === null) {
    return res.status(409).json({
      error: "Current courier location and destination coordinates are required for reroute",
      code: "REROUTE_COORDINATES_REQUIRED",
    });
  }

  const from = { lat: fromLat, lng: fromLng };
  const to = { lat: Number(destination.lat), lng: Number(destination.lng) };
  const distanceMeters = Math.round(haversineMeters(from, to));
  const etaMinutes = estimateTravelMinutes({ from, to }) || 15;
  const startAt = new Date(Date.now() + 2 * 60 * 1000);
  const endAt = new Date(Date.now() + (etaMinutes + 8) * 60 * 1000);
  order.dispatchEtaStart = startAt.toISOString();
  order.dispatchEtaEnd = endAt.toISOString();
  order.dispatchLastLocation = {
    lat: from.lat,
    lng: from.lng,
    at: nowIso(),
    by: req.user.id,
  };
  const sla = getSlaMeta(order);
  const rerouteReason = sla.breached
    ? "SLA breach detected"
    : sla.atRisk
      ? "SLA risk detected"
      : "Route refresh requested";
  const navigation = buildNavigationLinks({ destination: to, origin: from });
  pushDispatchTimeline(order, "reroute_applied", req.user.id, {
    reason: rerouteReason,
    distanceMeters,
    etaMinutes,
    etaStart: order.dispatchEtaStart,
    etaEnd: order.dispatchEtaEnd,
  });
  pushNotificationEvents(order, "eta_updated", req.user.id, {
    source: "reroute",
    etaStart: order.dispatchEtaStart,
    etaEnd: order.dispatchEtaEnd,
    reason: rerouteReason,
  });
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.reroute",
    entityType: "order",
    entityId: order.id,
    metadata: {
      reason: rerouteReason,
      distanceMeters,
      etaMinutes,
      etaStart: order.dispatchEtaStart,
      etaEnd: order.dispatchEtaEnd,
    },
  });

  return res.json({
    order,
    reroute: {
      reason: rerouteReason,
      distanceMeters,
      etaMinutes,
      navigation,
    },
  });
});

router.post("/:id/pod", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "pod", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  if (!order.courierId) order.courierId = req.user.id;
  const current = normalizeDispatchStatus(order);
  const transition = validateDispatchTransition({ current, next: "delivered" });
  if (!transition.ok && current !== "delivered") {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  const geofence = evaluateGeofence({
    order,
    location: req.body?.location || order.dispatchLastLocation || null,
  });
  if (geofence.checked && !geofence.withinRadius) {
    const enforced = isTruthy(process.env.DISPATCH_GEOFENCE_ENFORCE);
    const geofenceMeta = {
      ...geofence,
      enforced,
      action: "pod",
    };
    order.lastGeofenceCheck = geofenceMeta;
    pushDispatchTimeline(order, "geofence_warning", req.user.id, geofenceMeta);
    if (enforced) {
      await order.save();
      return res.status(409).json({
        error: "Courier is outside delivery geofence radius",
        code: "GEOFENCE_VIOLATION",
        geofence: geofenceMeta,
      });
    }
  } else if (geofence.checked) {
    order.lastGeofenceCheck = {
      ...geofence,
      enforced: isTruthy(process.env.DISPATCH_GEOFENCE_ENFORCE),
      action: "pod",
    };
  }

  const method = String(req.body?.method || "unknown").trim().toLowerCase();
  const methodParts = method.split(/[_+]/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const requiresOtp = method === "otp" || methodParts.includes("otp");
  const usesOtpQr = methodParts.includes("qr");
  const requiresPhoto = methodParts.includes("photo");
  const requiresSignature = methodParts.includes("signature");
  const capturedMedia = req.body?.capturedMedia || {};
  const photoCapture = normalizeCapturedMedia(capturedMedia.photoData || "");
  const signatureCapture = normalizeCapturedMedia(capturedMedia.signatureData || "");
  const captureSource = String(req.body?.captureSource || "").trim().toLowerCase();
  const genericProof = String(req.body?.proof || "").trim();
  const identityChecklistRaw = req.body?.identityChecklist || {};
  const identityChecklist = {
    confirmRecipientName: identityChecklistRaw.confirmRecipientName === true,
    confirmAddress: identityChecklistRaw.confirmAddress === true,
    confirmOrderId: identityChecklistRaw.confirmOrderId === true,
    note: String(identityChecklistRaw.note || "").trim() || null,
  };
  const identityChecklistComplete =
    identityChecklist.confirmRecipientName
    && identityChecklist.confirmAddress
    && identityChecklist.confirmOrderId;
  if (REQUIRE_IDENTITY_CHECKLIST && !identityChecklistComplete) {
    return res.status(409).json({
      error: "Identity checklist must be completed before proof of delivery",
      code: "IDENTITY_CHECKLIST_REQUIRED",
    });
  }
  if ((requiresPhoto || requiresSignature) && captureSource !== "device_capture") {
    return res.status(400).json({
      error: "POD evidence must be captured directly in courier console",
      code: "POD_CAPTURE_SOURCE_REQUIRED",
    });
  }
  if (requiresPhoto && !photoCapture) {
    return res.status(400).json({
      error: "Photo evidence capture is required for selected POD method",
      code: "POD_PHOTO_CAPTURE_REQUIRED",
    });
  }
  if (requiresSignature && !signatureCapture) {
    return res.status(400).json({
      error: "Signature capture is required for selected POD method",
      code: "POD_SIGNATURE_CAPTURE_REQUIRED",
    });
  }

  if (requiresOtp) {
    const otpState = order.deliveryOtp || null;
    if (!otpState?.hash || !otpState?.expiresAt) {
      return res.status(409).json({ error: "Delivery OTP not issued", code: "OTP_NOT_ISSUED" });
    }
    const attempts = Number(otpState.attempts || 0);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ error: "OTP locked due to too many attempts", code: "OTP_LOCKED" });
    }
    const expiresAt = toDate(otpState.expiresAt);
    if (!expiresAt || Date.now() > expiresAt.getTime()) {
      return res.status(409).json({ error: "OTP expired", code: "OTP_EXPIRED" });
    }
    let otpValidated = false;
    if (usesOtpQr) {
      const qrToken = String(req.body?.otpQrToken || genericProof || "").trim();
      const verification = verifyOtpQrToken({ token: qrToken, order });
      if (!verification.ok) {
        otpState.attempts = attempts + 1;
        order.deliveryOtp = otpState;
        pushDispatchTimeline(order, "otp_failed", req.user.id, {
          attempts: otpState.attempts,
          maxAttempts: OTP_MAX_ATTEMPTS,
          reason: verification.code || "OTP_QR_INVALID",
        });
        await order.save();
        return res.status(409).json({ error: verification.error, code: verification.code || "OTP_QR_INVALID" });
      }
      otpValidated = true;
    } else {
      const providedOtp = String(req.body?.otp || genericProof || "").trim();
      if (!providedOtp) {
        return res.status(400).json({ error: "OTP proof is required", code: "OTP_REQUIRED" });
      }
      const providedHash = hashOtp(providedOtp);
      if (providedHash !== String(otpState.hash || "")) {
        otpState.attempts = attempts + 1;
        order.deliveryOtp = otpState;
        pushDispatchTimeline(order, "otp_failed", req.user.id, {
          attempts: otpState.attempts,
          maxAttempts: OTP_MAX_ATTEMPTS,
        });
        await order.save();
        return res.status(409).json({ error: "OTP invalid", code: "OTP_INVALID" });
      }
      otpValidated = true;
    }
    if (otpValidated) {
      otpState.consumedAt = nowIso();
      otpState.attempts = attempts;
      order.deliveryOtp = otpState;
    }
  }

  const podLocation = resolvePodLocation({ body: req.body, order });
  if (!podLocation) {
    return res.status(400).json({
      error: "POD location coordinates are required",
      code: "POD_LOCATION_REQUIRED",
    });
  }
  order.dispatchLastLocation = {
    lat: podLocation.lat,
    lng: podLocation.lng,
    at: podLocation.capturedAt,
    accuracyMeters: podLocation.accuracyMeters,
    by: req.user.id,
  };

  const recordedAt = nowIso();
  const proofReference = !requiresOtp ? genericProof : "";
  const podHashPayload = {
    orderId: order.id,
    patientId: order.patientId || null,
    courierId: req.user.id,
    method,
    otpVerified: Boolean(requiresOtp),
    recordedAt,
    location: {
      lat: podLocation.lat,
      lng: podLocation.lng,
      accuracyMeters: podLocation.accuracyMeters,
      capturedAt: podLocation.capturedAt,
    },
    evidence: {
      photoHash: photoCapture ? hashValue(photoCapture.dataUrl) : null,
      signatureHash: signatureCapture ? hashValue(signatureCapture.dataUrl) : null,
      proofHash: proofReference ? hashValue(proofReference) : null,
    },
  };
  const podHash = hashValue(JSON.stringify(podHashPayload));
  order.deliveryProof = {
    method,
    otpVerified: requiresOtp ? true : false,
    proof: proofReference || null,
    photoAttached: Boolean(photoCapture),
    signatureAttached: Boolean(signatureCapture),
    photoMeta: photoCapture
      ? {
          mimeType: photoCapture.mimeType,
          bytes: photoCapture.bytes,
          hash: podHashPayload.evidence.photoHash,
        }
      : null,
    signatureMeta: signatureCapture
      ? {
          mimeType: signatureCapture.mimeType,
          bytes: signatureCapture.bytes,
          hash: podHashPayload.evidence.signatureHash,
        }
      : null,
    captureSource: captureSource || null,
    identityChecklist,
    identityChecklistComplete,
    location: podHashPayload.location,
    hashAlgorithm: POD_HASH_ALGORITHM,
    podHash,
    payloadHash: podHash,
    recordedAt,
    recordedBy: req.user.id,
  };
  order.deliveryProofHash = podHash;
  order.dispatchStatus = "delivered";
  order.dispatchDeliveredAt = nowIso();
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "delivered", req.user.id, {
    method,
    podHash,
    photoAttached: Boolean(photoCapture),
    signatureAttached: Boolean(signatureCapture),
    identityChecklistComplete,
  });
  pushNotificationEvents(order, "delivered", req.user.id, {
    method,
    podHash,
    geofenceChecked: Boolean(geofence.checked),
    geofenceWithinRadius: geofence.checked ? Boolean(geofence.withinRadius) : null,
  });
  setDispatchMutation(order, "pod", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.pod",
    entityType: "order",
    entityId: order.id,
    metadata: {
      method,
      podHash,
      otpVerified: Boolean(requiresOtp),
    },
  });

  return res.json({
    order,
    geofence: order.lastGeofenceCheck || null,
    pod: {
      hash: podHash,
      hashAlgorithm: POD_HASH_ALGORITHM,
      location: podHashPayload.location,
      otpVerified: Boolean(requiresOtp),
      photoAttached: Boolean(photoCapture),
      signatureAttached: Boolean(signatureCapture),
      identityChecklistComplete,
    },
  });
});

router.post("/:id/unsafe", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }
  if (!order.courierId) order.courierId = req.user.id;

  const action = String(req.body?.action || "").trim().toLowerCase();
  const reason = String(req.body?.reason || "").trim();
  if (!["pause", "escalate", "reassign"].includes(action)) {
    return res.status(400).json({ error: "Invalid unsafe action", code: "UNSAFE_ACTION_INVALID" });
  }
  if (!reason || reason.length < 8) {
    return res.status(400).json({
      error: "Unsafe action reason is required (min 8 chars)",
      code: "UNSAFE_REASON_REQUIRED",
    });
  }

  const current = normalizeDispatchStatus(order);
  if (!["assigned", "accepted", "picked_up", "arrived"].includes(current)) {
    return res.status(409).json({
      error: "Unsafe action is only available on active dispatch jobs",
      code: "UNSAFE_ACTION_INVALID_STATE",
    });
  }

  const now = nowIso();
  const eventType = `unsafe_${action}`;
  if (action === "pause") {
    order.dispatchPaused = true;
    order.dispatchPausedAt = now;
    order.dispatchPauseReason = reason;
  } else if (action === "escalate") {
    order.dispatchPriority = "high";
    order.dispatchEscalated = true;
    order.dispatchEscalatedAt = now;
    order.dispatchEscalationReason = reason;
  } else if (action === "reassign") {
    order.dispatchReassignRequested = true;
    order.dispatchReassignRequestedAt = now;
    order.dispatchReassignReason = reason;
  }

  pushDispatchTimeline(order, eventType, req.user.id, { reason });
  pushNotificationEvents(order, eventType, req.user.id, { reason });
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.unsafe_action",
    entityType: "order",
    entityId: order.id,
    metadata: { action, reason },
  });

  return res.json({ order, unsafeAction: { action, reason, at: now } });
});

router.post("/:id/fail", requireAuth, requireRoles(["courier"]), async (req, res) => {
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
  const mutationKey = getMutationKey(req);
  if (isSameDispatchMutation(order, "fail", mutationKey)) {
    return res.json({ order, idempotent: true });
  }
  if (!requireCourierOrderAccess(order, req.user.id)) {
    return res.status(403).json({ error: "Order assigned to another courier", code: "COURIER_NOT_ASSIGNED" });
  }

  if (!order.courierId) order.courierId = req.user.id;
  const current = normalizeDispatchStatus(order);
  const transition = validateDispatchTransition({ current, next: "failed" });
  if (!transition.ok && current !== "failed") {
    return res.status(409).json({ error: transition.error, code: transition.code });
  }

  const reason = String(req.body?.reason || "other").trim().toLowerCase();
  if (!FAIL_REASONS.has(reason)) {
    return res.status(400).json({ error: "Invalid fail reason", code: "DISPATCH_INVALID_REASON" });
  }

  order.dispatchStatus = "failed";
  order.dispatchFailedAt = nowIso();
  order.failureReason = reason;
  order.dispatchFailureReason = reason;
  order.dispatchFailureNote = String(req.body?.note || "").trim() || null;
  applyOrderStatusMirror(order);
  pushDispatchTimeline(order, "failed", req.user.id, { reason });
  pushNotificationEvents(order, "failed", req.user.id, { reason });
  setDispatchMutation(order, "fail", mutationKey, req.user.id);
  await order.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "dispatch.order.fail",
    entityType: "order",
    entityId: order.id,
    metadata: { reason },
  });

  return res.json({ order });
});

router.post(
  "/:id/supervisor-override",
  requireAuth,
  requireRoles(["admin", "pharmacy", "moh"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
    if (!(await canRunSupervisorOverride(req, order))) {
      return res.status(403).json({ error: "Supervisor override permission required", code: "FORBIDDEN" });
    }

    const action = String(req.body?.action || "").trim().toLowerCase();
    const reason = String(req.body?.reason || "").trim();
    if (!reason || reason.length < 12) {
      return res.status(400).json({
        error: "Override reason is required and must be at least 12 characters",
        code: "OVERRIDE_REASON_REQUIRED",
      });
    }

    let debugOtp = undefined;
    if (action === "unlock_otp") {
      const otpState = order.deliveryOtp || {};
      const nextOtp = randomOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
      order.deliveryOtp = {
        ...otpState,
        hash: hashOtp(nextOtp),
        issuedAt: nowIso(),
        expiresAt,
        attempts: 0,
        consumedAt: null,
        overrideUnlockedAt: nowIso(),
        overrideUnlockedBy: req.user.id,
      };
      if (String(process.env.DISPATCH_RETURN_OTP_IN_RESPONSE || "false").toLowerCase() === "true") {
        debugOtp = nextOtp;
      }
      pushDispatchTimeline(order, "supervisor_override", req.user.id, { action, reason, expiresAt });
    } else if (action === "clear_failure") {
      order.dispatchFailureReason = null;
      order.dispatchFailureNote = null;
      order.failureReason = null;
      order.dispatchStatus = order.courierId ? "assigned" : "queued";
      applyOrderStatusMirror(order);
      pushDispatchTimeline(order, "supervisor_override", req.user.id, { action, reason });
    } else if (action === "reassign") {
      const courierId = String(req.body?.courierId || "").trim();
      const courier = await User.findByPk(courierId);
      if (!courier || String(courier.role || "").toLowerCase() !== "courier") {
        return res.status(400).json({ error: "Valid courierId is required", code: "COURIER_NOT_FOUND" });
      }
      order.courierId = courierId;
      order.dispatchStatus = "assigned";
      order.dispatchAssignedAt = nowIso();
      order.dispatchFailureReason = null;
      order.dispatchFailureNote = null;
      order.failureReason = null;
      applyOrderStatusMirror(order);
      pushDispatchTimeline(order, "supervisor_override", req.user.id, {
        action,
        reason,
        courierId,
      });
      pushNotificationEvents(order, "assigned", req.user.id, { courierId, source: "supervisor_override" });
    } else {
      return res.status(400).json({
        error: "action must be unlock_otp, clear_failure, or reassign",
        code: "OVERRIDE_ACTION_INVALID",
      });
    }

    order.supervisorOverrides = [
      ...(Array.isArray(order.supervisorOverrides) ? order.supervisorOverrides : []),
      {
        id: `ovr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        action,
        reason,
        by: req.user.id,
        at: nowIso(),
      },
    ].slice(-60);
    await order.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "dispatch.order.supervisor_override",
      entityType: "order",
      entityId: order.id,
      metadata: { action, reason },
    });

    return res.json({
      order,
      otpMeta: buildOtpMeta(order.deliveryOtp),
      otp: debugOtp,
    });
  }
);

router.get(
  "/events",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier", "patient"]),
  async (req, res) => {
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    const typeFilter = String(req.query.type || "").trim().toLowerCase();
    const sinceRaw = String(req.query.since || "").trim();
    const sinceAt = sinceRaw ? toDate(sinceRaw) : null;
    const limit = Math.max(1, Math.min(300, Number(req.query.limit || 120) || 120));

    const allOrders = await Order.findAll({});
    const visible = allOrders.filter((order) =>
      canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })
    );

    const events = [];
    for (const order of visible) {
      // eslint-disable-next-line no-await-in-loop
      const row = await buildOrderView(order);
      const notifications = Array.isArray(order.dispatchNotifications) ? order.dispatchNotifications : [];
      for (const notification of notifications) {
        const eventType = String(notification?.type || "").trim().toLowerCase();
        if (typeFilter && eventType !== typeFilter) continue;
        const at = toDate(notification?.at);
        if (sinceAt && at && at.getTime() < sinceAt.getTime()) continue;
        events.push({
          ...notification,
          orderId: order.id,
          dispatchStatus: row.dispatchStatus || null,
          patientName: row.patientName || null,
          pharmacyName: row.pharmacyName || null,
          courierName: row.courierName || null,
          destinationAddress: row.destinationAddress || null,
        });
      }
    }

    events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return res.json({
      generatedAt: nowIso(),
      events: events.slice(0, limit),
    });
  }
);

router.get(
  "/:id/notifications",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier", "patient"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) {
      return res.status(403).json({ error: "Forbidden order scope", code: "FORBIDDEN_ORDER_SCOPE" });
    }
    const notifications = Array.isArray(order.dispatchNotifications) ? order.dispatchNotifications : [];
    notifications.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    return res.json({ notifications: notifications.slice(0, 120) });
  }
);

router.get(
  "/:id/timeline",
  requireAuth,
  requireRoles(["pharmacy", "admin", "courier", "patient"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
    const role = String(req.user.role || "").toLowerCase();
    const scope = role === "pharmacy" ? await resolvePharmacyScope(req.user.id) : null;
    if (!canAccessOrder({ order, role, userId: req.user.id, pharmacyScope: scope })) {
      return res.status(403).json({ error: "Forbidden order scope", code: "FORBIDDEN_ORDER_SCOPE" });
    }
    const timeline = Array.isArray(order.dispatchTimeline) ? order.dispatchTimeline : [];
    timeline.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
    return res.json({ timeline });
  }
);

module.exports = router;

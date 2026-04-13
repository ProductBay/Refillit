const express = require("express");
const crypto = require("node:crypto");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  Order,
  PharmacyProfile,
  Prescription,
  PharmacyIntervention,
  ComplianceReportSnapshot,
  User,
  OtcProduct,
  PharmacyOtcInventory,
  OtcOrderItem,
} = require("../models");
const { writeAudit } = require("../utils/audit");
const { parsePrescriptionQr } = require("../utils/prescriptionQr");
const {
  computeSnapshotChecksum,
  createSnapshotSignature,
  verifySnapshotRecord,
} = require("../utils/complianceSnapshot");

const router = express.Router();

const ORDER_TRANSITIONS = {
  submitted: new Set(["processing", "failed"]),
  processing: new Set(["ready", "failed"]),
  ready: new Set(["assigned", "completed", "failed"]),
  assigned: new Set(["completed", "failed"]),
  completed: new Set([]),
  failed: new Set([]),
};

const toDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const isSameMutation = (order, { key, status }) => {
  const last = order?.lastStatusMutation || null;
  return Boolean(last && last.key && key && last.key === key && last.status === status);
};

const ensureOrderOwnership = ({ order, userId, pharmacyProfileId }) => {
  const pharmacyId = String(order?.pharmacyId || "");
  if (!pharmacyId) return true;
  if (pharmacyId === String(userId || "")) return true;
  if (pharmacyProfileId && pharmacyId === String(pharmacyProfileId)) return true;
  return false;
};

const hasControlledDrug = (order) => {
  const meds = Array.isArray(order?.prescriptionSnapshot?.meds) ? order.prescriptionSnapshot.meds : [];
  return meds.some((med) => Boolean(med?.controlledSubstance));
};

const randomToken = () => Math.random().toString(36).slice(2, 10).toUpperCase();
const randomNonce = () => crypto.randomBytes(12).toString("hex");
const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());
const NONCE_TTL_MINUTES = Math.max(
  1,
  Number(process.env.PHARMACY_VERIFICATION_NONCE_TTL_MINUTES || 10)
);
const MAX_SNAPSHOT_EVIDENCE_ITEMS = Math.max(
  1,
  Number(process.env.PHARMACY_SNAPSHOT_EVIDENCE_MAX_ITEMS || 4)
);
const MAX_SNAPSHOT_EVIDENCE_BYTES = Math.max(
  64 * 1024,
  Number(process.env.PHARMACY_SNAPSHOT_EVIDENCE_MAX_BYTES || 1.5 * 1024 * 1024)
);
const MAX_OTC_IMPORT_ROWS = Math.max(1, Number(process.env.PHARMACY_OTC_IMPORT_MAX_ROWS || 500));
const MAX_OTC_IMPORT_CSV_BYTES = Math.max(
  64 * 1024,
  Number(process.env.PHARMACY_OTC_IMPORT_MAX_BYTES || 512 * 1024)
);

const normalizeDispatchStatus = (order) => {
  const status = String(order?.dispatchStatus || "").trim().toLowerCase();
  if (status) return status;
  if (String(order?.deliveryOption || "").toLowerCase() !== "delivery") return "none";
  return "queued";
};

const validateTransition = ({ current, next }) => {
  const currentStatus = String(current || "submitted").toLowerCase();
  const nextStatus = String(next || "").toLowerCase();
  if (!ORDER_TRANSITIONS[currentStatus]) {
    return { error: `Unknown current status: ${currentStatus}` };
  }
  if (!ORDER_TRANSITIONS[currentStatus].has(nextStatus)) {
    return { error: `Invalid transition from ${currentStatus} to ${nextStatus}` };
  }
  return { currentStatus, nextStatus };
};

const validateControlledOverride = async ({ req, order }) => {
  const override = req.body?.controlledOverride;
  if (!override) return { ok: false, error: "controlledOverride payload is required for override" };
  const primarySignerId = String(override.primarySignerId || "").trim();
  const secondarySignerId = String(override.secondarySignerId || "").trim();
  const justification = String(override.justification || "").trim();
  if (!primarySignerId || !secondarySignerId) {
    return { ok: false, error: "primarySignerId and secondarySignerId are required for override" };
  }
  if (primarySignerId !== String(req.user.id)) {
    return { ok: false, error: "primarySignerId must match current authenticated pharmacist" };
  }
  if (secondarySignerId === primarySignerId) {
    return { ok: false, error: "secondarySignerId must be a different pharmacy user" };
  }
  if (justification.length < 12) {
    return { ok: false, error: "override justification must be at least 12 characters" };
  }
  const secondary = await User.findByPk(secondarySignerId);
  if (!secondary || String(secondary.role || "").toLowerCase() !== "pharmacy") {
    return { ok: false, error: "secondarySignerId must be an existing pharmacy user" };
  }
  const secondaryProfile = await PharmacyProfile.findOne({ where: { userId: secondary.id } });
  if (
    !ensureOrderOwnership({ order, userId: secondary.id, pharmacyProfileId: secondaryProfile?.id })
  ) {
    return { ok: false, error: "secondary signer is not assigned to this pharmacy order" };
  }
  const secondaryAuthCode = String(override.secondaryAuthCode || "").trim();
  if (isTruthy(process.env.PHARMACY_REQUIRE_SECONDARY_AUTH_STUB)) {
    if (!/^\d{6}$/.test(secondaryAuthCode)) {
      return { ok: false, error: "secondaryAuthCode must be a 6-digit code" };
    }
    const expected = String(process.env.PHARMACY_SECONDARY_AUTH_STUB_CODE || "123456").trim();
    if (secondaryAuthCode !== expected) {
      return { ok: false, error: "secondaryAuthCode verification failed" };
    }
  }
  return {
    ok: true,
    override: {
      primarySignerId,
      secondarySignerId,
      justification,
      secondaryAuthVerified: true,
      secondaryAuthMethod: "stub_code",
      approvedAt: new Date().toISOString(),
    },
  };
};

const complianceRiskLevel = (eventType) => {
  const key = String(eventType || "").toLowerCase();
  if (key.includes("controlled_override")) return "critical";
  if (key.includes("controlled_checklist") || key.includes("nonce_used")) return "high";
  if (key.includes("status_transition")) return "moderate";
  if (key.includes("nonce_issued")) return "low";
  return "moderate";
};

const sanitizeSnapshotEvidence = (value) => {
  const list = Array.isArray(value) ? value : [];
  const accepted = [];
  for (const item of list.slice(0, MAX_SNAPSHOT_EVIDENCE_ITEMS)) {
    const name = String(item?.name || "").trim().slice(0, 180);
    const mimeType = String(item?.mimeType || item?.type || "").trim().slice(0, 120);
    const note = String(item?.note || "").trim().slice(0, 300);
    const dataUrl = String(item?.dataUrl || "").trim();
    if (!dataUrl.startsWith("data:")) continue;
    const commaIndex = dataUrl.indexOf(",");
    if (commaIndex <= 0) continue;
    const base64 = dataUrl.slice(commaIndex + 1);
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(base64, "base64");
    } catch (_err) {
      continue;
    }
    if (!bytes || bytes > MAX_SNAPSHOT_EVIDENCE_BYTES) continue;
    accepted.push({
      name: name || "evidence",
      mimeType: mimeType || "application/octet-stream",
      note: note || null,
      bytes,
      dataUrl,
      attachedAt: new Date().toISOString(),
    });
  }
  return accepted;
};

const buildComplianceEventsForOrder = (order) => {
  const orderId = order.id;
  const createdAt = order.createdAt || null;
  const statusHistory = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const ackMap = order?.complianceEventAcks || {};
  const events = [];
  if (order?.pharmacyVerification?.verificationNonce) {
    events.push({
      id: `evt-${orderId}-nonce-issued`,
      type: "nonce_issued",
      at: order?.pharmacyVerification?.verificationNonceIssuedAt || createdAt,
      orderId,
      details: `Nonce issued for order ${orderId}`,
    });
  }
  if (order?.pharmacyVerification?.verificationNonceUsedAt || order?.verificationNonceUsedAt) {
    events.push({
      id: `evt-${orderId}-nonce-used`,
      type: "nonce_used",
      at: order?.pharmacyVerification?.verificationNonceUsedAt || order?.verificationNonceUsedAt,
      orderId,
      details: `Nonce consumed for order ${orderId}`,
    });
  }
  if (order.controlledChecklist) {
    events.push({
      id: `evt-${orderId}-controlled-checklist`,
      type: "controlled_checklist",
      at: order.updatedAt || createdAt,
      orderId,
      details: "Controlled checklist confirmed",
    });
  }
  if (order.controlledOverride?.approvedAt) {
    events.push({
      id: `evt-${orderId}-controlled-override`,
      type: "controlled_override",
      at: order.controlledOverride.approvedAt,
      orderId,
      details: `Dual-sign override by ${order.controlledOverride.primarySignerId} + ${order.controlledOverride.secondarySignerId}`,
    });
  }
  for (const statusEntry of statusHistory.slice(-20)) {
    events.push({
      id: `evt-${orderId}-status-${statusEntry.id || statusEntry.at}`,
      type: "status_transition",
      at: statusEntry.at || createdAt,
      orderId,
      details: `Order moved to ${statusEntry.status}`,
    });
  }

  return events.map((event) => {
    const ack = ackMap[event.id] || null;
    return {
      ...event,
      riskLevel: complianceRiskLevel(event.type),
      acknowledged: Boolean(ack),
      acknowledgedAt: ack?.acknowledgedAt || null,
      acknowledgedBy: ack?.acknowledgedBy || null,
      acknowledgedNote: ack?.note || null,
    };
  });
};

const loadOwnedPharmacyOrders = async ({ userId, pharmacyProfileId }) => {
  const allOrders = await Order.findAll({});
  return allOrders.filter((entry) =>
    ensureOrderOwnership({ order: entry, userId, pharmacyProfileId })
  );
};

const buildPharmacyScopeIds = ({ userId, profileId, orderPharmacyId }) =>
  new Set(
    [String(userId || ""), String(profileId || ""), String(orderPharmacyId || "")]
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

const DEFAULT_OTC_PRODUCTS = [
  {
    sku: "OTC-PAR-500",
    name: "Paracetamol 500mg",
    category: "pain_fever",
    dosageForm: "tablet",
    strength: "500mg",
    activeIngredient: "paracetamol",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-IBU-200",
    name: "Ibuprofen 200mg",
    category: "pain_inflammation",
    dosageForm: "tablet",
    strength: "200mg",
    activeIngredient: "ibuprofen",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-CET-10",
    name: "Cetirizine 10mg",
    category: "allergy",
    dosageForm: "tablet",
    strength: "10mg",
    activeIngredient: "cetirizine",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-ORS-500",
    name: "Oral Rehydration Salts",
    category: "hydration",
    dosageForm: "sachet",
    strength: "500ml",
    activeIngredient: "electrolytes",
    maxQtyPerOrder: 6,
  },
  {
    sku: "OTC-PSE-60",
    name: "Pseudoephedrine 60mg",
    category: "cold_flu",
    dosageForm: "tablet",
    strength: "60mg",
    activeIngredient: "pseudoephedrine",
    maxQtyPerOrder: 1,
  },
];

const ensureDefaultOtcProducts = async () => {
  for (const seed of DEFAULT_OTC_PRODUCTS) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await OtcProduct.findOne({ where: { sku: seed.sku } });
    if (exists) continue;
    // eslint-disable-next-line no-await-in-loop
    await OtcProduct.create({
      ...seed,
      requiresAgeCheck: seed.sku === "OTC-PSE-60",
      isActive: true,
      metadata: { source: "default_seed" },
    });
  }
};

const ensureDefaultOtcInventoryForDemo = async ({ profileId, userId }) => {
  await ensureDefaultOtcProducts();
  const targetPharmacyId = String(profileId || userId || "").trim();
  if (!targetPharmacyId) return;
  const products = await OtcProduct.findAll({});
  for (const product of products) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await PharmacyOtcInventory.findOne({
      where: { pharmacyId: targetPharmacyId, productId: product.id },
    });
    if (existing) continue;
    // eslint-disable-next-line no-await-in-loop
    await PharmacyOtcInventory.create({
      pharmacyId: targetPharmacyId,
      productId: product.id,
      onHand: 24,
      unitPrice: Number(
        {
          "OTC-PAR-500": 180,
          "OTC-IBU-200": 220,
          "OTC-CET-10": 260,
          "OTC-ORS-500": 140,
          "OTC-PSE-60": 320,
        }[String(product.sku || "").trim()] || 200
      ),
      maxPerOrder: Math.max(1, Number(product.maxQtyPerOrder || 1)),
      isListed: true,
      metadata: { source: "default_seed_inventory", seededBy: "system" },
    });
  }
};

const applyComplianceFilters = (events, filters = {}) => {
  const risk = String(filters.risk || "").trim().toLowerCase();
  const ack = String(filters.ack || "all").trim().toLowerCase();
  const eventType = String(filters.type || "").trim().toLowerCase();
  const orderId = String(filters.orderId || "").trim();
  const from = filters.from ? toDate(filters.from) : null;
  const to = filters.to ? toDate(filters.to) : null;
  return events.filter((event) => {
    const atDate = toDate(event.at);
    if (risk && String(event.riskLevel || "").toLowerCase() !== risk) return false;
    if (eventType && String(event.type || "").toLowerCase() !== eventType) return false;
    if (orderId && String(event.orderId || "") !== orderId) return false;
    if (ack === "read" && !event.acknowledged) return false;
    if (ack === "unread" && event.acknowledged) return false;
    if (from && (!atDate || atDate.getTime() < from.getTime())) return false;
    if (to && (!atDate || atDate.getTime() > to.getTime())) return false;
    return true;
  });
};

const summarizeComplianceEvents = (events) => {
  const summary = { total: events.length, unread: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const event of events) {
    if (!event.acknowledged) summary.unread += 1;
    const risk = String(event.riskLevel || "moderate").toLowerCase();
    if (summary[risk] !== undefined) summary[risk] += 1;
  }
  return summary;
};

const csvEscape = (value) => {
  const raw = String(value ?? "");
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
};

const parseCsvRows = (text) => {
  const source = String(text || "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

const parseCsvBoolean = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
};

const normalizeCsvHeaderKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const OTC_IMPORT_HEADER_MAP = {
  productid: "productId",
  sku: "sku",
  onhand: "onHand",
  unitprice: "unitPrice",
  maxperorder: "maxPerOrder",
  islisted: "isListed",
};

const normalizeImportRecord = (headers, row) => {
  const record = {};
  headers.forEach((header, index) => {
    const key = OTC_IMPORT_HEADER_MAP[normalizeCsvHeaderKey(header)];
    if (!key) return;
    record[key] = String(row[index] ?? "").trim();
  });
  return record;
};

const complianceEventsToCsv = (events, metadata = {}) => {
  const metaRows = [
    ["pharmacy_name", metadata.pharmacyName || ""],
    ["pharmacy_registration_code", metadata.registrationCode || ""],
    ["generated_at", metadata.generatedAt || new Date().toISOString()],
    [],
  ];
  const header = [
    "event_id",
    "order_id",
    "type",
    "risk_level",
    "occurred_at",
    "acknowledged",
    "acknowledged_at",
    "acknowledged_by",
    "details",
  ];
  const rows = events.map((event) => [
    event.id,
    event.orderId,
    event.type,
    event.riskLevel,
    event.at,
    event.acknowledged ? "yes" : "no",
    event.acknowledgedAt || "",
    event.acknowledgedBy || "",
    event.details || "",
  ]);
  return [...metaRows, header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
};

const renderComplianceSnapshotHtml = (snapshot, metadata = {}) => {
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const summary = snapshot?.summary || {};
  const pharmacyName = metadata.pharmacyName || "n/a";
  const registrationCode = metadata.registrationCode || "n/a";
  const rows = events
    .map(
      (event) => `
      <tr>
        <td>${event.orderId || ""}</td>
        <td>${event.type || ""}</td>
        <td>${event.riskLevel || ""}</td>
        <td>${event.at || ""}</td>
        <td>${event.acknowledged ? "Reviewed" : "Unread"}</td>
        <td>${event.details || ""}</td>
      </tr>
    `
    )
    .join("");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Compliance Snapshot ${snapshot.id}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #1d1d1d; }
      h1 { margin: 0 0 12px; }
      .meta { margin-bottom: 14px; font-size: 12px; color: #5a5a5a; }
      .summary { margin-bottom: 12px; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #d8d8d8; padding: 8px; text-align: left; vertical-align: top; }
      th { background: #f4f7f7; }
    </style>
  </head>
  <body>
    <h1>Compliance Report Snapshot</h1>
    <div class="meta">Pharmacy: ${pharmacyName} | Registration: ${registrationCode}</div>
    <div class="meta">Snapshot ID: ${snapshot.id} | Label: ${snapshot.label || "n/a"} | Created: ${snapshot.createdAt}</div>
    <div class="summary">
      Total: ${summary.total || 0} | Unread: ${summary.unread || 0} | Critical: ${summary.critical || 0} | High: ${summary.high || 0} | Moderate: ${summary.moderate || 0} | Low: ${summary.low || 0}
    </div>
    <table>
      <thead>
        <tr>
          <th>Order</th><th>Type</th><th>Risk</th><th>Occurred</th><th>Reviewed</th><th>Details</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </body>
</html>`;
};

router.post(
  "/verify-prescription",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const body = req.body || {};
    let prescId = body.prescId;
    let decodedQr = null;
    if (!prescId && body.qrContent) {
      decodedQr = parsePrescriptionQr(body.qrContent);
      if (!decodedQr) {
        return res.status(400).json({ error: "Invalid or tampered QR content" });
      }
      prescId = decodedQr.prescId;
    }
    const prescription = await Prescription.findByPk(prescId);
    if (!prescription) {
      return res.status(404).json({ error: "Prescription not found" });
    }
    if (decodedQr?.linkCode && prescription.linkCode !== decodedQr.linkCode) {
      return res.status(400).json({ error: "QR link code mismatch" });
    }
    const qrHash = body.qrContent
      ? crypto.createHash("sha256").update(String(body.qrContent)).digest("hex")
      : null;

    const orderId = String(body.orderId || "").trim();
    let linkedOrder = null;
    if (orderId) {
      linkedOrder = await Order.findByPk(orderId);
      if (!linkedOrder) {
        return res.status(404).json({ error: "Order not found" });
      }
      if (!ensureOrderOwnership({ order: linkedOrder, userId: req.user.id, pharmacyProfileId: profile?.id })) {
        return res.status(403).json({ error: "Pharmacy is not authorized for this order" });
      }
      if (String(linkedOrder.prescId || "") !== String(prescription.id || "")) {
        return res.status(400).json({ error: "Prescription does not match selected order" });
      }
      linkedOrder.pharmacyVerification = {
        verified: true,
        verifiedAt: new Date().toISOString(),
        verifiedBy: req.user.id,
        verificationSource: body.qrContent ? "qr" : "manual",
        verificationNonce: randomNonce(),
        verificationNonceIssuedAt: new Date().toISOString(),
        verificationNonceUsed: false,
        qrHash,
      };
      linkedOrder.prescriptionSnapshot = {
        id: prescription.id,
        doctorId: prescription.doctorId || null,
        doctorName: prescription.doctorName || decodedQr?.doctorName || null,
        patientId: prescription.patientId || null,
        patientFullName: prescription.patientFullName || null,
        meds: Array.isArray(prescription.meds) ? prescription.meds : [],
        allowedRefills: Number(prescription.allowedRefills || 0),
        expiryDate: prescription.expiryDate || null,
      };
      linkedOrder.verificationStatus = "verified";
      linkedOrder.verificationUpdatedAt = new Date().toISOString();
      linkedOrder.verificationNonce = linkedOrder.pharmacyVerification.verificationNonce;
      linkedOrder.verificationNonceIssuedAt = linkedOrder.pharmacyVerification.verificationNonceIssuedAt;
      linkedOrder.verificationNonceUsed = false;
      await linkedOrder.save();
      await writeAudit({
        actorUserId: req.user.id,
        action: "pharmacy.order.verify_prescription",
        entityType: "order",
        entityId: linkedOrder.id,
        metadata: { prescriptionId: prescription.id },
      });
    }

    return res.json({
      verified: true,
      prescription: {
        ...prescription,
        doctorName: prescription.doctorName || decodedQr?.doctorName || null,
      },
      decodedQr,
      order: linkedOrder,
      verificationNonce:
        linkedOrder?.pharmacyVerification?.verificationNonce || linkedOrder?.verificationNonce || null,
    });
  }
);

router.get("/orders/queue", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const status = String(req.query.status || "").trim().toLowerCase();
  const query = String(req.query.query || "").trim().toLowerCase();
  const orderType = String(req.query.orderType || "").trim().toLowerCase();
  const allOrders = await Order.findAll({});
  const orders = allOrders.filter((entry) =>
    ensureOrderOwnership({ order: entry, userId: req.user.id, pharmacyProfileId: profile?.id })
  );
  const enriched = [];
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop
    const patient = order.patientId ? await User.findByPk(order.patientId) : null;
    // eslint-disable-next-line no-await-in-loop
    const courier = order.courierId ? await User.findByPk(order.courierId) : null;
    // eslint-disable-next-line no-await-in-loop
    const prescription =
      !order.orderType || String(order.orderType || "").toLowerCase() === "prescription"
        ? await Prescription.findByPk(order.prescId)
        : null;
    const prescriptionSnapshot =
      order.prescriptionSnapshot
      || (prescription
        ? {
          id: prescription.id,
          doctorId: prescription.doctorId || null,
          doctorName: prescription.doctorName || null,
          patientId: prescription.patientId || null,
          patientFullName: prescription.patientFullName || null,
          meds: Array.isArray(prescription.meds) ? prescription.meds : [],
          allowedRefills: Number(prescription.allowedRefills || 0),
          expiryDate: prescription.expiryDate || null,
        }
        : null);
    const row = {
      ...(typeof order?.toJSON === "function" ? order.toJSON() : order),
      orderType: String(order.orderType || "prescription").toLowerCase(),
      patientName: patient?.fullName || null,
      patientEmail: patient?.email || null,
      prescriptionSnapshot,
      hasControlledDrug: hasControlledDrug(order),
      verificationStatus:
        order.verificationStatus || (order.pharmacyVerification?.verified ? "verified" : "unverified"),
      dispatchStatus: normalizeDispatchStatus(order),
      dispatchPriority: String(order.dispatchPriority || "normal").toLowerCase(),
      dispatchAssignedAt: order.dispatchAssignedAt || null,
      dispatchAcceptedAt: order.dispatchAcceptedAt || null,
      dispatchPickedUpAt: order.dispatchPickedUpAt || null,
      dispatchDeliveredAt: order.dispatchDeliveredAt || null,
      dispatchFailedAt: order.dispatchFailedAt || null,
      dispatchEtaStart: order.dispatchEtaStart || null,
      dispatchEtaEnd: order.dispatchEtaEnd || null,
      dispatchFailureReason: order.dispatchFailureReason || order.failureReason || null,
      courierId: order.courierId || null,
      courierName: courier?.fullName || null,
    };
    const statusMatch = status ? String(row.orderStatus || "").toLowerCase() === status : true;
    const typeMatch = orderType ? String(row.orderType || "").toLowerCase() === orderType : true;
    const queryMatch = query
      ? [
          row.id,
          row.orderType,
          row.prescId,
          row.patientName,
          row.patientEmail,
          row.orderStatus,
          row.dispatchStatus,
          row.courierName,
          row.courierId,
        ]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query))
      : true;
    if (statusMatch && typeMatch && queryMatch) enriched.push(row);
  }
  enriched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ orders: enriched });
});

router.get("/otc/inventory", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const pharmacyScopeId = profile?.id || req.user.id;
  await ensureDefaultOtcInventoryForDemo({ profileId: profile?.id, userId: req.user.id });
  const products = await OtcProduct.findAll({});
  const inventoryRows = await PharmacyOtcInventory.findAll({ where: { pharmacyId: pharmacyScopeId } });
  const inventoryByProductId = new Map(
    inventoryRows.map((entry) => [String(entry.productId || ""), entry])
  );
  const rows = products
    .filter((entry) => entry.isActive !== false)
    .map((product) => {
      const inv = inventoryByProductId.get(String(product.id)) || null;
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        category: product.category || "general",
        dosageForm: product.dosageForm || null,
        strength: product.strength || null,
        activeIngredient: product.activeIngredient || null,
        requiresAgeCheck: Boolean(product.requiresAgeCheck),
        defaultMaxQtyPerOrder: Number(product.maxQtyPerOrder || 1),
        inventoryId: inv?.id || null,
        onHand: Number(inv?.onHand || 0),
        unitPrice: Number(inv?.unitPrice || 0),
        maxPerOrder: Number(inv?.maxPerOrder || product.maxQtyPerOrder || 1),
        isListed: Boolean(inv?.isListed),
      };
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return res.json({ items: rows, pharmacyId: pharmacyScopeId });
});

router.post("/otc/inventory/upsert", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const pharmacyScopeId = profile?.id || req.user.id;
  const productId = String(req.body?.productId || "").trim();
  if (!productId) return res.status(400).json({ error: "productId is required" });
  const product = await OtcProduct.findByPk(productId);
  if (!product || product.isActive === false) {
    return res.status(404).json({ error: "OTC product not found" });
  }

  const onHand = Math.max(0, Number(req.body?.onHand || 0));
  const unitPrice = Math.max(0, Number(req.body?.unitPrice || 0));
  const maxPerOrder = Math.max(1, Number(req.body?.maxPerOrder || product.maxQtyPerOrder || 1));
  const isListed = req.body?.isListed === true;

  let inventory = await PharmacyOtcInventory.findOne({
    where: { pharmacyId: pharmacyScopeId, productId },
  });
  if (!inventory) {
    inventory = await PharmacyOtcInventory.create({
      pharmacyId: pharmacyScopeId,
      productId,
      onHand,
      unitPrice,
      maxPerOrder,
      isListed,
      metadata: {
        updatedBy: req.user.id,
      },
    });
  } else {
    inventory.onHand = onHand;
    inventory.unitPrice = unitPrice;
    inventory.maxPerOrder = maxPerOrder;
    inventory.isListed = isListed;
    inventory.metadata = {
      ...(inventory.metadata || {}),
      updatedBy: req.user.id,
      updatedAt: new Date().toISOString(),
    };
    await inventory.save();
  }
  await writeAudit({
    actorUserId: req.user.id,
    action: "pharmacy.otc_inventory.upsert",
    entityType: "pharmacy_otc_inventory",
    entityId: inventory.id,
    metadata: {
      pharmacyId: pharmacyScopeId,
      productId,
      onHand,
      unitPrice,
      maxPerOrder,
      isListed,
    },
  });
  return res.json({ inventory });
});

router.post("/otc/inventory/import-csv", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const pharmacyScopeId = profile?.id || req.user.id;
  const csvText = String(req.body?.csvText || "");
  const dryRun = req.body?.dryRun === true;
  if (!csvText.trim()) {
    return res.status(400).json({ error: "csvText is required" });
  }
  if (Buffer.byteLength(csvText, "utf8") > MAX_OTC_IMPORT_CSV_BYTES) {
    return res.status(413).json({
      error: `csvText exceeds max size (${MAX_OTC_IMPORT_CSV_BYTES} bytes)`,
    });
  }

  const rows = parseCsvRows(csvText).map((row) => row.map((cell) => String(cell || "").trim()));
  const nonEmptyRows = rows.filter((row) => row.some((cell) => cell.length > 0));
  if (!nonEmptyRows.length) {
    return res.status(400).json({ error: "CSV has no data rows" });
  }
  if (nonEmptyRows.length > MAX_OTC_IMPORT_ROWS + 1) {
    return res.status(413).json({ error: `CSV has too many rows (max ${MAX_OTC_IMPORT_ROWS})` });
  }

  const firstRow = nonEmptyRows[0] || [];
  const hasHeader = firstRow.some((cell) => Boolean(OTC_IMPORT_HEADER_MAP[normalizeCsvHeaderKey(cell)]));
  const headers = hasHeader ? firstRow : ["sku", "onHand", "unitPrice", "maxPerOrder", "isListed"];
  const dataRows = hasHeader ? nonEmptyRows.slice(1) : nonEmptyRows;

  const summary = {
    dryRun,
    totalRows: dataRows.length,
    imported: 0,
    created: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
  };
  const failures = [];

  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex += 1) {
    const row = dataRows[rowIndex];
    const csvRowNumber = hasHeader ? rowIndex + 2 : rowIndex + 1;
    if (!row.some((cell) => String(cell || "").trim())) {
      summary.skipped += 1;
      continue;
    }
    const record = normalizeImportRecord(headers, row);
    const productId = String(record.productId || "").trim();
    const sku = String(record.sku || "").trim();
    if (!productId && !sku) {
      summary.failed += 1;
      failures.push({ row: csvRowNumber, error: "productId or sku is required" });
      continue;
    }

    let product = null;
    if (productId) {
      // eslint-disable-next-line no-await-in-loop
      product = await OtcProduct.findByPk(productId);
    }
    if (!product && sku) {
      // eslint-disable-next-line no-await-in-loop
      product = await OtcProduct.findOne({ where: { sku } });
    }
    if (!product || product.isActive === false) {
      summary.failed += 1;
      failures.push({ row: csvRowNumber, error: `OTC product not found for ${productId || sku}` });
      continue;
    }

    const onHandValue = Number(record.onHand);
    const unitPriceValue = Number(record.unitPrice);
    const maxPerOrderValue = Number(record.maxPerOrder);
    if (!Number.isFinite(onHandValue) || onHandValue < 0) {
      summary.failed += 1;
      failures.push({ row: csvRowNumber, error: "onHand must be a number >= 0" });
      continue;
    }
    if (!Number.isFinite(unitPriceValue) || unitPriceValue < 0) {
      summary.failed += 1;
      failures.push({ row: csvRowNumber, error: "unitPrice must be a number >= 0" });
      continue;
    }
    const maxPerOrder = Number.isFinite(maxPerOrderValue)
      ? Math.max(1, Math.floor(maxPerOrderValue))
      : Math.max(1, Number(product.maxQtyPerOrder || 1));
    const parsedListed = parseCsvBoolean(record.isListed);
    const isListed = parsedListed === null ? true : parsedListed;
    if (record.isListed && parsedListed === null) {
      summary.failed += 1;
      failures.push({ row: csvRowNumber, error: "isListed must be true/false or 1/0" });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const existing = await PharmacyOtcInventory.findOne({
      where: { pharmacyId: pharmacyScopeId, productId: product.id },
    });
    if (!dryRun) {
      if (!existing) {
        // eslint-disable-next-line no-await-in-loop
        await PharmacyOtcInventory.create({
          pharmacyId: pharmacyScopeId,
          productId: product.id,
          onHand: Math.max(0, Math.floor(onHandValue)),
          unitPrice: Math.max(0, unitPriceValue),
          maxPerOrder,
          isListed,
          metadata: {
            updatedBy: req.user.id,
            importSource: "csv",
            importAt: new Date().toISOString(),
          },
        });
        summary.created += 1;
      } else {
        existing.onHand = Math.max(0, Math.floor(onHandValue));
        existing.unitPrice = Math.max(0, unitPriceValue);
        existing.maxPerOrder = maxPerOrder;
        existing.isListed = isListed;
        existing.metadata = {
          ...(existing.metadata || {}),
          updatedBy: req.user.id,
          updatedAt: new Date().toISOString(),
          importSource: "csv",
          importAt: new Date().toISOString(),
        };
        // eslint-disable-next-line no-await-in-loop
        await existing.save();
        summary.updated += 1;
      }
    } else if (existing) {
      summary.updated += 1;
    } else {
      summary.created += 1;
    }
    summary.imported += 1;
  }

  await writeAudit({
    actorUserId: req.user.id,
    action: "pharmacy.otc_inventory.import_csv",
    entityType: "pharmacy_otc_inventory",
    entityId: String(pharmacyScopeId),
    metadata: {
      pharmacyId: pharmacyScopeId,
      dryRun,
      summary,
      failedRows: failures.slice(0, 25),
    },
  });

  return res.json({
    summary,
    failures: failures.slice(0, 200),
    pharmacyId: pharmacyScopeId,
  });
});

router.get("/otc/orders", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  await ensureDefaultOtcInventoryForDemo({ profileId: profile?.id, userId: req.user.id });
  const status = String(req.query.status || "").trim().toLowerCase();
  const packingStatus = String(req.query.packingStatus || "").trim().toLowerCase();
  const query = String(req.query.query || "").trim().toLowerCase();
  const allOrders = await Order.findAll({});
  const otcOrders = allOrders.filter((entry) => {
    if (!ensureOrderOwnership({ order: entry, userId: req.user.id, pharmacyProfileId: profile?.id })) return false;
    return String(entry.orderType || "prescription").toLowerCase() === "otc";
  });
  const rows = [];
  for (const order of otcOrders) {
    // eslint-disable-next-line no-await-in-loop
    const patient = order.patientId ? await User.findByPk(order.patientId) : null;
    // eslint-disable-next-line no-await-in-loop
    const items = await OtcOrderItem.findAll({ where: { orderId: order.id } });
    const row = {
      ...order,
      patientName: patient?.fullName || null,
      patientEmail: patient?.email || null,
      orderType: "otc",
      otcPackingStatus: String(order.otcPackingStatus || "pending").toLowerCase(),
      otcItems: items.map((entry) => ({
        id: entry.id,
        productId: entry.productId,
        sku: entry.sku,
        productName: entry.productName,
        qty: Number(entry.qty || 0),
        unitPrice: Number(entry.unitPrice || 0),
        lineTotal: Number(entry.lineTotal || 0),
      })),
    };
    const statusMatch = status ? String(row.orderStatus || "").toLowerCase() === status : true;
    const packingMatch = packingStatus
      ? String(row.otcPackingStatus || "").toLowerCase() === packingStatus
      : true;
    const queryMatch = query
      ? [
          row.id,
          row.patientName,
          row.patientEmail,
          row.orderStatus,
          row.otcPackingStatus,
          row.paymentMethod,
          row.paymentStatus,
        ]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query))
      : true;
    if (statusMatch && packingMatch && queryMatch) rows.push(row);
  }
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ orders: rows });
});

router.post("/otc/orders/:id/packing", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const order = await Order.findByPk(req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!ensureOrderOwnership({ order, userId: req.user.id, pharmacyProfileId: profile?.id })) {
    return res.status(403).json({ error: "Pharmacy is not authorized for this order" });
  }
  if (String(order.orderType || "").toLowerCase() !== "otc") {
    return res.status(409).json({ error: "Order is not an OTC order" });
  }
  const nextPackingStatus = String(req.body?.packingStatus || "").trim().toLowerCase();
  if (!["pending", "packing", "packed"].includes(nextPackingStatus)) {
    return res.status(400).json({ error: "packingStatus must be pending, packing, or packed" });
  }

  const currentPackingStatus = String(order.otcPackingStatus || "pending").toLowerCase();
  if (nextPackingStatus === currentPackingStatus) {
    return res.json({ order, idempotent: true });
  }
  if (currentPackingStatus === "packed" && nextPackingStatus !== "packed") {
    return res.status(409).json({ error: "Packed OTC orders cannot be moved back to pending/packing" });
  }

  if (nextPackingStatus === "packed" && currentPackingStatus !== "packed") {
    const scopeIds = buildPharmacyScopeIds({
      userId: req.user.id,
      profileId: profile?.id,
      orderPharmacyId: order.pharmacyId,
    });
    const otcItems = await OtcOrderItem.findAll({ where: { orderId: order.id } });
    if (!otcItems.length) {
      return res.status(409).json({ error: "OTC order has no OTC line items" });
    }
    for (const item of otcItems) {
      const candidates = await PharmacyOtcInventory.findAll({ where: { productId: item.productId } });
      const inventory = candidates.find((entry) => scopeIds.has(String(entry.pharmacyId || ""))) || null;
      if (!inventory) {
        return res.status(409).json({ error: `Inventory not found for product ${item.productId}` });
      }
      const qty = Math.max(1, Number(item.qty || 0));
      if (Number(inventory.onHand || 0) < qty) {
        return res.status(409).json({ error: `Insufficient stock while packing ${item.productName || item.productId}` });
      }
    }
    for (const item of otcItems) {
      const candidates = await PharmacyOtcInventory.findAll({ where: { productId: item.productId } });
      const inventory = candidates.find((entry) => scopeIds.has(String(entry.pharmacyId || ""))) || null;
      const qty = Math.max(1, Number(item.qty || 0));
      inventory.onHand = Math.max(0, Number(inventory.onHand || 0) - qty);
      inventory.metadata = {
        ...(inventory.metadata || {}),
        lastPackedOrderId: order.id,
        lastPackedAt: new Date().toISOString(),
      };
      // eslint-disable-next-line no-await-in-loop
      await inventory.save();
    }
    order.orderStatus = "ready";
    if (!order.dispenseToken) order.dispenseToken = randomToken();
    if (String(order.deliveryOption || "").toLowerCase() === "delivery") {
      const currentDispatch = String(order.dispatchStatus || "").trim().toLowerCase();
      if (!["queued", "assigned", "accepted", "picked_up", "arrived", "delivered"].includes(currentDispatch)) {
        order.dispatchStatus = "queued";
        order.dispatchQueuedAt = new Date().toISOString();
      }
    }
  } else if (nextPackingStatus === "packing" && String(order.orderStatus || "").toLowerCase() === "submitted") {
    order.orderStatus = "processing";
  }

  order.otcPackingStatus = nextPackingStatus;
  order.otcPackingNote = String(req.body?.note || "").trim() || null;
  order.otcPackedBy = nextPackingStatus === "packed" ? req.user.id : null;
  order.otcPackedAt = nextPackingStatus === "packed" ? new Date().toISOString() : null;
  order.statusHistory = [
    ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
    {
      id: `otc-pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      status: String(order.orderStatus || "").toLowerCase(),
      packingStatus: nextPackingStatus,
      at: new Date().toISOString(),
      by: req.user.id,
      type: "otc_packing",
    },
  ].slice(-60);
  await order.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "pharmacy.otc_order.packing",
    entityType: "order",
    entityId: order.id,
    metadata: {
      packingStatus: nextPackingStatus,
      orderStatus: order.orderStatus || null,
    },
  });
  return res.json({ order });
});

router.post(
  "/orders/:id/status",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const order = await Order.findByPk(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (!ensureOrderOwnership({ order, userId: req.user.id, pharmacyProfileId: profile?.id })) {
      return res.status(403).json({ error: "Pharmacy is not authorized for this order" });
    }

    const status = String((req.body || {}).status || "").toLowerCase();
    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }
    if (status === String(order.orderStatus || "").toLowerCase()) {
      return res.json({ order, idempotent: true });
    }

    const mutationKey =
      String(req.headers["x-idempotency-key"] || "").trim() ||
      String((req.body || {}).idempotencyKey || "").trim();
    if (isSameMutation(order, { key: mutationKey, status })) {
      return res.json({ order, idempotent: true });
    }

    const transition = validateTransition({ current: order.orderStatus, next: status });
    if (transition.error) {
      return res.status(409).json({ error: transition.error });
    }

    if (["ready", "assigned", "completed"].includes(status)) {
      const verified = Boolean(order?.pharmacyVerification?.verified) || order.verificationStatus === "verified";
      const mustEnforceVerification = isTruthy(process.env.PHARMACY_ENFORCE_VERIFICATION);
      if (!verified && mustEnforceVerification) {
        return res.status(409).json({ error: "Prescription must be verified before progressing this order" });
      }
      if (mustEnforceVerification && status === "ready") {
        const providedNonce = String((req.body || {}).verificationNonce || "").trim();
        const expectedNonce = String(
          order?.pharmacyVerification?.verificationNonce || order?.verificationNonce || ""
        ).trim();
        const nonceAlreadyUsed =
          Boolean(order?.pharmacyVerification?.verificationNonceUsed) || Boolean(order?.verificationNonceUsed);
        const issuedAt =
          order?.pharmacyVerification?.verificationNonceIssuedAt || order?.verificationNonceIssuedAt || null;
        const issuedDate = toDate(issuedAt);
        const isExpired =
          !issuedDate || Date.now() - issuedDate.getTime() > NONCE_TTL_MINUTES * 60 * 1000;
        if (!expectedNonce || !providedNonce || providedNonce !== expectedNonce) {
          return res.status(409).json({ error: "Valid one-time verification nonce is required" });
        }
        if (nonceAlreadyUsed) {
          return res.status(409).json({ error: "Verification nonce already used. Re-verify prescription." });
        }
        if (isExpired) {
          return res.status(409).json({
            error: `Verification nonce expired. Re-verify prescription (TTL ${NONCE_TTL_MINUTES} min).`,
          });
        }
        if (order.pharmacyVerification) {
          order.pharmacyVerification.verificationNonceUsed = true;
          order.pharmacyVerification.verificationNonceUsedAt = new Date().toISOString();
        }
        order.verificationNonceUsed = true;
        order.verificationNonceUsedAt = new Date().toISOString();
      }
    }

    if (status === "ready" && !order.dispenseToken) {
      order.dispenseToken = randomToken();
      order.dispenseTokenIssuedAt = new Date().toISOString();
    }

    if (status === "ready" && String(order.deliveryOption || "").toLowerCase() === "delivery") {
      const currentDispatch = String(order.dispatchStatus || "").trim().toLowerCase();
      if (!currentDispatch || currentDispatch === "none") {
        order.dispatchStatus = "queued";
        order.dispatchQueuedAt = new Date().toISOString();
        const timeline = Array.isArray(order.dispatchTimeline) ? order.dispatchTimeline : [];
        timeline.push({
          id: `dsp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: "queued",
          at: new Date().toISOString(),
          actorUserId: req.user.id,
          meta: { source: "pharmacy_ready_transition" },
        });
        order.dispatchTimeline = timeline.slice(-100);
      }
    }

    if (status === "completed") {
      if (!order.dispenseToken) {
        return res.status(409).json({ error: "Dispense token not issued. Move order to ready first." });
      }
      const providedToken = String((req.body || {}).dispenseToken || "").trim().toUpperCase();
      if (!providedToken || providedToken !== String(order.dispenseToken).toUpperCase()) {
        return res.status(409).json({ error: "Valid dispense token is required to complete order" });
      }
      if (order.dispensedAt) {
        return res.status(409).json({ error: "Order has already been dispensed" });
      }
      order.dispensedAt = new Date().toISOString();
      order.dispensedBy = req.user.id;
    }

    if (status === "ready" && hasControlledDrug(order)) {
      const controlledChecklist = String((req.body || {}).controlledChecklist || "").trim();
      const usesOverride = Boolean((req.body || {}).useControlledOverride);
      if (!controlledChecklist && !usesOverride) {
        return res.status(400).json({
          error: "Controlled-drug checklist is required, or submit dual-sign controlled override",
        });
      }
      if (usesOverride) {
        const validation = await validateControlledOverride({ req, order });
        if (!validation.ok) {
          return res.status(400).json({ error: validation.error });
        }
        order.controlledOverride = validation.override;
      }
      if (controlledChecklist) order.controlledChecklist = controlledChecklist;
    }

    order.orderStatus = status;
    order.statusHistory = [
      ...(Array.isArray(order.statusHistory) ? order.statusHistory : []),
      {
        id: `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        status,
        at: new Date().toISOString(),
        by: req.user.id,
      },
    ].slice(-50);
    order.lastStatusMutation = {
      key: mutationKey || null,
      status,
      at: new Date().toISOString(),
      by: req.user.id,
    };
    await order.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.order.status",
      entityType: "order",
      entityId: order.id,
      metadata: {
        status,
        mutationKey: mutationKey || null,
      },
    });
    return res.json({ order });
  }
);

router.post(
  "/orders/:id/substitution",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    order.substitutionStatus = "pending_patient";
    order.substitutionItems = (req.body || {}).items || [];
    await order.save();
    return res.json({ order });
  }
);

router.post(
  "/interventions",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const body = req.body || {};
    if (!body.doctorId || !body.patientId || !body.interventionType) {
      return res
        .status(400)
        .json({ error: "doctorId, patientId, and interventionType are required" });
    }
    const intervention = await PharmacyIntervention.create({
      pharmacyId: req.user.id,
      doctorId: body.doctorId,
      patientId: body.patientId,
      orderId: body.orderId || null,
      interventionType: body.interventionType,
      details: body.details || null,
      suggestedAlternative: body.suggestedAlternative || null,
      severity: String(body.severity || "moderate").toLowerCase(),
      status: "pending",
    });
    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.intervention.create",
      entityType: "pharmacy_intervention",
      entityId: intervention.id,
    });
    return res.status(201).json({ intervention });
  }
);

router.get("/interventions", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const interventions = await PharmacyIntervention.findAll({ where: { pharmacyId: req.user.id } });
  interventions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ interventions });
});

router.get("/compliance-events", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const orders = await loadOwnedPharmacyOrders({ userId: req.user.id, pharmacyProfileId: profile?.id });
  const events = [];
  for (const order of orders) {
    events.push(...buildComplianceEventsForOrder(order));
  }
  events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const filtered = applyComplianceFilters(events, req.query || {});
  return res.json({ events: filtered.slice(0, 200), summary: summarizeComplianceEvents(filtered) });
});

router.get("/compliance-events/export.csv", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const orders = await loadOwnedPharmacyOrders({ userId: req.user.id, pharmacyProfileId: profile?.id });
  const events = [];
  for (const order of orders) {
    events.push(...buildComplianceEventsForOrder(order));
  }
  events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const filtered = applyComplianceFilters(events, req.query || {});
  const csv = complianceEventsToCsv(filtered, {
    pharmacyName: profile?.registeredName || req.user?.fullName || "",
    registrationCode: profile?.councilReg || "",
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="pharmacy-compliance-events-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  return res.status(200).send(csv);
});

router.post("/compliance-events/snapshots", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const orders = await loadOwnedPharmacyOrders({ userId: req.user.id, pharmacyProfileId: profile?.id });
  const events = [];
  for (const order of orders) {
    events.push(...buildComplianceEventsForOrder(order));
  }
  events.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  const filters = req.body?.filters || {};
  const filtered = applyComplianceFilters(events, filters);
  const summary = summarizeComplianceEvents(filtered);
  const sealedPayload = {
    generatedAt: new Date().toISOString(),
    generatedBy: req.user.id,
    filters,
    summary,
    events: filtered,
  };
  const checksum = crypto.createHash("sha256").update(JSON.stringify(sealedPayload)).digest("hex");
  const snapshot = await ComplianceReportSnapshot.create({
    pharmacyId: profile?.id || req.user.id,
    createdBy: req.user.id,
    label: String(req.body?.label || "Compliance Snapshot").trim(),
    immutable: true,
    checksum,
    ...sealedPayload,
  });
  const previousRows = await ComplianceReportSnapshot.findAll({});
  const previous = previousRows
    .filter(
      (entry) =>
        String(entry.pharmacyId || "") === String(profile?.id || req.user.id) &&
        String(entry.id || "") !== String(snapshot.id || "")
    )
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  const signature = createSnapshotSignature({
    snapshot,
    signerId: req.user.id,
    prevSignatureHash: previous?.signature?.signatureHash || null,
    signingKey: process.env.COMPLIANCE_SNAPSHOT_SIGNING_KEY,
  });
  snapshot.signature = signature;
  snapshot.signatureHash = signature.signatureHash;
  snapshot.signedBy = signature.signerId;
  snapshot.signedAt = signature.signedAt;
  snapshot.prevSignatureHash = signature.prevSignatureHash || null;
  await snapshot.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "pharmacy.compliance_snapshot.create",
    entityType: "compliance_snapshot",
    entityId: snapshot.id,
    metadata: {
      checksum,
      signatureHash: signature.signatureHash,
      prevSignatureHash: signature.prevSignatureHash || null,
      eventCount: filtered.length,
    },
  });
  return res.status(201).json({ snapshot });
});

router.get("/compliance-events/snapshots", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  const rows = await ComplianceReportSnapshot.findAll({});
  const snapshots = rows
    .filter((entry) => String(entry.pharmacyId || "") === String(profile?.id || req.user.id))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 80);
  return res.json({ snapshots });
});

router.get(
  "/compliance-events/snapshots/:id",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const snapshot = await ComplianceReportSnapshot.findByPk(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (String(snapshot.pharmacyId || "") !== String(profile?.id || req.user.id)) {
      return res.status(403).json({ error: "Not authorized for this snapshot" });
    }
    const rows = await ComplianceReportSnapshot.findAll({});
    const previous = rows
      .filter(
        (entry) =>
          String(entry.pharmacyId || "") === String(snapshot.pharmacyId || "") &&
          String(entry.id || "") !== String(snapshot.id || "") &&
          new Date(entry.createdAt || 0).getTime() < new Date(snapshot.createdAt || 0).getTime()
      )
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const validation = verifySnapshotRecord({
      snapshot,
      previousSnapshot: previous,
      signingKey: process.env.COMPLIANCE_SNAPSHOT_SIGNING_KEY,
    });
    return res.json({
      snapshot: {
        ...snapshot,
        ...validation,
      },
    });
  }
);

router.get(
  "/compliance-events/snapshots/:id/verify",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const snapshot = await ComplianceReportSnapshot.findByPk(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (String(snapshot.pharmacyId || "") !== String(profile?.id || req.user.id)) {
      return res.status(403).json({ error: "Not authorized for this snapshot" });
    }
    const rows = await ComplianceReportSnapshot.findAll({});
    const previous = rows
      .filter(
        (entry) =>
          String(entry.pharmacyId || "") === String(snapshot.pharmacyId || "") &&
          String(entry.id || "") !== String(snapshot.id || "") &&
          new Date(entry.createdAt || 0).getTime() < new Date(snapshot.createdAt || 0).getTime()
      )
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const validation = verifySnapshotRecord({
      snapshot,
      previousSnapshot: previous,
      signingKey: process.env.COMPLIANCE_SNAPSHOT_SIGNING_KEY,
    });
    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.compliance_snapshot.verify",
      entityType: "compliance_snapshot",
      entityId: snapshot.id,
      metadata: {
        integrityOk: validation.integrityOk,
        signatureOk: validation.signatureOk,
        chainOk: validation.chainOk,
        overallValid: validation.overallValid,
      },
    });
    return res.json({
      snapshotId: snapshot.id,
      integrityOk: validation.integrityOk,
      signatureOk: validation.signatureOk,
      chainOk: validation.chainOk,
      overallValid: validation.overallValid,
      checksum: snapshot.checksum || null,
      computedChecksum: validation.computedChecksum,
      expectedSignatureHash: validation.expectedSignatureHash,
      previousSignatureHash: validation.previousSignatureHash,
      verifiedAt: new Date().toISOString(),
    });
  }
);

router.get(
  "/compliance-events/snapshots/:id/export.csv",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const snapshot = await ComplianceReportSnapshot.findByPk(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (String(snapshot.pharmacyId || "") !== String(profile?.id || req.user.id)) {
      return res.status(403).json({ error: "Not authorized for this snapshot" });
    }
    const csv = complianceEventsToCsv(Array.isArray(snapshot.events) ? snapshot.events : [], {
      pharmacyName: profile?.registeredName || req.user?.fullName || "",
      registrationCode: profile?.councilReg || "",
      generatedAt: snapshot.createdAt || new Date().toISOString(),
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="compliance-snapshot-${snapshot.id}.csv"`
    );
    return res.status(200).send(csv);
  }
);

router.get(
  "/compliance-events/snapshots/:id/print",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const snapshot = await ComplianceReportSnapshot.findByPk(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (String(snapshot.pharmacyId || "") !== String(profile?.id || req.user.id)) {
      return res.status(403).json({ error: "Not authorized for this snapshot" });
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      renderComplianceSnapshotHtml(snapshot, {
        pharmacyName: profile?.registeredName || req.user?.fullName || "",
        registrationCode: profile?.councilReg || "",
      })
    );
  }
);

router.post(
  "/compliance-events/snapshots/:id/submit-moh",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const snapshot = await ComplianceReportSnapshot.findByPk(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (String(snapshot.pharmacyId || "") !== String(profile?.id || req.user.id)) {
      return res.status(403).json({ error: "Not authorized for this snapshot" });
    }

    const rows = await ComplianceReportSnapshot.findAll({});
    const previous = rows
      .filter(
        (entry) =>
          String(entry.pharmacyId || "") === String(snapshot.pharmacyId || "") &&
          String(entry.id || "") !== String(snapshot.id || "") &&
          new Date(entry.createdAt || 0).getTime() < new Date(snapshot.createdAt || 0).getTime()
      )
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const validation = verifySnapshotRecord({
      snapshot,
      previousSnapshot: previous,
      signingKey: process.env.COMPLIANCE_SNAPSHOT_SIGNING_KEY,
    });
    if (!validation.overallValid) {
      return res.status(409).json({
        error: "Snapshot failed cryptographic validation. Resolve integrity/signature/chain before MOH submission.",
      });
    }

    const evidence = sanitizeSnapshotEvidence(req.body?.evidence);

    snapshot.mohSubmission = {
      status: "submitted",
      submittedAt: new Date().toISOString(),
      submittedBy: req.user.id,
      submissionNote: String(req.body?.note || "").trim() || null,
      evidence,
      reviewedAt: null,
      reviewedBy: null,
      reviewDecision: null,
      reviewNote: null,
    };
    await snapshot.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.compliance_snapshot.submit_moh",
      entityType: "compliance_snapshot",
      entityId: snapshot.id,
      metadata: {
        status: snapshot.mohSubmission.status,
        evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
      },
    });
    return res.json({ snapshot });
  }
);

router.post(
  "/orders/:id/compliance-events/:eventId/ack",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
    const order = await Order.findByPk(req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }
    if (!ensureOrderOwnership({ order, userId: req.user.id, pharmacyProfileId: profile?.id })) {
      return res.status(403).json({ error: "Pharmacy is not authorized for this order" });
    }

    const eventId = String(req.params.eventId || "").trim();
    const events = buildComplianceEventsForOrder(order);
    const event = events.find((entry) => String(entry.id) === eventId);
    if (!event) {
      return res.status(404).json({ error: "Compliance event not found for order" });
    }

    const note = String(req.body?.note || "").trim();
    const ackMap = order.complianceEventAcks || {};
    ackMap[eventId] = {
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy: req.user.id,
      note: note || null,
    };
    order.complianceEventAcks = ackMap;
    await order.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.compliance_event.ack",
      entityType: "order",
      entityId: order.id,
      metadata: { eventId, note: note || null },
    });

    return res.json({
      event: {
        ...event,
        acknowledged: true,
        acknowledgedAt: ackMap[eventId].acknowledgedAt,
        acknowledgedBy: req.user.id,
        acknowledgedNote: note || null,
      },
    });
  }
);

router.post(
  "/interventions/:id/escalate",
  requireAuth,
  requireRoles(["pharmacy"]),
  async (req, res) => {
    const intervention = await PharmacyIntervention.findByPk(req.params.id);
    if (!intervention || String(intervention.pharmacyId || "") !== String(req.user.id)) {
      return res.status(404).json({ error: "Intervention not found" });
    }
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ error: "Escalation reason is required" });
    }
    const severity = String(req.body?.severity || intervention.severity || "high").toLowerCase();
    intervention.status = "pending_doctor_ack";
    intervention.severity = severity;
    intervention.escalationReason = reason;
    intervention.escalatedAt = new Date().toISOString();
    intervention.escalatedBy = req.user.id;
    await intervention.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "pharmacy.intervention.escalate",
      entityType: "pharmacy_intervention",
      entityId: intervention.id,
      metadata: { severity, reason },
    });
    return res.json({ intervention });
  }
);

router.get("/profile/me", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  if (!profile) return res.status(404).json({ error: "Profile not found" });
  return res.json({ profile });
});

module.exports = router;

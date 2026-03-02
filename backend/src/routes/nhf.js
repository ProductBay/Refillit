const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  NhfClaim,
  NhfPayoutRun,
  NhfDispute,
  NhfResolutionEvent,
  Appointment,
  Order,
  PharmacyProfile,
  Prescription,
  User,
} = require("../models");

const router = express.Router();

const toMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};

const toDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
const claimStatusAllowed = new Set(["submitted", "pending", "approved", "rejected"]);

const csvEscape = (value) => {
  const raw = String(value ?? "");
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
};

const parseCoverageConfig = ({ body = {}, defaults = {} } = {}) => {
  const baseAmount = Math.max(0, toMoney(body.baseAmount ?? defaults.baseAmount ?? 0));
  const coveragePercent = Math.max(
    0,
    Math.min(100, Number(body.coveragePercent ?? defaults.coveragePercent ?? 70))
  );
  const coverageCap = Math.max(0, toMoney(body.coverageCap ?? defaults.coverageCap ?? baseAmount));
  const deductible = Math.max(0, toMoney(body.deductible ?? defaults.deductible ?? 0));
  const alreadyPaid = Math.max(0, toMoney(body.alreadyPaid ?? defaults.alreadyPaid ?? 0));
  return { baseAmount, coveragePercent, coverageCap, deductible, alreadyPaid };
};

const computeNhfBreakdown = ({ baseAmount, coveragePercent, coverageCap, deductible, alreadyPaid }) => {
  const eligibleBeforeCap = toMoney(baseAmount * (coveragePercent / 100));
  const eligibleAfterCap = Math.min(coverageCap, eligibleBeforeCap);
  const nhfCoverage = Math.max(0, toMoney(eligibleAfterCap - deductible));
  const patientCopay = Math.max(0, toMoney(baseAmount - nhfCoverage));
  const remainingPatientBalance = Math.max(0, toMoney(patientCopay - alreadyPaid));
  return {
    eligibleBeforeCap,
    eligibleAfterCap: toMoney(eligibleAfterCap),
    nhfCoverage,
    patientCopay,
    remainingPatientBalance,
  };
};

const summarizeClaims = (claims) =>
  claims.reduce(
    (acc, entry) => {
      const claimStatus = String(entry.status || "").toLowerCase();
      acc.total += 1;
      acc.totalAmountCovered = toMoney(acc.totalAmountCovered + Number(entry.amountCovered || 0));
      if (claimStatus === "approved") {
        acc.approved += 1;
        acc.approvedAmount = toMoney(acc.approvedAmount + Number(entry.amountCovered || 0));
      } else if (claimStatus === "rejected") {
        acc.rejected += 1;
      } else if (claimStatus === "pending") {
        acc.pending += 1;
      } else if (claimStatus === "submitted") {
        acc.submitted += 1;
      }
      return acc;
    },
    {
      total: 0,
      submitted: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      totalAmountCovered: 0,
      approvedAmount: 0,
    }
  );

const inDateWindow = (value, { from, to }) => {
  const date = toDate(value);
  if (from && (!date || date < from)) return false;
  if (to && (!date || date > to)) return false;
  return true;
};

const allowedPayoutRunTransitions = {
  draft: new Set(["approved"]),
  approved: new Set(["paid"]),
  paid: new Set(["exported"]),
  exported: new Set([]),
};

const normalizePayoutRunStatus = (value) => {
  const status = String(value || "draft").trim().toLowerCase();
  return ["draft", "approved", "paid", "exported"].includes(status) ? status : "draft";
};

const NHF_ROLE_PERMISSIONS = {
  analyst: new Set(["claims.read", "calculator.use", "reconciliation.read", "exceptions.read"]),
  reviewer: new Set([
    "claims.read",
    "claims.update",
    "calculator.use",
    "reconciliation.read",
    "reconciliation.resolve",
    "exceptions.read",
    "exceptions.resolve",
    "disputes.read",
    "disputes.create",
    "disputes.update",
  ]),
  finance: new Set([
    "claims.read",
    "claims.export",
    "payouts.read",
    "payouts.runs.read",
    "payouts.runs.create",
    "payouts.runs.transition",
    "payouts.runs.export",
    "disputes.read",
  ]),
  supervisor: new Set([
    "claims.read",
    "claims.update",
    "claims.export",
    "calculator.use",
    "payouts.read",
    "payouts.runs.read",
    "payouts.runs.create",
    "payouts.runs.transition",
    "payouts.runs.export",
    "reconciliation.read",
    "reconciliation.resolve",
    "exceptions.read",
    "exceptions.resolve",
    "disputes.read",
    "disputes.create",
    "disputes.update",
    "dual_sign_approver",
  ]),
  auditor: new Set([
    "claims.read",
    "claims.export",
    "payouts.read",
    "payouts.runs.read",
    "payouts.runs.export",
    "reconciliation.read",
    "exceptions.read",
    "disputes.read",
    "dual_sign_approver",
  ]),
};

const normalizeNhfRole = (value) => {
  const role = String(value || "analyst").trim().toLowerCase();
  return NHF_ROLE_PERMISSIONS[role] ? role : "analyst";
};

const ensureNhfPermission = (req, res, permission) => {
  if (String(req.user?.role || "").toLowerCase() === "admin") return true;
  if (String(req.user?.role || "").toLowerCase() !== "nhf") {
    res.status(403).json({ error: "Forbidden: NHF access required" });
    return false;
  }
  const nhfRole = normalizeNhfRole(req.user?.nhfRole);
  const allowed = NHF_ROLE_PERMISSIONS[nhfRole];
  if (allowed?.has(permission)) return true;
  res.status(403).json({ error: `Forbidden: NHF role '${nhfRole}' lacks permission ${permission}` });
  return false;
};

const validateNhfSecondaryApproval = async ({ req, action }) => {
  const secondary = req.body?.secondaryApproval || null;
  if (!secondary) {
    return { ok: false, error: `secondaryApproval is required for ${action}` };
  }
  const secondarySignerId = String(secondary.secondarySignerId || "").trim();
  const note = String(secondary.note || "").trim();
  const authCode = String(secondary.secondaryAuthCode || "").trim();
  if (!secondarySignerId) return { ok: false, error: "secondarySignerId is required" };
  if (secondarySignerId === String(req.user.id || "")) {
    return { ok: false, error: "secondarySignerId must be a different NHF user" };
  }
  if (!/^\d{6}$/.test(authCode)) {
    return { ok: false, error: "secondaryAuthCode must be a 6-digit code" };
  }
  const expected = String(process.env.NHF_SECONDARY_AUTH_STUB_CODE || "654321").trim();
  if (authCode !== expected) {
    return { ok: false, error: "secondaryAuthCode verification failed" };
  }
  const signer = await User.findByPk(secondarySignerId);
  if (!signer) return { ok: false, error: "secondarySignerId not found" };
  const signerRole = String(signer.role || "").toLowerCase();
  if (!["nhf", "admin"].includes(signerRole)) {
    return { ok: false, error: "secondary signer must be NHF or admin" };
  }
  if (signerRole === "nhf") {
    const signerNhfRole = normalizeNhfRole(signer.nhfRole);
    if (!NHF_ROLE_PERMISSIONS[signerNhfRole]?.has("dual_sign_approver")) {
      return { ok: false, error: "secondary signer must be NHF supervisor/auditor" };
    }
  }
  return {
    ok: true,
    approval: {
      secondarySignerId,
      approvedAt: new Date().toISOString(),
      note: note || null,
    },
  };
};

const appendReviewNote = (claim, note) => {
  const next = String(note || "").trim();
  if (!next) return claim.reviewNote || null;
  const current = String(claim.reviewNote || "").trim();
  if (!current) return next;
  return `${current}\n${next}`;
};

const createDisputeRecord = async ({
  claimId = null,
  payoutRunId = null,
  reason,
  notes = null,
  createdBy = null,
  assigneeId = null,
}) => {
  return NhfDispute.create({
    claimId: claimId || null,
    payoutRunId: payoutRunId || null,
    reason: String(reason || "").trim(),
    status: "open",
    createdBy: createdBy || null,
    assigneeId: assigneeId || null,
    notes: notes ? String(notes).trim() : null,
  });
};

const buildReconciliationRowKey = ({ type, entityType, entityId, claimId }) =>
  ["reconciliation", String(type || ""), String(entityType || ""), String(entityId || ""), String(claimId || "")]
    .join("|");

const buildExceptionRowKey = ({ type, claimId, appointmentId, orderId, claimIds = [] }) =>
  [
    "exceptions",
    String(type || ""),
    String(claimId || ""),
    String(appointmentId || ""),
    String(orderId || ""),
    Array.isArray(claimIds) ? claimIds.map((entry) => String(entry || "")).sort().join(";") : "",
  ].join("|");

const attachResolutionHistory = ({ rows, scope }) => {
  const eventsByKey = new Map();
  return NhfResolutionEvent.findAll({})
    .then((events) => {
      for (const event of events) {
        if (String(event.scope || "") !== scope) continue;
        const key = String(event.rowKey || "");
        if (!eventsByKey.has(key)) eventsByKey.set(key, []);
        eventsByKey.get(key).push(event);
      }
      for (const [key, list] of eventsByKey.entries()) {
        list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        eventsByKey.set(key, list.slice(0, 10));
      }
      return rows.map((row) => {
        const key = scope === "reconciliation"
          ? buildReconciliationRowKey(row)
          : buildExceptionRowKey(row);
        return {
          ...row,
          rowKey: key,
          resolutionHistory: eventsByKey.get(key) || [],
        };
      });
    });
};

const logResolutionEvent = async ({
  scope,
  rowKey,
  type,
  entityType,
  entityId,
  claimId,
  appointmentId,
  orderId,
  claimIds,
  action,
  outcome,
  metadata,
  req,
}) => {
  const secondarySignerId = req?.body?.secondaryApproval?.secondarySignerId || null;
  return NhfResolutionEvent.create({
    scope,
    rowKey,
    type: type || null,
    entityType: entityType || null,
    entityId: entityId || null,
    claimId: claimId || null,
    appointmentId: appointmentId || null,
    orderId: orderId || null,
    claimIds: Array.isArray(claimIds) ? claimIds : [],
    action: action || null,
    outcome: outcome || "completed",
    metadata: metadata || null,
    actorUserId: req?.user?.id || null,
    actorRole: req?.user?.role || null,
    actorNhfRole: req?.user?.nhfRole || null,
    secondarySignerId,
    resolvedAt: new Date().toISOString(),
  });
};

const enrichClaims = async (claims) => {
  const patientIds = Array.from(new Set(claims.map((entry) => String(entry.patientId || "")).filter(Boolean)));
  const prescIds = Array.from(new Set(claims.map((entry) => String(entry.prescId || "")).filter(Boolean)));
  const orderIds = Array.from(new Set(claims.map((entry) => String(entry.orderId || "")).filter(Boolean)));

  const patientMap = new Map();
  const prescriptionMap = new Map();
  const orderMap = new Map();

  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(patientId, patient);
  }
  for (const prescId of prescIds) {
    // eslint-disable-next-line no-await-in-loop
    const prescription = await Prescription.findByPk(prescId);
    if (prescription) prescriptionMap.set(prescId, prescription);
  }
  for (const orderId of orderIds) {
    // eslint-disable-next-line no-await-in-loop
    const order = await Order.findByPk(orderId);
    if (order) orderMap.set(orderId, order);
  }

  return claims.map((entry) => {
    const patient = patientMap.get(String(entry.patientId || ""));
    const prescription = prescriptionMap.get(String(entry.prescId || ""));
    const order = orderMap.get(String(entry.orderId || ""));
    return {
      ...entry,
      patientName: patient?.fullName || null,
      patientEmail: patient?.email || null,
      doctorId: entry.doctorId || prescription?.doctorId || order?.prescriptionSnapshot?.doctorId || null,
      pharmacyId: entry.pharmacyId || order?.pharmacyId || null,
      orderStatus: order?.orderStatus || null,
    };
  });
};

const ensureOrderOwnedByPharmacy = ({ order, userId, pharmacyProfileId }) => {
  const pharmacyId = String(order?.pharmacyId || "");
  if (!pharmacyId) return true;
  if (pharmacyId === String(userId || "")) return true;
  if (pharmacyProfileId && pharmacyId === String(pharmacyProfileId)) return true;
  return false;
};

const inferOrderBaseAmount = (order) => {
  const paymentAmount = Number(order?.payment?.amount || order?.paymentAmount || 0);
  if (Number.isFinite(paymentAmount) && paymentAmount > 0) return toMoney(paymentAmount);
  const meds = Array.isArray(order?.prescriptionSnapshot?.meds) ? order.prescriptionSnapshot.meds : [];
  const estimated = meds.reduce((sum, med) => sum + Math.max(0, Number(med?.qty || 0)) * 500, 0);
  return toMoney(estimated);
};

const applyClaimFilters = ({ claims, query = {} }) => {
  const status = String(query.status || "").trim().toLowerCase();
  const patientId = String(query.patientId || "").trim();
  const prescId = String(query.prescId || "").trim();
  const orderId = String(query.orderId || "").trim();
  const search = String(query.query || "").trim().toLowerCase();
  const from = toDate(query.from);
  const to = toDate(query.to);

  return claims
    .filter((entry) => (status ? String(entry.status || "").toLowerCase() === status : true))
    .filter((entry) => (patientId ? String(entry.patientId || "") === patientId : true))
    .filter((entry) => (prescId ? String(entry.prescId || "") === prescId : true))
    .filter((entry) => (orderId ? String(entry.orderId || "") === orderId : true))
    .filter((entry) => {
      const created = toDate(entry.createdAt);
      if (from && (!created || created < from)) return false;
      if (to && (!created || created > to)) return false;
      if (!search) return true;
      const haystack = [
        entry.id,
        entry.patientId,
        entry.patientName,
        entry.patientEmail,
        entry.patientNhfId,
        entry.prescId,
        entry.orderId,
        entry.status,
        entry.doctorId,
        entry.pharmacyId,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    })
    .sort(byNewest);
};

const resolveSuggestionForExceptionType = (type) => {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "high_or_invalid_amount") return "cap_to_base_amount";
  if (normalized === "missing_patient_nhf_id") return "mark_pending_provider_update";
  if (normalized === "stale_claim") return "escalate_pending_review";
  return null;
};

const computeExceptionRows = ({ claims, nowMs = Date.now() }) => {
  const exceptions = [];
  const byAppointment = new Map();
  const byOrder = new Map();

  for (const claim of claims) {
    const appointmentId = String(claim.appointmentId || "");
    const orderId = String(claim.orderId || "");
    if (appointmentId) {
      if (!byAppointment.has(appointmentId)) byAppointment.set(appointmentId, []);
      byAppointment.get(appointmentId).push(claim);
    }
    if (orderId) {
      if (!byOrder.has(orderId)) byOrder.set(orderId, []);
      byOrder.get(orderId).push(claim);
    }

    const covered = toMoney(claim.amountCovered || 0);
    const baseAmount = toMoney(claim?.calculationSnapshot?.baseAmount || 0);
    if (covered > 60000 || (baseAmount > 0 && covered > baseAmount)) {
      exceptions.push({
        type: "high_or_invalid_amount",
        severity: covered > 60000 ? "high" : "critical",
        claimId: claim.id,
        details: `Covered amount ${covered} is outside expected range`,
      });
    }
    if (!claim.patientNhfId) {
      exceptions.push({
        type: "missing_patient_nhf_id",
        severity: "moderate",
        claimId: claim.id,
        details: "Claim is missing patient NHF ID",
      });
    }
    const ageDays = Math.floor((nowMs - new Date(claim.createdAt || nowMs).getTime()) / (1000 * 60 * 60 * 24));
    if (["submitted", "pending"].includes(String(claim.status || "").toLowerCase()) && ageDays >= 3) {
      exceptions.push({
        type: "stale_claim",
        severity: ageDays >= 7 ? "high" : "moderate",
        claimId: claim.id,
        details: `Claim has stayed ${claim.status} for ${ageDays} days`,
      });
    }
  }

  for (const [appointmentId, items] of byAppointment.entries()) {
    if (items.length <= 1) continue;
    exceptions.push({
      type: "duplicate_appointment_claims",
      severity: "high",
      appointmentId,
      claimIds: items.map((entry) => entry.id),
      details: `Found ${items.length} claims linked to one appointment`,
    });
  }
  for (const [orderId, items] of byOrder.entries()) {
    if (items.length <= 1) continue;
    exceptions.push({
      type: "duplicate_order_claims",
      severity: "high",
      orderId,
      claimIds: items.map((entry) => entry.id),
      details: `Found ${items.length} claims linked to one order`,
    });
  }

  const summary = {
    total: exceptions.length,
    critical: exceptions.filter((entry) => entry.severity === "critical").length,
    high: exceptions.filter((entry) => entry.severity === "high").length,
    moderate: exceptions.filter((entry) => entry.severity === "moderate").length,
    low: exceptions.filter((entry) => entry.severity === "low").length,
  };
  return { exceptions, summary };
};

const buildPayoutSummary = async ({ from = null, to = null } = {}) => {
  const appointments = await Appointment.findAll({});
  const claims = await NhfClaim.findAll({});
  const orders = await Order.findAll({});
  const users = await User.findAll({});
  const pharmacyProfiles = await PharmacyProfile.findAll({});

  const usersById = new Map(users.map((entry) => [String(entry.id), entry]));
  const pharmacyProfileByUserId = new Map(
    pharmacyProfiles.map((entry) => [String(entry.userId), entry])
  );
  const orderById = new Map(orders.map((entry) => [String(entry.id), entry]));

  const doctorSummaryById = new Map();
  for (const appointment of appointments) {
    if (!inDateWindow(appointment.createdAt, { from, to })) continue;
    const doctorId = String(appointment.doctorId || "");
    if (!doctorId) continue;
    if (!doctorSummaryById.has(doctorId)) {
      doctorSummaryById.set(doctorId, {
        doctorId,
        doctorName: usersById.get(doctorId)?.fullName || null,
        totalAppointments: 0,
        grossFee: 0,
        nhfDeduction: 0,
        patientPaid: 0,
        patientBalance: 0,
      });
    }
    const row = doctorSummaryById.get(doctorId);
    const grossFee = toMoney(appointment.feeAmount || 0);
    const nhfDeduction = toMoney(appointment.nhfDeductionAmount || 0);
    const patientPaid = toMoney(appointment.paymentCollectedAmount || 0);
    const balance = Math.max(0, toMoney(grossFee - nhfDeduction - patientPaid));

    row.totalAppointments += 1;
    row.grossFee = toMoney(row.grossFee + grossFee);
    row.nhfDeduction = toMoney(row.nhfDeduction + nhfDeduction);
    row.patientPaid = toMoney(row.patientPaid + patientPaid);
    row.patientBalance = toMoney(row.patientBalance + balance);
  }

  const pharmacySummaryById = new Map();
  for (const claim of claims) {
    if (!inDateWindow(claim.createdAt, { from, to })) continue;
    const claimStatus = String(claim.status || "").toLowerCase();
    if (claimStatus !== "approved") continue;
    const order = orderById.get(String(claim.orderId || ""));
    const pharmacyId = String(claim.pharmacyId || order?.pharmacyId || "");
    if (!pharmacyId) continue;
    if (!pharmacySummaryById.has(pharmacyId)) {
      const profile = pharmacyProfileByUserId.get(pharmacyId);
      pharmacySummaryById.set(pharmacyId, {
        pharmacyId,
        pharmacyName: profile?.registeredName || usersById.get(pharmacyId)?.fullName || null,
        approvedClaims: 0,
        approvedAmountCovered: 0,
      });
    }
    const row = pharmacySummaryById.get(pharmacyId);
    row.approvedClaims += 1;
    row.approvedAmountCovered = toMoney(row.approvedAmountCovered + Number(claim.amountCovered || 0));
  }

  const doctorPayouts = Array.from(doctorSummaryById.values()).sort(
    (a, b) => b.nhfDeduction - a.nhfDeduction
  );
  const pharmacyPayouts = Array.from(pharmacySummaryById.values()).sort(
    (a, b) => b.approvedAmountCovered - a.approvedAmountCovered
  );

  const totals = {
    doctorNhfDeduction: toMoney(doctorPayouts.reduce((sum, row) => sum + row.nhfDeduction, 0)),
    doctorGrossFee: toMoney(doctorPayouts.reduce((sum, row) => sum + row.grossFee, 0)),
    pharmacyApprovedAmountCovered: toMoney(
      pharmacyPayouts.reduce((sum, row) => sum + row.approvedAmountCovered, 0)
    ),
  };

  return { totals, doctorPayouts, pharmacyPayouts };
};

router.post("/claims", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const claim = await NhfClaim.create({
    patientId: req.user.id,
    prescId: req.body?.prescId || null,
    orderId: req.body?.orderId || null,
    patientNhfId: req.body?.patientNhfId || null,
    amountCovered: Number(req.body?.amountCovered || 0),
    status: "submitted",
  });
  res.status(201).json({ claim });
});

router.post("/claims/doctor-submit", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const appointmentId = String(req.body?.appointmentId || "").trim();
  if (!appointmentId) return res.status(400).json({ error: "appointmentId is required" });

  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) return res.status(404).json({ error: "Appointment not found" });
  if (String(appointment.doctorId || "") !== String(req.user.id || "")) {
    return res.status(403).json({ error: "Doctor is not authorized for this appointment" });
  }

  const existingClaims = await NhfClaim.findAll({});
  const existing = existingClaims
    .filter(
      (entry) =>
        String(entry.appointmentId || "") === appointmentId &&
        String(entry.sourceRole || "").toLowerCase() === "doctor" &&
        String(entry.status || "").toLowerCase() !== "rejected"
    )
    .sort(byNewest)[0];
  if (existing) return res.status(200).json({ claim: existing, idempotent: true });

  const defaults = {
    baseAmount: toMoney(appointment.feeAmount || 0),
    deductible: 0,
    alreadyPaid: toMoney(appointment.paymentCollectedAmount || 0),
    coveragePercent: Number(appointment.nhfDeductionAmount || 0) > 0 ? 100 : 70,
    coverageCap:
      Number(appointment.nhfDeductionAmount || 0) > 0
        ? toMoney(appointment.nhfDeductionAmount || 0)
        : toMoney(appointment.feeAmount || 0),
  };
  const coverage = parseCoverageConfig({ body: req.body || {}, defaults });
  const breakdown = computeNhfBreakdown(coverage);
  const amountCovered = Number(appointment.nhfDeductionAmount || 0) > 0
    ? toMoney(appointment.nhfDeductionAmount || 0)
    : breakdown.nhfCoverage;

  const claim = await NhfClaim.create({
    patientId: appointment.patientId || null,
    prescId: req.body?.prescId || null,
    orderId: req.body?.orderId || null,
    appointmentId: appointment.id,
    doctorId: appointment.doctorId || req.user.id,
    patientNhfId: req.body?.patientNhfId || null,
    amountCovered,
    status: "submitted",
    sourceRole: "doctor",
    sourceUserId: req.user.id,
    calculationSnapshot: {
      ...coverage,
      ...breakdown,
      createdAt: new Date().toISOString(),
      source: "doctor_submission",
    },
  });

  return res.status(201).json({ claim });
});

router.post("/claims/pharmacy-submit", requireAuth, requireRoles(["pharmacy"]), async (req, res) => {
  const orderId = String(req.body?.orderId || "").trim();
  if (!orderId) return res.status(400).json({ error: "orderId is required" });

  const order = await Order.findByPk(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  const profile = await PharmacyProfile.findOne({ where: { userId: req.user.id } });
  if (!ensureOrderOwnedByPharmacy({ order, userId: req.user.id, pharmacyProfileId: profile?.id })) {
    return res.status(403).json({ error: "Pharmacy is not authorized for this order" });
  }

  const existingClaims = await NhfClaim.findAll({});
  const existing = existingClaims
    .filter(
      (entry) =>
        String(entry.orderId || "") === orderId &&
        String(entry.sourceRole || "").toLowerCase() === "pharmacy" &&
        String(entry.status || "").toLowerCase() !== "rejected"
    )
    .sort(byNewest)[0];
  if (existing) return res.status(200).json({ claim: existing, idempotent: true });

  const inferredBase = inferOrderBaseAmount(order);
  if (inferredBase <= 0 && Number(req.body?.baseAmount || 0) <= 0) {
    return res.status(400).json({ error: "baseAmount is required when order has no billable estimate" });
  }
  const coverage = parseCoverageConfig({
    body: req.body || {},
    defaults: {
      baseAmount: inferredBase,
      coveragePercent: 70,
      coverageCap: inferredBase,
      deductible: 0,
      alreadyPaid: 0,
    },
  });
  const breakdown = computeNhfBreakdown(coverage);

  const claim = await NhfClaim.create({
    patientId: order.patientId || null,
    prescId: order.prescId || null,
    orderId: order.id,
    doctorId: order?.prescriptionSnapshot?.doctorId || null,
    pharmacyId: order.pharmacyId || req.user.id,
    patientNhfId: req.body?.patientNhfId || null,
    amountCovered: breakdown.nhfCoverage,
    status: "submitted",
    sourceRole: "pharmacy",
    sourceUserId: req.user.id,
    calculationSnapshot: {
      ...coverage,
      ...breakdown,
      createdAt: new Date().toISOString(),
      source: "pharmacy_submission",
    },
  });

  return res.status(201).json({ claim });
});

router.get("/claims", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "claims.read")) return;
  const limit = Math.max(1, Math.min(300, Number(req.query.limit || 120)));

  const all = await NhfClaim.findAll({});
  const enriched = await enrichClaims(all);
  const filtered = applyClaimFilters({ claims: enriched, query: req.query || {} });
  const summary = summarizeClaims(filtered);

  return res.json({ claims: filtered.slice(0, limit), summary });
});

router.get("/claims/export.csv", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "claims.export")) return;
  const all = await NhfClaim.findAll({});
  const enriched = await enrichClaims(all);
  const filtered = applyClaimFilters({ claims: enriched, query: req.query || {} });
  const summary = summarizeClaims(filtered);

  const meta = [
    ["generated_at", new Date().toISOString()],
    ["generated_by", req.user.id],
    ["total_claims", summary.total],
    ["approved_claims", summary.approved],
    ["approved_amount", summary.approvedAmount],
    [],
  ];
  const header = [
    "claim_id",
    "status",
    "amount_covered",
    "patient_id",
    "patient_name",
    "patient_nhf_id",
    "doctor_id",
    "pharmacy_id",
    "appointment_id",
    "prescription_id",
    "order_id",
    "source_role",
    "created_at",
    "reviewed_at",
  ];
  const rows = filtered.map((entry) => [
    entry.id,
    entry.status,
    toMoney(entry.amountCovered || 0),
    entry.patientId || "",
    entry.patientName || "",
    entry.patientNhfId || "",
    entry.doctorId || "",
    entry.pharmacyId || "",
    entry.appointmentId || "",
    entry.prescId || "",
    entry.orderId || "",
    entry.sourceRole || "",
    entry.createdAt || "",
    entry.reviewedAt || "",
  ]);
  const csv = [...meta, header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="nhf-claims-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  return res.status(200).send(csv);
});

router.patch("/claims/:id", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "claims.update")) return;
  const claim = await NhfClaim.findByPk(req.params.id);
  if (!claim) return res.status(404).json({ error: "Claim not found" });

  const nextStatus = String(req.body?.status || "").trim().toLowerCase();
  if (nextStatus && !claimStatusAllowed.has(nextStatus)) {
    return res.status(400).json({ error: "status must be submitted, pending, approved, or rejected" });
  }

  if (nextStatus) claim.status = nextStatus;
  const needsDualSign =
    ["approved", "rejected"].includes(nextStatus)
    || Object.prototype.hasOwnProperty.call(req.body || {}, "amountCovered");
  if (needsDualSign) {
    const validation = await validateNhfSecondaryApproval({ req, action: "claim adjudication/update" });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    claim.secondaryApproval = validation.approval;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "amountCovered")) {
    claim.amountCovered = toMoney(req.body?.amountCovered || 0);
  }
  claim.reviewNote = String(req.body?.reviewNote || "").trim() || claim.reviewNote || null;
  claim.reviewedAt = new Date().toISOString();
  claim.reviewedBy = req.user.id;
  await claim.save();

  return res.json({ claim });
});

router.post("/calculator/preview", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "calculator.use")) return;
  const appointmentId = String(req.body?.appointmentId || "").trim();
  let baseAmount = toMoney(req.body?.baseAmount || 0);
  let appointment = null;

  if (appointmentId) {
    appointment = await Appointment.findByPk(appointmentId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    if (baseAmount <= 0) {
      baseAmount = toMoney(appointment.feeAmount || 0);
    }
  }

  const coverage = parseCoverageConfig({
    body: req.body || {},
    defaults: { baseAmount, coveragePercent: 70, coverageCap: baseAmount, deductible: 0, alreadyPaid: 0 },
  });
  const doctorSharePercent = Math.max(0, Math.min(100, Number(req.body?.doctorSharePercent ?? 100)));
  const pharmacySharePercent = Math.max(0, Math.min(100, Number(req.body?.pharmacySharePercent ?? 100)));
  const breakdown = computeNhfBreakdown(coverage);
  const nhfCoverage = breakdown.nhfCoverage;
  const doctorPayout = toMoney(nhfCoverage * (doctorSharePercent / 100));
  const pharmacyPayout = toMoney(nhfCoverage * (pharmacySharePercent / 100));

  return res.json({
    inputs: {
      appointmentId: appointment?.id || null,
      ...coverage,
      doctorSharePercent,
      pharmacySharePercent,
    },
    breakdown: {
      ...breakdown,
      doctorPayout,
      pharmacyPayout,
    },
  });
});

router.get("/payouts/summary", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "payouts.read")) return;
  const from = toDate(req.query.from);
  const to = toDate(req.query.to);
  const summary = await buildPayoutSummary({ from, to });
  return res.json(summary);
});

router.get("/reconciliation", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "reconciliation.read")) return;
  const from = toDate(req.query.from);
  const to = toDate(req.query.to);
  const claims = await NhfClaim.findAll({});
  const appointments = await Appointment.findAll({});
  const orders = await Order.findAll({});

  const claimsByAppointmentId = new Map();
  const claimsByOrderId = new Map();
  for (const claim of claims) {
    if (!inDateWindow(claim.createdAt, { from, to })) continue;
    const appointmentId = String(claim.appointmentId || "");
    const orderId = String(claim.orderId || "");
    if (appointmentId) {
      if (!claimsByAppointmentId.has(appointmentId)) claimsByAppointmentId.set(appointmentId, []);
      claimsByAppointmentId.get(appointmentId).push(claim);
    }
    if (orderId) {
      if (!claimsByOrderId.has(orderId)) claimsByOrderId.set(orderId, []);
      claimsByOrderId.get(orderId).push(claim);
    }
  }

  const rows = [];
  for (const appointment of appointments) {
    if (!inDateWindow(appointment.createdAt, { from, to })) continue;
    const expected = toMoney(appointment.nhfDeductionAmount || 0);
    if (expected <= 0) continue;
    const linked = claimsByAppointmentId.get(String(appointment.id || "")) || [];
    if (!linked.length) {
      rows.push({
        type: "missing_claim",
        entityType: "appointment",
        entityId: appointment.id,
        expectedAmount: expected,
        actualAmount: 0,
        variance: toMoney(expected),
        reason: "Appointment has NHF deduction but no linked NHF claim",
      });
      continue;
    }
    for (const claim of linked) {
      const actual = toMoney(claim.amountCovered || 0);
      const variance = toMoney(expected - actual);
      if (Math.abs(variance) > 0.01) {
        rows.push({
          type: "amount_mismatch",
          entityType: "appointment",
          entityId: appointment.id,
          claimId: claim.id,
          expectedAmount: expected,
          actualAmount: actual,
          variance,
          reason: "Claim amount does not match appointment NHF deduction",
        });
      }
    }
  }

  for (const claim of claims) {
    if (!inDateWindow(claim.createdAt, { from, to })) continue;
    const orderId = String(claim.orderId || "");
    if (!orderId) continue;
    const order = orders.find((entry) => String(entry.id || "") === orderId);
    if (!order) {
      rows.push({
        type: "missing_order",
        entityType: "claim",
        entityId: claim.id,
        expectedAmount: null,
        actualAmount: toMoney(claim.amountCovered || 0),
        variance: null,
        reason: "Claim references order that no longer exists",
      });
    }
  }

  const summary = {
    total: rows.length,
    missingClaim: rows.filter((entry) => entry.type === "missing_claim").length,
    amountMismatch: rows.filter((entry) => entry.type === "amount_mismatch").length,
    missingOrder: rows.filter((entry) => entry.type === "missing_order").length,
  };
  const limitedRows = rows.slice(0, 300);
  const withHistory = await attachResolutionHistory({ rows: limitedRows, scope: "reconciliation" });
  return res.json({ summary, rows: withHistory });
});

router.get("/exceptions", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "exceptions.read")) return;
  const claims = await NhfClaim.findAll({});
  const { exceptions, summary } = computeExceptionRows({ claims, nowMs: Date.now() });
  const limited = exceptions.slice(0, 400);
  const withHistory = await attachResolutionHistory({ rows: limited, scope: "exceptions" });
  return res.json({ summary, exceptions: withHistory });
});

router.get("/sla-queue", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "claims.read")) return;
  if (!ensureNhfPermission(req, res, "exceptions.read")) return;
  if (!ensureNhfPermission(req, res, "disputes.read")) return;

  const nowMs = Date.now();
  const claims = await NhfClaim.findAll({});
  const disputes = await NhfDispute.findAll({});
  const enrichedClaims = await enrichClaims(claims);
  const pendingClaims = enrichedClaims
    .filter((entry) => ["submitted", "pending"].includes(String(entry.status || "").toLowerCase()))
    .map((entry) => {
      const createdMs = new Date(entry.createdAt || nowMs).getTime();
      const ageHoursRaw = (nowMs - createdMs) / (1000 * 60 * 60);
      const ageHours = Number.isFinite(ageHoursRaw) ? Math.max(0, ageHoursRaw) : 0;
      return {
        claimId: entry.id,
        status: entry.status,
        patientName: entry.patientName || entry.patientId || null,
        createdAt: entry.createdAt || null,
        ageHours: Number(ageHours.toFixed(1)),
      };
    })
    .sort((a, b) => b.ageHours - a.ageHours);

  const bucketForAge = (hours) => {
    if (hours < 24) return "under_24h";
    if (hours < 48) return "from_24_to_48h";
    return "over_48h";
  };
  const bucketsMap = new Map([
    ["under_24h", { bucket: "under_24h", label: "< 24h", count: 0 }],
    ["from_24_to_48h", { bucket: "from_24_to_48h", label: "24h - 48h", count: 0 }],
    ["over_48h", { bucket: "over_48h", label: "> 48h", count: 0 }],
  ]);
  for (const entry of pendingClaims) {
    const key = bucketForAge(entry.ageHours);
    const bucket = bucketsMap.get(key);
    bucket.count += 1;
  }

  const { exceptions, summary: exceptionSummary } = computeExceptionRows({ claims, nowMs });
  const exceptionHotlist = exceptions
    .map((entry) => ({
      ...entry,
      suggestedResolution: resolveSuggestionForExceptionType(entry.type),
    }))
    .filter((entry) => entry.claimId)
    .sort((a, b) => {
      const rank = { critical: 3, high: 2, moderate: 1, low: 0 };
      const delta = (rank[String(b.severity || "").toLowerCase()] || 0)
        - (rank[String(a.severity || "").toLowerCase()] || 0);
      if (delta !== 0) return delta;
      return String(a.type || "").localeCompare(String(b.type || ""));
    })
    .slice(0, 80);

  const openDisputes = disputes
    .filter((entry) => String(entry.status || "").toLowerCase() === "open")
    .sort(byNewest)
    .slice(0, 80)
    .map((entry) => ({
      id: entry.id,
      claimId: entry.claimId || null,
      reason: entry.reason || null,
      createdAt: entry.createdAt || null,
    }));

  return res.json({
    summary: {
      pendingClaims: pendingClaims.length,
      exceptionTotal: exceptionSummary.total,
      openDisputes: openDisputes.length,
      overdue24h: (bucketsMap.get("from_24_to_48h")?.count || 0) + (bucketsMap.get("over_48h")?.count || 0),
      overdue48h: bucketsMap.get("over_48h")?.count || 0,
      criticalExceptions: exceptionSummary.critical || 0,
    },
    buckets: Array.from(bucketsMap.values()),
    overdueClaims: pendingClaims.slice(0, 120),
    exceptionHotlist,
    openDisputes,
  });
});

router.post("/claims/bulk-update", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "claims.update")) return;
  const claimIds = Array.isArray(req.body?.claimIds)
    ? req.body.claimIds.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (!claimIds.length) return res.status(400).json({ error: "claimIds is required" });
  if (claimIds.length > 150) {
    return res.status(400).json({ error: "claimIds cannot exceed 150 per request" });
  }

  const nextStatus = String(req.body?.status || "").trim().toLowerCase();
  const hasStatus = Boolean(nextStatus);
  const hasAmount = Object.prototype.hasOwnProperty.call(req.body || {}, "amountCovered");
  if (!hasStatus && !hasAmount) {
    return res.status(400).json({ error: "At least one of status or amountCovered is required" });
  }
  if (hasStatus && !claimStatusAllowed.has(nextStatus)) {
    return res.status(400).json({ error: "status must be submitted, pending, approved, or rejected" });
  }
  const reviewNote = String(req.body?.reviewNote || "").trim();

  const needsDualSign = (hasStatus && ["approved", "rejected"].includes(nextStatus)) || hasAmount;
  if (needsDualSign) {
    const validation = await validateNhfSecondaryApproval({ req, action: "claims_bulk_update" });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }

  const updated = [];
  const missing = [];
  for (const claimId of claimIds) {
    // eslint-disable-next-line no-await-in-loop
    const claim = await NhfClaim.findByPk(claimId);
    if (!claim) {
      missing.push(claimId);
      continue;
    }
    if (hasStatus) claim.status = nextStatus;
    if (hasAmount) claim.amountCovered = toMoney(req.body?.amountCovered || 0);
    if (needsDualSign) {
      claim.secondaryApproval = {
        secondarySignerId: String(req.body?.secondaryApproval?.secondarySignerId || "").trim() || null,
        approvedAt: new Date().toISOString(),
        note: String(req.body?.secondaryApproval?.note || "").trim() || null,
      };
    }
    claim.reviewedAt = new Date().toISOString();
    claim.reviewedBy = req.user.id;
    if (reviewNote) claim.reviewNote = appendReviewNote(claim, reviewNote);
    // eslint-disable-next-line no-await-in-loop
    await claim.save();
    updated.push(claim.id);
  }

  return res.json({
    updatedCount: updated.length,
    missingCount: missing.length,
    updatedClaimIds: updated,
    missingClaimIds: missing,
  });
});

router.post("/exceptions/bulk-resolve", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "exceptions.resolve")) return;
  const type = String(req.body?.type || "").trim().toLowerCase();
  const resolution = String(req.body?.resolution || "").trim().toLowerCase();
  const claimIds = Array.isArray(req.body?.claimIds)
    ? req.body.claimIds.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (!type || !resolution) return res.status(400).json({ error: "type and resolution are required" });
  if (!claimIds.length) return res.status(400).json({ error: "claimIds is required" });
  if (claimIds.length > 150) return res.status(400).json({ error: "claimIds cannot exceed 150 per request" });

  const allowedByType = {
    high_or_invalid_amount: new Set(["cap_to_base_amount"]),
    missing_patient_nhf_id: new Set(["mark_pending_provider_update"]),
    stale_claim: new Set(["escalate_pending_review"]),
  };
  if (!allowedByType[type]?.has(resolution)) {
    return res.status(400).json({ error: `Unsupported bulk exception action for type ${type}` });
  }
  if (["cap_to_base_amount"].includes(resolution)) {
    const validation = await validateNhfSecondaryApproval({ req, action: `exceptions_bulk:${resolution}` });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }
  const reviewNote = String(req.body?.reviewNote || "").trim();
  const updated = [];
  const missing = [];
  const failed = [];
  for (const claimId of claimIds) {
    // eslint-disable-next-line no-await-in-loop
    const claim = await NhfClaim.findByPk(claimId);
    if (!claim) {
      missing.push(claimId);
      continue;
    }

    if (type === "high_or_invalid_amount" && resolution === "cap_to_base_amount") {
      const baseAmount = toMoney(claim?.calculationSnapshot?.baseAmount || claim.amountCovered || 0);
      claim.amountCovered = Math.min(toMoney(claim.amountCovered || 0), baseAmount);
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Bulk auto-resolved high/invalid amount by capping to calculation base amount"
      );
      // eslint-disable-next-line no-await-in-loop
      await claim.save();
      // eslint-disable-next-line no-await-in-loop
      await logResolutionEvent({
        scope: "exceptions",
        rowKey: buildExceptionRowKey({ type, claimId: claim.id }),
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "capped_amount",
        metadata: { bulk: true, amountCovered: claim.amountCovered },
        req,
      });
      updated.push(claim.id);
      continue;
    }
    if (type === "missing_patient_nhf_id" && resolution === "mark_pending_provider_update") {
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Bulk marked pending: awaiting provider NHF ID update"
      );
      // eslint-disable-next-line no-await-in-loop
      await claim.save();
      // eslint-disable-next-line no-await-in-loop
      await logResolutionEvent({
        scope: "exceptions",
        rowKey: buildExceptionRowKey({ type, claimId: claim.id }),
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "marked_pending",
        metadata: { bulk: true },
        req,
      });
      updated.push(claim.id);
      continue;
    }
    if (type === "stale_claim" && resolution === "escalate_pending_review") {
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Bulk escalated stale claim for NHF review"
      );
      // eslint-disable-next-line no-await-in-loop
      await claim.save();
      // eslint-disable-next-line no-await-in-loop
      await logResolutionEvent({
        scope: "exceptions",
        rowKey: buildExceptionRowKey({ type, claimId: claim.id }),
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "escalated_claim",
        metadata: { bulk: true },
        req,
      });
      updated.push(claim.id);
      continue;
    }
    failed.push(claimId);
  }

  return res.json({
    resolvedCount: updated.length,
    missingCount: missing.length,
    failedCount: failed.length,
    resolvedClaimIds: updated,
    missingClaimIds: missing,
    failedClaimIds: failed,
  });
});

router.post("/reconciliation/resolve", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "reconciliation.resolve")) return;
  const resolution = String(req.body?.resolution || "").trim().toLowerCase();
  const type = String(req.body?.type || "").trim().toLowerCase();
  const claimId = String(req.body?.claimId || "").trim();
  const entityId = String(req.body?.entityId || "").trim();
  const entityType = String(req.body?.entityType || "").trim().toLowerCase();
  const reviewNote = String(req.body?.reviewNote || "").trim();
  const baseRowKey = buildReconciliationRowKey({ type, entityType, entityId, claimId });

  if (!resolution) return res.status(400).json({ error: "resolution is required" });
  if (["sync_claim_to_expected", "reject_claim"].includes(resolution)) {
    const validation = await validateNhfSecondaryApproval({ req, action: `reconciliation:${resolution}` });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }

  if (resolution === "create_dispute") {
    const dispute = await createDisputeRecord({
      claimId: claimId || null,
      reason: reviewNote || `Reconciliation issue: ${type || "unclassified"}`,
      notes: JSON.stringify({ type, entityId }),
      createdBy: req.user.id,
    });
    await logResolutionEvent({
      scope: "reconciliation",
      rowKey: baseRowKey,
      type,
      entityType,
      entityId,
      claimId,
      action: resolution,
      outcome: "dispute_created",
      metadata: { disputeId: dispute.id },
      req,
    });
    return res.status(201).json({ resolved: true, action: "create_dispute", dispute });
  }

  if (type === "missing_claim" && resolution === "generate_claim_from_appointment") {
    const appointment = await Appointment.findByPk(entityId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const existing = (await NhfClaim.findAll({}))
      .filter((entry) => String(entry.appointmentId || "") === String(appointment.id || ""))
      .sort(byNewest)[0];
    if (existing) {
      await logResolutionEvent({
        scope: "reconciliation",
        rowKey: baseRowKey,
        type,
        entityType: "appointment",
        entityId: appointment.id,
        claimId: existing.id,
        appointmentId: appointment.id,
        action: resolution,
        outcome: "claim_exists",
        metadata: { idempotent: true, existingClaimId: existing.id },
        req,
      });
      return res.json({ resolved: true, action: "claim_exists", claim: existing, idempotent: true });
    }

    const amountCovered = toMoney(appointment.nhfDeductionAmount || 0);
    const claim = await NhfClaim.create({
      patientId: appointment.patientId || null,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId || null,
      amountCovered,
      status: "pending",
      sourceRole: "nhf",
      sourceUserId: req.user.id,
      reviewNote: reviewNote || "Auto-generated from reconciliation: missing claim",
      calculationSnapshot: {
        baseAmount: toMoney(appointment.feeAmount || 0),
        nhfCoverage: amountCovered,
        source: "reconciliation_auto_create",
        createdAt: new Date().toISOString(),
      },
    });
    await logResolutionEvent({
      scope: "reconciliation",
      rowKey: baseRowKey,
      type,
      entityType: "appointment",
      entityId: appointment.id,
      claimId: claim.id,
      appointmentId: appointment.id,
      action: resolution,
      outcome: "generated_claim",
      metadata: { generatedClaimId: claim.id },
      req,
    });
    return res.status(201).json({ resolved: true, action: "generated_claim", claim });
  }

  if (type === "amount_mismatch" && resolution === "sync_claim_to_expected") {
    if (!claimId) return res.status(400).json({ error: "claimId is required for amount mismatch sync" });
    const claim = await NhfClaim.findByPk(claimId);
    if (!claim) return res.status(404).json({ error: "Claim not found" });
    claim.amountCovered = toMoney(
      req.body?.expectedAmount ?? req.body?.targetAmount ?? claim.amountCovered ?? 0
    );
    claim.status = "pending";
    claim.reviewedAt = new Date().toISOString();
    claim.reviewedBy = req.user.id;
    claim.reviewNote = appendReviewNote(
      claim,
      reviewNote || "Auto-resolved reconciliation amount mismatch by syncing claim amount to expected value"
    );
    await claim.save();
    await logResolutionEvent({
      scope: "reconciliation",
      rowKey: baseRowKey,
      type,
      entityType: entityType || "appointment",
      entityId,
      claimId: claim.id,
      appointmentId: claim.appointmentId || null,
      action: resolution,
      outcome: "synced_claim_amount",
      metadata: { amountCovered: claim.amountCovered },
      req,
    });
    return res.json({ resolved: true, action: "synced_claim_amount", claim });
  }

  if (type === "missing_order" && resolution === "reject_claim") {
    const targetClaimId = claimId || entityId;
    const claim = await NhfClaim.findByPk(targetClaimId);
    if (!claim) return res.status(404).json({ error: "Claim not found" });
    claim.status = "rejected";
    claim.reviewedAt = new Date().toISOString();
    claim.reviewedBy = req.user.id;
    claim.reviewNote = appendReviewNote(
      claim,
      reviewNote || "Auto-resolved reconciliation missing-order by rejecting claim"
    );
    await claim.save();
    await logResolutionEvent({
      scope: "reconciliation",
      rowKey: baseRowKey,
      type,
      entityType: entityType || "claim",
      entityId: targetClaimId,
      claimId: claim.id,
      appointmentId: claim.appointmentId || null,
      orderId: claim.orderId || null,
      action: resolution,
      outcome: "rejected_claim",
      req,
    });
    return res.json({ resolved: true, action: "rejected_claim", claim });
  }

  await logResolutionEvent({
    scope: "reconciliation",
    rowKey: baseRowKey,
    type,
    entityType,
    entityId,
    claimId,
    action: resolution,
    outcome: "unsupported_action",
    metadata: { error: "Unsupported reconciliation resolution action" },
    req,
  });
  return res.status(400).json({ error: "Unsupported reconciliation resolution action" });
});

router.post("/exceptions/resolve", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "exceptions.resolve")) return;
  const type = String(req.body?.type || "").trim().toLowerCase();
  const resolution = String(req.body?.resolution || "").trim().toLowerCase();
  const claimId = String(req.body?.claimId || "").trim();
  const claimIds = Array.isArray(req.body?.claimIds)
    ? req.body.claimIds.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const appointmentId = String(req.body?.appointmentId || "").trim();
  const orderId = String(req.body?.orderId || "").trim();
  const reviewNote = String(req.body?.reviewNote || "").trim();
  const rowKey = buildExceptionRowKey({ type, claimId, appointmentId, orderId, claimIds });

  if (!type || !resolution) {
    return res.status(400).json({ error: "type and resolution are required" });
  }
  if (["cap_to_base_amount", "keep_latest_reject_others"].includes(resolution)) {
    const validation = await validateNhfSecondaryApproval({ req, action: `exceptions:${resolution}` });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
  }

  if (resolution === "create_dispute") {
    const dispute = await createDisputeRecord({
      claimId: claimId || null,
      reason: reviewNote || `Exception ${type}`,
      notes: JSON.stringify({ type, claimId, claimIds }),
      createdBy: req.user.id,
    });
    await logResolutionEvent({
      scope: "exceptions",
      rowKey,
      type,
      claimId: claimId || null,
      appointmentId: appointmentId || null,
      orderId: orderId || null,
      claimIds,
      action: resolution,
      outcome: "dispute_created",
      metadata: { disputeId: dispute.id },
      req,
    });
    return res.status(201).json({ resolved: true, action: "create_dispute", dispute });
  }

  if (type === "duplicate_appointment_claims" || type === "duplicate_order_claims") {
    if (!claimIds.length) return res.status(400).json({ error: "claimIds are required for duplicate resolution" });
    const claims = [];
    for (const id of claimIds) {
      // eslint-disable-next-line no-await-in-loop
      const claim = await NhfClaim.findByPk(id);
      if (claim) claims.push(claim);
    }
    claims.sort(byNewest);
    const keeper = claims[0] || null;
    if (!keeper) return res.status(404).json({ error: "No claims found for duplicate resolution" });
    if (resolution === "keep_latest_reject_others") {
      const updated = [];
      for (const claim of claims.slice(1)) {
        claim.status = "rejected";
        claim.reviewedAt = new Date().toISOString();
        claim.reviewedBy = req.user.id;
        claim.reviewNote = appendReviewNote(
          claim,
          reviewNote || `Auto-resolved duplicate claims. Kept latest claim ${keeper.id}`
        );
        // eslint-disable-next-line no-await-in-loop
        await claim.save();
        updated.push(claim.id);
      }
      await logResolutionEvent({
        scope: "exceptions",
        rowKey,
        type,
        claimId: keeper.id,
        appointmentId: appointmentId || keeper.appointmentId || null,
        orderId: orderId || keeper.orderId || null,
        claimIds,
        action: resolution,
        outcome: "duplicates_rejected",
        metadata: { keptClaimId: keeper.id, rejectedClaimIds: updated },
        req,
      });
      return res.json({ resolved: true, action: "duplicates_rejected", keptClaimId: keeper.id, rejectedClaimIds: updated });
    }
  }

  if (claimId) {
    const claim = await NhfClaim.findByPk(claimId);
    if (!claim) return res.status(404).json({ error: "Claim not found" });

    if (type === "high_or_invalid_amount" && resolution === "cap_to_base_amount") {
      const baseAmount = toMoney(claim?.calculationSnapshot?.baseAmount || claim.amountCovered || 0);
      claim.amountCovered = Math.min(toMoney(claim.amountCovered || 0), baseAmount);
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Auto-resolved high/invalid amount by capping to calculation base amount"
      );
      await claim.save();
      await logResolutionEvent({
        scope: "exceptions",
        rowKey,
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "capped_amount",
        metadata: { amountCovered: claim.amountCovered },
        req,
      });
      return res.json({ resolved: true, action: "capped_amount", claim });
    }

    if (type === "missing_patient_nhf_id" && resolution === "mark_pending_provider_update") {
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Missing patient NHF ID: awaiting provider update"
      );
      await claim.save();
      await logResolutionEvent({
        scope: "exceptions",
        rowKey,
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "marked_pending",
        req,
      });
      return res.json({ resolved: true, action: "marked_pending", claim });
    }

    if (type === "stale_claim" && resolution === "escalate_pending_review") {
      claim.status = "pending";
      claim.reviewedAt = new Date().toISOString();
      claim.reviewedBy = req.user.id;
      claim.reviewNote = appendReviewNote(
        claim,
        reviewNote || "Stale claim escalated for NHF review"
      );
      await claim.save();
      await logResolutionEvent({
        scope: "exceptions",
        rowKey,
        type,
        claimId: claim.id,
        appointmentId: claim.appointmentId || null,
        orderId: claim.orderId || null,
        action: resolution,
        outcome: "escalated_claim",
        req,
      });
      return res.json({ resolved: true, action: "escalated_claim", claim });
    }
  }

  await logResolutionEvent({
    scope: "exceptions",
    rowKey,
    type,
    claimId: claimId || null,
    appointmentId: appointmentId || null,
    orderId: orderId || null,
    claimIds,
    action: resolution,
    outcome: "unsupported_action",
    metadata: { error: "Unsupported exception resolution action" },
    req,
  });
  return res.status(400).json({ error: "Unsupported exception resolution action" });
});

router.get("/payout-runs", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "payouts.runs.read")) return;
  const rows = await NhfPayoutRun.findAll({});
  const status = String(req.query.status || "").trim().toLowerCase();
  const payoutRuns = rows
    .filter((entry) => (status ? String(entry.status || "").toLowerCase() === status : true))
    .sort(byNewest)
    .slice(0, 120);
  return res.json({ payoutRuns });
});

router.post("/payout-runs", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "payouts.runs.create")) return;
  const from = toDate(req.body?.from) || null;
  const to = toDate(req.body?.to) || null;
  const summary = await buildPayoutSummary({ from, to });
  const label = String(req.body?.label || "").trim() || `NHF Payout Run ${new Date().toISOString().slice(0, 10)}`;
  const payoutRun = await NhfPayoutRun.create({
    label,
    status: "draft",
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    totals: summary.totals,
    doctorPayouts: summary.doctorPayouts,
    pharmacyPayouts: summary.pharmacyPayouts,
    createdBy: req.user.id,
    statusHistory: [
      {
        status: "draft",
        at: new Date().toISOString(),
        by: req.user.id,
      },
    ],
  });
  return res.status(201).json({ payoutRun });
});

router.patch("/payout-runs/:id/status", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "payouts.runs.transition")) return;
  const payoutRun = await NhfPayoutRun.findByPk(req.params.id);
  if (!payoutRun) return res.status(404).json({ error: "Payout run not found" });
  const current = normalizePayoutRunStatus(payoutRun.status);
  const next = normalizePayoutRunStatus(req.body?.status);
  if (current === next) return res.json({ payoutRun, idempotent: true });
  if (["paid", "exported"].includes(next)) {
    const validation = await validateNhfSecondaryApproval({ req, action: `payout_run:${next}` });
    if (!validation.ok) return res.status(400).json({ error: validation.error });
    payoutRun.secondaryApproval = validation.approval;
  }
  if (!allowedPayoutRunTransitions[current]?.has(next)) {
    return res.status(400).json({ error: `Invalid payout run transition from ${current} to ${next}` });
  }
  payoutRun.status = next;
  payoutRun.statusHistory = [
    ...(Array.isArray(payoutRun.statusHistory) ? payoutRun.statusHistory : []),
    {
      status: next,
      at: new Date().toISOString(),
      by: req.user.id,
      note: String(req.body?.note || "").trim() || null,
    },
  ].slice(-50);
  await payoutRun.save();
  return res.json({ payoutRun });
});

router.get("/payout-runs/:id/export.csv", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "payouts.runs.export")) return;
  const payoutRun = await NhfPayoutRun.findByPk(req.params.id);
  if (!payoutRun) return res.status(404).json({ error: "Payout run not found" });

  const doctorRows = Array.isArray(payoutRun.doctorPayouts) ? payoutRun.doctorPayouts : [];
  const pharmacyRows = Array.isArray(payoutRun.pharmacyPayouts) ? payoutRun.pharmacyPayouts : [];
  const lines = [
    ["run_id", payoutRun.id],
    ["label", payoutRun.label || ""],
    ["status", payoutRun.status || ""],
    ["generated_at", new Date().toISOString()],
    [],
    ["section", "doctor"],
    ["doctor_id", "doctor_name", "appointments", "gross_fee", "nhf_deduction", "patient_paid", "patient_balance"],
    ...doctorRows.map((row) => [
      row.doctorId,
      row.doctorName || "",
      row.totalAppointments || 0,
      toMoney(row.grossFee || 0),
      toMoney(row.nhfDeduction || 0),
      toMoney(row.patientPaid || 0),
      toMoney(row.patientBalance || 0),
    ]),
    [],
    ["section", "pharmacy"],
    ["pharmacy_id", "pharmacy_name", "approved_claims", "approved_amount_covered"],
    ...pharmacyRows.map((row) => [
      row.pharmacyId,
      row.pharmacyName || "",
      row.approvedClaims || 0,
      toMoney(row.approvedAmountCovered || 0),
    ]),
  ];
  const csv = lines.map((row) => row.map(csvEscape).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="nhf-payout-run-${payoutRun.id}.csv"`);
  return res.status(200).send(csv);
});

router.get("/disputes", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "disputes.read")) return;
  const status = String(req.query.status || "").trim().toLowerCase();
  const rows = await NhfDispute.findAll({});
  const disputes = rows
    .filter((entry) => (status ? String(entry.status || "").toLowerCase() === status : true))
    .sort(byNewest)
    .slice(0, 200);
  return res.json({ disputes });
});

router.post("/disputes", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "disputes.create")) return;
  const claimId = String(req.body?.claimId || "").trim();
  const payoutRunId = String(req.body?.payoutRunId || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason is required" });
  if (!claimId && !payoutRunId) {
    return res.status(400).json({ error: "claimId or payoutRunId is required" });
  }
  if (claimId) {
    const claim = await NhfClaim.findByPk(claimId);
    if (!claim) return res.status(404).json({ error: "Claim not found" });
  }
  if (payoutRunId) {
    const payoutRun = await NhfPayoutRun.findByPk(payoutRunId);
    if (!payoutRun) return res.status(404).json({ error: "Payout run not found" });
  }
  const dispute = await NhfDispute.create({
    claimId: claimId || null,
    payoutRunId: payoutRunId || null,
    reason,
    status: "open",
    createdBy: req.user.id,
    assigneeId: String(req.body?.assigneeId || "").trim() || null,
    notes: String(req.body?.notes || "").trim() || null,
  });
  return res.status(201).json({ dispute });
});

router.patch("/disputes/:id", requireAuth, requireRoles(["nhf", "admin"]), async (req, res) => {
  if (!ensureNhfPermission(req, res, "disputes.update")) return;
  const dispute = await NhfDispute.findByPk(req.params.id);
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });
  const status = String(req.body?.status || dispute.status || "").trim().toLowerCase();
  if (!["open", "in_review", "resolved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be open, in_review, resolved, or rejected" });
  }
  dispute.status = status;
  dispute.assigneeId = String(req.body?.assigneeId || dispute.assigneeId || "").trim() || null;
  dispute.resolutionNote = String(req.body?.resolutionNote || dispute.resolutionNote || "").trim() || null;
  dispute.updatedBy = req.user.id;
  dispute.updatedAt = new Date().toISOString();
  await dispute.save();
  return res.json({ dispute });
});

router.post("/callback", async (req, res) => {
  const token = req.headers["x-nhf-token"];
  const expected = process.env.NHF_CALLBACK_SECRET || "nhf_dev_secret";
  if (token !== expected) {
    return res.status(401).json({ error: "Unauthorized callback" });
  }
  const claim = await NhfClaim.findByPk(req.body?.claimId);
  if (!claim) return res.status(404).json({ error: "Claim not found" });
  claim.status = req.body?.status || claim.status;
  if (typeof req.body?.amountCovered === "number") {
    claim.amountCovered = req.body.amountCovered;
  }
  await claim.save();
  return res.json({ claim });
});

module.exports = router;

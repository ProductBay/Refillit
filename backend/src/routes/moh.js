const express = require("express");
const crypto = require("node:crypto");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  NhfClaim,
  Order,
  Prescription,
  ComplianceReportSnapshot,
  MohExportJob,
  MohPolicy,
  MohClinicalCatalogEntry,
  User,
  DoctorProfile,
  PharmacyProfile,
  NhfProfile,
  CourierProfile,
} = require("../models");
const { searchMohDrugs } = require("../constants/mohDrugs");
const { verifySnapshotRecord } = require("../utils/complianceSnapshot");
const { writeAudit } = require("../utils/audit");

const router = express.Router();
const MOH_ROLE_PERMISSIONS = {
  analyst: {
    view: true,
    validate: true,
    approve: false,
    exportCreate: false,
    exportApprove: false,
    exportUnlock: false,
    exportDownload: false,
  },
  auditor: {
    view: true,
    validate: true,
    approve: false,
    exportCreate: false,
    exportApprove: false,
    exportUnlock: false,
    exportDownload: true,
  },
  supervisor: {
    view: true,
    validate: true,
    approve: true,
    exportCreate: true,
    exportApprove: true,
    exportUnlock: true,
    exportDownload: true,
  },
};

const getMohRole = (req) => {
  if (req.user?.role === "admin") return "supervisor";
  return req.user?.mohRole || "analyst";
};

const ensureMohPermission = (req, res, permission) => {
  const role = getMohRole(req);
  const allowed = MOH_ROLE_PERMISSIONS[role]?.[permission];
  if (!allowed) {
    res.status(403).json({ error: "Forbidden: MOH permission required" });
    return false;
  }
  return true;
};

const normalizeDate = (value) => {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date;
};

const computeSchemaValidation = (snapshot) => {
  const errors = [];
  const warnings = [];
  if (!snapshot?.id) errors.push("missing_snapshot_id");
  if (!snapshot?.pharmacyId) errors.push("missing_pharmacy_id");
  if (!snapshot?.checksum) errors.push("missing_checksum");
  const signatureHash = snapshot?.signatureHash || snapshot?.signature?.signatureHash;
  if (!signatureHash) errors.push("missing_signature_hash");
  const signedBy = snapshot?.signedBy || snapshot?.signature?.signerId;
  const signedAt = snapshot?.signedAt || snapshot?.signature?.signedAt;
  if (!signedBy) errors.push("missing_signed_by");
  if (!signedAt) errors.push("missing_signed_at");
  if (!snapshot?.createdAt) warnings.push("missing_created_at");
  const events = Array.isArray(snapshot?.events) ? snapshot.events : null;
  if (!events) errors.push("missing_events");
  const summary = snapshot?.summary || {};
  if (events && typeof summary.total === "number" && summary.total !== events.length) {
    warnings.push("summary_total_mismatch");
  }
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
};

const computeRiskLevel = (snapshot) => {
  const summary = snapshot?.summary || {};
  const critical = Number(summary.critical || 0);
  const high = Number(summary.high || 0);
  const moderate = Number(summary.moderate || 0);
  if (critical > 0 || high >= 3) return "high";
  if (high > 0 || moderate >= 8) return "medium";
  return "low";
};

const resolvePolicy = async (policyVersion) => {
  const code = String(policyVersion || "").trim();
  if (!code) return null;
  const policy = await MohPolicy.findOne({ where: { code } });
  if (!policy) return null;
  if (String(policy.status || "active").toLowerCase() !== "active") return null;
  return policy;
};

const normalizeCatalogText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const toCatalogArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const normalizeClinicalCatalogPayload = (payload = {}) => ({
  diagnosisCode: String(payload.diagnosisCode || "").trim(),
  diagnosisLabel: String(payload.diagnosisLabel || "").trim(),
  diagnosisAliases: toCatalogArray(payload.diagnosisAliases),
  medicationCode: String(payload.medicationCode || "").trim(),
  medicationName: String(payload.medicationName || "").trim(),
  medicationType: String(payload.medicationType || "").trim(),
  usedFor: String(payload.usedFor || "").trim(),
  strengths: toCatalogArray(payload.strengths),
  defaultStrength: String(payload.defaultStrength || "").trim(),
  controlledSubstance: Boolean(payload.controlledSubstance),
  notes: String(payload.notes || "").trim(),
  policyCode: String(payload.policyCode || "").trim(),
});

const validateClinicalCatalogPayload = (entry) => {
  if (!entry.diagnosisLabel) return "diagnosisLabel is required";
  if (!entry.medicationName) return "medicationName is required";
  if (!entry.medicationType) return "medicationType is required";
  if (!entry.usedFor) return "usedFor is required";
  if (!entry.strengths.length) return "at least one strength is required";
  if (entry.defaultStrength && !entry.strengths.includes(entry.defaultStrength)) {
    return "defaultStrength must be one of strengths";
  }
  if (entry.policyCode && !/^POLICY-/i.test(entry.policyCode)) {
    return "policyCode must start with POLICY-";
  }
  return "";
};

const filterSubmissionRows = (rows, filters = {}) => {
  const statusFilter = String(filters.status || "all").toLowerCase();
  const pharmacyFilter = String(filters.pharmacyId || "").trim().toLowerCase();
  const searchFilter = String(filters.search || "").trim().toLowerCase();
  const fromDate = filters.from ? normalizeDate(`${filters.from}T00:00:00`) : null;
  const toDate = filters.to ? normalizeDate(`${filters.to}T23:59:59`) : null;
  const queueView = String(filters.queueView || "all").toLowerCase();
  const nowMs = Date.now();
  return rows.filter((entry) => {
    const status = String(entry.status || "").toLowerCase();
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (pharmacyFilter && !String(entry.pharmacyId || "").toLowerCase().includes(pharmacyFilter)) return false;
    if (searchFilter) {
      const haystack = [
        entry.id,
        entry.label,
        entry.pharmacyId,
        entry.submittedBy,
        entry.reviewedBy,
        entry.submissionNote,
        entry.reviewNote,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(searchFilter)) return false;
    }
    const submittedDate = normalizeDate(entry.submittedAt);
    if (fromDate && (!submittedDate || submittedDate.getTime() < fromDate.getTime())) return false;
    if (toDate && (!submittedDate || submittedDate.getTime() > toDate.getTime())) return false;
    if (queueView === "new" || queueView === "overdue") {
      if (status !== "submitted" || !submittedDate) return false;
      const ageHours = (nowMs - submittedDate.getTime()) / 3600000;
      if (queueView === "new" && ageHours >= 24) return false;
      if (queueView === "overdue" && ageHours < 24) return false;
    } else if (["approved", "rejected", "submitted"].includes(queueView)) {
      if (status !== queueView) return false;
    }
    return true;
  });
};

const buildSubmissionRows = async () => {
  const rows = await ComplianceReportSnapshot.findAll({});
  return rows
    .filter((entry) => entry?.mohSubmission?.status)
    .map((entry) => ({
      id: entry.id,
      label: entry.label || "Compliance Snapshot",
      pharmacyId: entry.pharmacyId || null,
      riskLevel: computeRiskLevel(entry),
      schemaValidation: computeSchemaValidation(entry),
      signedBy: entry.signedBy || entry.signature?.signerId || null,
      signedAt: entry.signedAt || entry.signature?.signedAt || null,
      status: entry.mohSubmission.status,
      submittedAt: entry.mohSubmission.submittedAt || null,
      submittedBy: entry.mohSubmission.submittedBy || null,
      submissionNote: entry.mohSubmission.submissionNote || null,
      reviewedAt: entry.mohSubmission.reviewedAt || null,
      reviewedBy: entry.mohSubmission.reviewedBy || null,
      reviewDecision: entry.mohSubmission.reviewDecision || null,
      reviewNote: entry.mohSubmission.reviewNote || null,
      reviewChecklist: entry.mohSubmission.reviewChecklist || null,
      structuredRejection: entry.mohSubmission.structuredRejection || null,
      highRisk: entry.mohSubmission.highRisk || null,
      policyVersion: entry.mohSubmission.policyVersion || null,
      decisionSignatureHash: entry.mohSubmission.decisionSignatureHash || null,
      evidence: Array.isArray(entry.mohSubmission.evidence) ? entry.mohSubmission.evidence : [],
    }))
    .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
};

const resolveSnapshotFromRouteId = async (rawId) => {
  const normalized = String(rawId || "").trim();
  const candidate = normalized.split("|")[0].trim();
  if (!candidate) return null;
  let snapshot = await ComplianceReportSnapshot.findByPk(candidate);
  if (snapshot) return snapshot;
  const rows = await ComplianceReportSnapshot.findAll({});
  snapshot = rows.find((entry) => {
    const submissionId = String(entry?.mohSubmission?.submissionId || "").trim();
    return submissionId && submissionId === candidate;
  });
  if (snapshot) return snapshot;
  snapshot = rows.find((entry) => String(entry?.id || "").trim() === candidate);
  return snapshot || null;
};

const toCsv = (rows) => {
  const escape = (value) => {
    const raw = String(value ?? "");
    if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
    return raw;
  };
  return rows.map((row) => row.map(escape).join(",")).join("\n");
};

const buildExportCsv = (rows) => {
  const table = [
    ["# Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature"],
    [
      "snapshot_id",
      "label",
      "pharmacy_id",
      "risk_level",
      "status",
      "submitted_at",
      "submitted_by",
      "reviewed_at",
      "reviewed_by",
      "submission_note",
      "review_note",
      "review_checklist",
      "structured_rejection",
      "high_risk_fields",
      "schema_validation",
      "policy_version",
      "decision_signature",
      "evidence_count",
    ],
    ...rows.map((entry) => [
      entry.id,
      entry.label || "",
      entry.pharmacyId || "",
      entry.riskLevel || "",
      entry.status || "",
      entry.submittedAt || "",
      entry.submittedBy || "",
      entry.reviewedAt || "",
      entry.reviewedBy || "",
      entry.submissionNote || "",
      entry.reviewNote || "",
      entry.reviewChecklist ? JSON.stringify(entry.reviewChecklist) : "",
      entry.structuredRejection ? JSON.stringify(entry.structuredRejection) : "",
      entry.highRisk ? JSON.stringify(entry.highRisk) : "",
      entry.schemaValidation ? JSON.stringify(entry.schemaValidation) : "",
      entry.policyVersion || "",
      entry.decisionSignatureHash || "",
      Array.isArray(entry.evidence) ? entry.evidence.length : 0,
    ]),
  ];
  return toCsv(table);
};

const buildExportHtml = ({ jobId, rows, generatedAt, generatedBy, filters, checksum }) => {
  const records = rows
    .map(
      (entry) => `
      <tr>
        <td>${entry.id || ""}</td>
        <td>${entry.label || ""}</td>
        <td>${entry.pharmacyId || ""}</td>
        <td>${entry.riskLevel || ""}</td>
        <td>${entry.status || ""}</td>
        <td>${entry.submittedAt || ""}</td>
        <td>${entry.submittedBy || ""}</td>
        <td>${entry.reviewedAt || ""}</td>
        <td>${entry.reviewedBy || ""}</td>
        <td>${entry.reviewChecklist ? JSON.stringify(entry.reviewChecklist) : ""}</td>
        <td>${entry.structuredRejection ? JSON.stringify(entry.structuredRejection) : ""}</td>
        <td>${entry.highRisk ? JSON.stringify(entry.highRisk) : ""}</td>
        <td>${entry.schemaValidation ? JSON.stringify(entry.schemaValidation) : ""}</td>
        <td>${entry.policyVersion || ""}</td>
        <td>${entry.decisionSignatureHash || ""}</td>
        <td>${Array.isArray(entry.evidence) ? entry.evidence.length : 0}</td>
      </tr>
    `
    )
    .join("");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>MOH Export Job ${jobId}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #1d1d1d; }
      h1 { margin: 0 0 12px; }
      .meta { margin-bottom: 12px; font-size: 12px; color: #5a5a5a; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #d8d8d8; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f4f7f7; }
      code { font-size: 11px; }
    </style>
  </head>
  <body>
    <h1>MOH Immutable Export Snapshot</h1>
    <div class="meta">Job ID: ${jobId} | Generated: ${generatedAt} | Actor: ${generatedBy}</div>
    <div class="meta">Rows: ${rows.length} | Filters: <code>${JSON.stringify(filters || {})}</code></div>
    <div class="meta">Checksum: <code>${checksum}</code></div>
    <div class="meta">Included metadata: review_checklist, structured_rejection, high_risk_fields, schema_validation, policy_version, decision_signature</div>
    <table>
      <thead>
        <tr>
          <th>Snapshot ID</th><th>Label</th><th>Pharmacy</th><th>Risk</th><th>Status</th><th>Submitted At</th><th>Submitted By</th><th>Reviewed At</th><th>Reviewed By</th>
          <th>Checklist</th><th>Structured Rejection</th><th>High Risk Fields</th><th>Schema Validation</th><th>Policy</th><th>Decision Signature</th>
          <th>Evidence Count</th>
        </tr>
      </thead>
      <tbody>${records}</tbody>
    </table>
  </body>
</html>`;
};

router.get("/drugs", requireAuth, requireRoles(["doctor", "moh", "admin"]), async (req, res) => {
  const query = req.query.query || "";
  const drugs = searchMohDrugs(query).map((drug) => ({
    code: drug.code,
    name: drug.name,
    strengths: drug.strengths,
    medicationType: drug.medicationType,
    usedFor: drug.usedFor,
  }));
  res.json({ drugs });
});

router.get(
  "/clinical-catalog",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const statusFilter = normalizeCatalogText(req.query?.status || "all");
    const query = normalizeCatalogText(req.query?.query || "");
    const diagnosis = normalizeCatalogText(req.query?.diagnosis || "");
    const medication = normalizeCatalogText(req.query?.medication || "");
    const rows = await MohClinicalCatalogEntry.findAll({});
    const entries = rows
      .filter((entry) => {
        const status = normalizeCatalogText(entry.status || "pending");
        if (statusFilter !== "all" && status !== statusFilter) return false;
        if (diagnosis && !normalizeCatalogText(entry.diagnosisLabel).includes(diagnosis)) return false;
        if (medication && !normalizeCatalogText(entry.medicationName).includes(medication)) return false;
        if (query) {
          const haystack = [
            entry.id,
            entry.diagnosisCode,
            entry.diagnosisLabel,
            ...(Array.isArray(entry.diagnosisAliases) ? entry.diagnosisAliases : []),
            entry.medicationCode,
            entry.medicationName,
            entry.medicationType,
            entry.usedFor,
            ...(Array.isArray(entry.strengths) ? entry.strengths : []),
            entry.status,
            entry.policyCode,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    return res.json({ entries });
  }
);

router.post(
  "/clinical-catalog",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const normalized = normalizeClinicalCatalogPayload(req.body || {});
    const validationError = validateClinicalCatalogPayload(normalized);
    if (validationError) return res.status(400).json({ error: validationError });

    if (normalized.policyCode) {
      const policy = await resolvePolicy(normalized.policyCode);
      if (!policy) return res.status(400).json({ error: "policyCode is not active or not found" });
    }

    const row = await MohClinicalCatalogEntry.create({
      ...normalized,
      status: "pending",
      submittedBy: req.user.id,
      submittedByRole: req.user.role === "admin" ? "admin" : getMohRole(req),
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
    });

    await writeAudit({
      actorUserId: req.user.id,
      action: "moh.clinical_catalog.create",
      entityType: "moh_clinical_catalog_entry",
      entityId: row.id,
      metadata: {
        diagnosisLabel: row.diagnosisLabel,
        medicationName: row.medicationName,
        status: row.status,
      },
    });

    return res.status(201).json({ entry: row });
  }
);

router.put(
  "/clinical-catalog/:id",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const row = await MohClinicalCatalogEntry.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: "Catalog entry not found" });

    const normalized = normalizeClinicalCatalogPayload({
      ...row,
      ...(req.body || {}),
    });
    const validationError = validateClinicalCatalogPayload(normalized);
    if (validationError) return res.status(400).json({ error: validationError });
    if (normalized.policyCode) {
      const policy = await resolvePolicy(normalized.policyCode);
      if (!policy) return res.status(400).json({ error: "policyCode is not active or not found" });
    }

    Object.assign(row, normalized);
    row.status = "pending";
    row.rejectionReason = null;
    row.rejectedBy = null;
    row.rejectedAt = null;
    row.approvedBy = null;
    row.approvedAt = null;
    await row.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "moh.clinical_catalog.update",
      entityType: "moh_clinical_catalog_entry",
      entityId: row.id,
      metadata: {
        diagnosisLabel: row.diagnosisLabel,
        medicationName: row.medicationName,
        status: row.status,
      },
    });

    return res.json({ entry: row });
  }
);

router.post(
  "/clinical-catalog/:id/decision",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "approve")) return;
    const row = await MohClinicalCatalogEntry.findByPk(req.params.id);
    if (!row) return res.status(404).json({ error: "Catalog entry not found" });
    const decision = normalizeCatalogText(req.body?.decision || "");
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approve or reject" });
    }
    const reason = String(req.body?.reason || "").trim();
    if (decision === "reject" && !reason) {
      return res.status(400).json({ error: "reason is required for reject decision" });
    }

    if (decision === "approve") {
      row.status = "approved";
      row.approvedBy = req.user.id;
      row.approvedAt = new Date().toISOString();
      row.rejectionReason = null;
      row.rejectedBy = null;
      row.rejectedAt = null;
    } else {
      row.status = "rejected";
      row.rejectedBy = req.user.id;
      row.rejectedAt = new Date().toISOString();
      row.rejectionReason = reason;
      row.approvedBy = null;
      row.approvedAt = null;
    }
    await row.save();

    await writeAudit({
      actorUserId: req.user.id,
      action:
        decision === "approve"
          ? "moh.clinical_catalog.approve"
          : "moh.clinical_catalog.reject",
      entityType: "moh_clinical_catalog_entry",
      entityId: row.id,
      metadata: {
        decision,
        reason: reason || null,
      },
    });

    return res.json({ entry: row });
  }
);

router.get("/id-resolve", requireAuth, requireRoles(["moh", "admin"]), async (req, res) => {
  if (!ensureMohPermission(req, res, "view")) return;
  const query = String(req.query?.query || "").trim().toLowerCase();
  if (!query) return res.status(400).json({ error: "query is required" });

  const users = await User.findAll({});
  const doctors = await DoctorProfile.findAll({});
  const pharmacies = await PharmacyProfile.findAll({});
  const nhfProfiles = await NhfProfile.findAll({});
  const courierProfiles = await CourierProfile.findAll({});

  const userMatches = users.filter((user) => {
    const haystack = [
      user.id,
      user.fullName,
      user.email,
      user.role,
      user.platformStaffId,
      user.mohEmployeeId,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const doctorMatches = doctors.filter((profile) => {
    const haystack = [
      profile.userId,
      profile.licenseNumber,
      profile.medicalCouncilId,
      profile.registryUrl,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const pharmacyMatches = pharmacies.filter((profile) => {
    const haystack = [
      profile.userId,
      profile.councilReg,
      profile.registeredName,
      profile.businessRegNumber,
      profile.nhfRegistryId,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const nhfMatches = nhfProfiles.filter((profile) => {
    const haystack = [
      profile.userId,
      profile.registryId,
      profile.organizationName,
      profile.registryUrl,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const courierMatches = courierProfiles.filter((profile) => {
    const haystack = [
      profile.userId,
      profile.governmentIdNumber,
      profile.driverLicenseNumber,
      profile.vehicleRegistrationNumber,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  const results = [];

  userMatches.forEach((user) => {
    results.push({
      type: "user",
      id: user.id,
      role: user.role,
      name: user.fullName || user.email || "Unknown",
      platformId: user.platformStaffId || null,
      email: user.email || null,
      createdAt: user.createdAt || null,
    });
  });

  doctorMatches.forEach((profile) => {
    const user = users.find((entry) => entry.id === profile.userId);
    results.push({
      type: "doctor",
      id: profile.userId,
      role: user?.role || "doctor",
      name: user?.fullName || profile.clinicInfo?.name || "Doctor profile",
      platformId: user?.platformStaffId || null,
      email: user?.email || null,
      licenseNumber: profile.licenseNumber || null,
      medicalCouncilId: profile.medicalCouncilId || null,
      createdAt: user?.createdAt || profile.createdAt || null,
    });
  });

  pharmacyMatches.forEach((profile) => {
    const user = users.find((entry) => entry.id === profile.userId);
    results.push({
      type: "pharmacy",
      id: profile.userId,
      role: user?.role || "pharmacy",
      name: profile.registeredName || user?.fullName || "Pharmacy profile",
      platformId: user?.platformStaffId || null,
      email: user?.email || null,
      councilReg: profile.councilReg || null,
      businessRegNumber: profile.businessRegNumber || null,
      createdAt: user?.createdAt || profile.createdAt || null,
    });
  });

  nhfMatches.forEach((profile) => {
    const user = users.find((entry) => entry.id === profile.userId);
    results.push({
      type: "nhf",
      id: profile.userId,
      role: user?.role || "nhf",
      name: profile.organizationName || user?.fullName || "NHF profile",
      platformId: user?.platformStaffId || null,
      email: user?.email || null,
      registryId: profile.registryId || null,
      createdAt: user?.createdAt || profile.createdAt || null,
    });
  });

  courierMatches.forEach((profile) => {
    const user = users.find((entry) => entry.id === profile.userId);
    results.push({
      type: "courier",
      id: profile.userId,
      role: user?.role || "courier",
      name: user?.fullName || "Courier profile",
      platformId: user?.platformStaffId || null,
      email: user?.email || null,
      governmentIdNumber: profile.governmentIdNumber || null,
      driverLicenseNumber: profile.driverLicenseNumber || null,
      createdAt: user?.createdAt || profile.createdAt || null,
    });
  });

  return res.json({ results });
});

router.post("/reports", requireAuth, requireRoles(["moh", "admin"]), async (req, res) => {
  if (!ensureMohPermission(req, res, "view")) return;
  const [claims, orders, prescriptions] = await Promise.all([
    NhfClaim.count(),
    Order.count(),
    Prescription.count(),
  ]);
  res.json({
    from: req.body?.from || null,
    to: req.body?.to || null,
    totals: {
      claims,
      orders,
      prescriptions,
    },
  });
});

router.get(
  "/compliance-snapshots/:id/validate",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "validate")) return;
    const snapshot = await resolveSnapshotFromRouteId(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
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
      snapshotId: snapshot.id,
      pharmacyId: snapshot.pharmacyId || null,
      signedBy: snapshot.signedBy || snapshot.signature?.signerId || null,
      signedAt: snapshot.signedAt || snapshot.signature?.signedAt || null,
      integrityOk: validation.integrityOk,
      signatureOk: validation.signatureOk,
      chainOk: validation.chainOk,
      overallValid: validation.overallValid,
      checksum: snapshot.checksum || null,
      computedChecksum: validation.computedChecksum,
      signatureHash: snapshot.signature?.signatureHash || snapshot.signatureHash || null,
      expectedSignatureHash: validation.expectedSignatureHash,
      previousSignatureHash: validation.previousSignatureHash,
      validatedAt: new Date().toISOString(),
    });
  }
);

router.get(
  "/compliance-snapshot-submissions",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const submissions = await buildSubmissionRows();
    return res.json({ submissions });
  }
);

router.get(
  "/policies",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const policies = await MohPolicy.findAll({});
    const active = policies
      .filter((policy) => String(policy.status || "active").toLowerCase() === "active")
      .map((policy) => ({
        id: policy.id,
        code: policy.code,
        name: policy.name,
        description: policy.description || null,
        status: policy.status || "active",
        updatedAt: policy.updatedAt || null,
      }))
      .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
    return res.json({ policies: active });
  }
);

router.post(
  "/compliance-snapshot-submissions/:id/decision",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "approve")) return;
    const snapshot = await resolveSnapshotFromRouteId(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    if (!snapshot?.mohSubmission?.status) {
      return res.status(409).json({ error: "Snapshot has not been submitted to MOH" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }
    const schemaValidation = computeSchemaValidation(snapshot);
    if (!schemaValidation.isValid) {
      return res.status(409).json({ error: "Schema validation failed. Resolve missing fields before decision." });
    }
    const riskLevel = computeRiskLevel(snapshot);
    const reviewChecklist = req.body?.reviewChecklist || null;
    const structuredRejection = req.body?.structuredRejection || null;
    const highRisk = req.body?.highRisk || null;
    const policyVersion = String(req.body?.policyVersion || "").trim();
    if (!policyVersion) {
      return res.status(400).json({ error: "policyVersion is required for MOH decisions" });
    }
    const policy = await resolvePolicy(policyVersion);
    if (!policy) {
      return res.status(400).json({ error: "policyVersion is invalid or inactive" });
    }
    if (riskLevel === "high") {
      const reasonCode = String(highRisk?.reasonCode || "").trim();
      const actionPlan = String(highRisk?.actionPlan || "").trim();
      if (!reasonCode || !actionPlan) {
        return res.status(400).json({
          error: "High-risk snapshots require a reason code and corrective action plan before decision.",
        });
      }
    }
    const reviewedAt = new Date().toISOString();
    const decisionSignaturePayload = JSON.stringify({
      snapshotId: snapshot.id,
      decision,
      reviewer: req.user.id,
      reviewedAt,
      policyVersion,
      riskLevel,
    });
    const decisionSignatureHash = crypto.createHash("sha256").update(decisionSignaturePayload).digest("hex");
    snapshot.mohSubmission = {
      ...snapshot.mohSubmission,
      status: decision,
      reviewedAt,
      reviewedBy: req.user.id,
      reviewDecision: decision,
      reviewNote: String(req.body?.note || "").trim() || null,
      reviewChecklist,
      structuredRejection,
      highRisk,
      policyVersion,
      decisionSignatureHash,
    };
    await snapshot.save();
    return res.json({ snapshot });
  }
);

router.post(
  "/export-jobs",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "exportCreate")) return;
    const format = String(req.body?.format || "csv").toLowerCase();
    if (!["csv", "pdf"].includes(format)) {
      return res.status(400).json({ error: "format must be csv or pdf" });
    }
    const scope = String(req.body?.scope || "compliance_snapshot_submissions").toLowerCase();
    if (scope !== "compliance_snapshot_submissions") {
      return res.status(400).json({ error: "unsupported scope" });
    }
    const filters = req.body?.filters || {};
    const allRows = await buildSubmissionRows();
    const rows = filterSubmissionRows(allRows, filters);
    const generatedAt = new Date().toISOString();
    const immutablePayload = {
      generatedAt,
      generatedBy: req.user.id,
      scope,
      format,
      filters,
      rowCount: rows.length,
      rows,
    };
    const checksum = crypto.createHash("sha256").update(JSON.stringify(immutablePayload)).digest("hex");
    const fileName = `moh-export-${scope}-${new Date(generatedAt).toISOString().slice(0, 10)}.${format === "csv" ? "csv" : "html"}`;
    const content =
      format === "csv"
        ? buildExportCsv(rows)
        : buildExportHtml({
            jobId: "pending",
            rows,
            generatedAt,
            generatedBy: req.user.id,
            filters,
            checksum,
          });

    const job = await MohExportJob.create({
      createdBy: req.user.id,
      scope,
      format,
      status: "completed",
      approvalStatus: "pending",
      approvalReason: null,
      approvalReviewerId: null,
      approvalReviewedAt: null,
      approvalSignatureHash: null,
      immutable: true,
      locked: false,
      lockedAt: null,
      lockedBy: null,
      unlockedAt: null,
      unlockedBy: null,
      unlockReason: null,
      unlockSignatureHash: null,
      filters,
      rowCount: rows.length,
      checksum,
      fileName,
      content,
      generatedAt,
      generatedBy: req.user.id,
    });

    if (format === "pdf") {
      job.content = buildExportHtml({
        jobId: job.id,
        rows,
        generatedAt,
        generatedBy: req.user.id,
        filters,
        checksum,
      });
      await job.save();
    }

    await writeAudit({
      actorUserId: req.user.id,
      action: "moh.export_job.create",
      entityType: "moh_export_job",
      entityId: job.id,
      metadata: {
        scope,
        format,
        rowCount: rows.length,
        checksum,
      },
    });

    return res.status(201).json({
      job: {
        id: job.id,
        scope: job.scope,
        format: job.format,
        status: job.status,
        immutable: job.immutable,
        filters: job.filters,
        rowCount: job.rowCount,
        checksum: job.checksum,
        fileName: job.fileName,
        createdAt: job.createdAt,
        generatedAt: job.generatedAt,
        generatedBy: job.generatedBy,
      },
    });
  }
);

router.post(
  "/export-jobs/:id/approval",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "exportApprove")) return;
    const job = await MohExportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: "Export job not found" });

    if (job.locked) {
      return res.status(409).json({ error: "Export job is locked and cannot be modified" });
    }

    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    const lock = req.body?.lock !== false;
    const reviewedAt = new Date().toISOString();
    const signaturePayload = JSON.stringify({
      jobId: job.id,
      checksum: job.checksum || null,
      decision,
      reason,
      reviewer: req.user.id,
      reviewedAt,
    });
    const approvalSignatureHash = crypto.createHash("sha256").update(signaturePayload).digest("hex");

    job.approvalStatus = decision;
    job.approvalReason = reason;
    job.approvalReviewerId = req.user.id;
    job.approvalReviewedAt = reviewedAt;
    job.approvalSignatureHash = approvalSignatureHash;
    if (lock) {
      job.locked = true;
      job.lockedAt = reviewedAt;
      job.lockedBy = req.user.id;
    }
    await job.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "moh.export_job.approval",
      entityType: "moh_export_job",
      entityId: job.id,
      metadata: {
        decision,
        reason,
        locked: Boolean(job.locked),
        checksum: job.checksum || null,
        approvalSignatureHash,
      },
    });

    return res.json({
      job: {
        id: job.id,
        approvalStatus: job.approvalStatus || "pending",
        approvalReason: job.approvalReason || null,
        approvalReviewerId: job.approvalReviewerId || null,
        approvalReviewedAt: job.approvalReviewedAt || null,
        approvalSignatureHash: job.approvalSignatureHash || null,
        locked: Boolean(job.locked),
        lockedAt: job.lockedAt || null,
        lockedBy: job.lockedBy || null,
      },
    });
  }
);

router.post(
  "/export-jobs/:id/unlock",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "exportUnlock")) return;
    const job = await MohExportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: "Export job not found" });
    if (!job.locked) return res.status(409).json({ error: "Export job is not locked" });

    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ error: "second-review reason is required" });
    }

    // Two-person control: unlock reviewer must be different from lock owner.
    if (String(job.lockedBy || "") === String(req.user.id || "")) {
      return res.status(403).json({ error: "Two-person control violation: locker cannot unlock own decision" });
    }

    const reviewedAt = new Date().toISOString();
    const unlockSignaturePayload = JSON.stringify({
      jobId: job.id,
      checksum: job.checksum || null,
      lockedBy: job.lockedBy || null,
      unlockReviewer: req.user.id,
      reviewedAt,
      reason,
    });
    const unlockSignatureHash = crypto.createHash("sha256").update(unlockSignaturePayload).digest("hex");

    job.locked = false;
    job.unlockedAt = reviewedAt;
    job.unlockedBy = req.user.id;
    job.unlockReason = reason;
    job.unlockSignatureHash = unlockSignatureHash;
    await job.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "moh.export_job.unlock",
      entityType: "moh_export_job",
      entityId: job.id,
      metadata: {
        reason,
        lockedBy: job.lockedBy || null,
        unlockedBy: req.user.id,
        unlockSignatureHash,
      },
    });

    return res.json({
      job: {
        id: job.id,
        locked: Boolean(job.locked),
        lockedBy: job.lockedBy || null,
        lockedAt: job.lockedAt || null,
        unlockedBy: job.unlockedBy || null,
        unlockedAt: job.unlockedAt || null,
        unlockReason: job.unlockReason || null,
        unlockSignatureHash: job.unlockSignatureHash || null,
      },
    });
  }
);

router.get(
  "/export-jobs",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "view")) return;
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 30)));
    const offset = Math.max(0, Number(req.query?.offset || 0));
    const statusFilter = String(req.query?.status || "all").toLowerCase();
    const formatFilter = String(req.query?.format || "all").toLowerCase();
    const searchFilter = String(req.query?.search || "").trim().toLowerCase();
    const rows = await MohExportJob.findAll({});
    const filtered = rows
      .filter((entry) => {
        if (statusFilter !== "all" && String(entry.status || "").toLowerCase() !== statusFilter) return false;
        if (formatFilter !== "all" && String(entry.format || "").toLowerCase() !== formatFilter) return false;
        if (searchFilter) {
          const haystack = [
            entry.id,
            entry.scope,
            entry.fileName,
            entry.createdBy,
            entry.generatedBy,
            entry.checksum,
          ]
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(searchFilter)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const jobs = filtered.slice(offset, offset + limit).map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      format: entry.format,
      status: entry.status,
      immutable: Boolean(entry.immutable),
      approvalStatus: entry.approvalStatus || "pending",
      approvalReason: entry.approvalReason || null,
      approvalReviewerId: entry.approvalReviewerId || null,
      approvalReviewedAt: entry.approvalReviewedAt || null,
      approvalSignatureHash: entry.approvalSignatureHash || null,
      locked: Boolean(entry.locked),
      lockedAt: entry.lockedAt || null,
      lockedBy: entry.lockedBy || null,
      unlockedAt: entry.unlockedAt || null,
      unlockedBy: entry.unlockedBy || null,
      unlockReason: entry.unlockReason || null,
      unlockSignatureHash: entry.unlockSignatureHash || null,
      rowCount: Number(entry.rowCount || 0),
      checksum: entry.checksum || null,
      fileName: entry.fileName || null,
      filters: entry.filters || {},
      createdBy: entry.createdBy || null,
      generatedBy: entry.generatedBy || null,
      generatedAt: entry.generatedAt || null,
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    }));
    return res.json({
      jobs,
      total: filtered.length,
      limit,
      offset,
    });
  }
);

router.get(
  "/export-jobs/:id/download",
  requireAuth,
  requireRoles(["moh", "admin"]),
  async (req, res) => {
    if (!ensureMohPermission(req, res, "exportDownload")) return;
    const job = await MohExportJob.findByPk(req.params.id);
    if (!job) return res.status(404).json({ error: "Export job not found" });
    const format = String(job.format || "csv").toLowerCase();
    const fileName = job.fileName || `moh-export-${job.id}.${format === "csv" ? "csv" : "html"}`;
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
    } else {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.status(200).send(job.content || "");
  }
);

module.exports = router;

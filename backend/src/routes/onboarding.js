const express = require("express");
const { EntityRegistration, User } = require("../models");
const { normalizeEmail } = require("../utils/crypto");
const { writeAudit } = require("../utils/audit");

const router = express.Router();

const normalizeOnboardingPayload = (role, payload = {}) => {
  const base = {
    role,
    fullName: String(payload.fullName || "").trim(),
    email: normalizeEmail(payload.email || ""),
    phone: String(payload.phone || "").trim(),
    status: "pending",
    submittedAt: new Date().toISOString(),
    submittedBy: null,
    source: "public_onboarding",
  };
  const credentials = payload.credentials || {};
  if (role === "doctor") {
    base.credentials = {
      licenseNumber: String(credentials.licenseNumber || "").trim(),
      issuingBody: String(credentials.issuingBody || "").trim(),
      clinicName: String(credentials.clinicName || "").trim(),
      practiceAddress: String(credentials.practiceAddress || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
    };
  } else if (role === "pharmacy") {
    base.credentials = {
      registeredName: String(credentials.registeredName || "").trim(),
      councilReg: String(credentials.councilReg || "").trim(),
      pharmacistInCharge: String(credentials.pharmacistInCharge || "").trim(),
      address: String(credentials.address || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
    };
  } else if (role === "courier") {
    base.credentials = {
      vehicleType: String(credentials.vehicleType || "").trim(),
      serviceZone: String(credentials.serviceZone || "").trim(),
      governmentId: String(credentials.governmentId || "").trim(),
      address: String(credentials.address || "").trim(),
    };
  } else {
    base.credentials = {};
  }
  return base;
};

const validateOnboarding = async (entry) => {
  if (!entry.fullName || !entry.email || !entry.phone) {
    return "fullName, email, and phone are required";
  }
  if (entry.role === "doctor") {
    const { licenseNumber, issuingBody, clinicName, practiceAddress, registryUrl } = entry.credentials || {};
    if (!licenseNumber || !issuingBody || !clinicName || !practiceAddress) {
      return "doctor credentials are incomplete";
    }
    if (registryUrl && !registryUrl.startsWith("http")) return "doctor registry URL must start with http";
  }
  if (entry.role === "pharmacy") {
    const { registeredName, councilReg, pharmacistInCharge, address, registryUrl } = entry.credentials || {};
    if (!registeredName || !councilReg || !pharmacistInCharge || !address) {
      return "pharmacy credentials are incomplete";
    }
    if (registryUrl && !registryUrl.startsWith("http")) return "pharmacy registry URL must start with http";
  }
  if (entry.role === "courier") {
    const { vehicleType, serviceZone } = entry.credentials || {};
    if (!vehicleType || !serviceZone) {
      return "courier credentials are incomplete";
    }
  }
  const existingUser = await User.findOne({ where: { email: entry.email } });
  if (existingUser) return "email already registered";
  const existingPending = await EntityRegistration.findOne({
    where: { email: entry.email, role: entry.role, status: "pending" },
  });
  if (existingPending) return "a pending onboarding request already exists for this email";
  return "";
};

router.post("/", async (req, res) => {
  const role = String(req.body?.role || "").trim().toLowerCase();
  if (!["doctor", "pharmacy", "courier"].includes(role)) {
    return res.status(400).json({ error: "role must be doctor, pharmacy, or courier" });
  }
  const entry = normalizeOnboardingPayload(role, req.body || {});
  const validationError = await validateOnboarding(entry);
  if (validationError) return res.status(400).json({ error: validationError });

  const registration = await EntityRegistration.create(entry);
  await writeAudit({
    actorUserId: null,
    action: "onboarding.request.create",
    entityType: "entity_registration",
    entityId: registration.id,
    metadata: { role, source: "public_onboarding" },
  });
  return res.status(201).json({ registration });
});

module.exports = router;


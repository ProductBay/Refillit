const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  AuditLog,
  User,
  MohPolicy,
  DoctorProfile,
  PharmacyProfile,
  NhfProfile,
  CourierProfile,
  EntityRegistration,
} = require("../models");
const { writeAudit } = require("../utils/audit");
const { normalizeEmail } = require("../utils/crypto");
const { hashPassword } = require("../utils/password");
const { signAccessToken } = require("../utils/jwt");

const router = express.Router();

router.get("/audit", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  const actorFilter = String(req.query.actor || "").trim();
  const actionFilter = String(req.query.action || "").trim().toLowerCase();
  const entityFilter = String(req.query.entity || "").trim().toLowerCase();
  const searchFilter = String(req.query.search || "").trim().toLowerCase();
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59`) : null;
  const rows = await AuditLog.findAll({});
  const filtered = rows
    .filter((log) => {
      if (actorFilter && String(log.actorUserId || "") !== actorFilter) return false;
      if (actionFilter && !String(log.action || "").toLowerCase().includes(actionFilter)) return false;
      if (entityFilter) {
        const haystack = `${log.entityType || ""}:${log.entityId || ""}`.toLowerCase();
        if (!haystack.includes(entityFilter)) return false;
      }
      if (searchFilter) {
        const haystack = [
          log.id,
          log.action,
          log.actorUserId,
          log.entityType,
          log.entityId,
          JSON.stringify(log.metadata || {}),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(searchFilter)) return false;
      }
      const createdAt = new Date(log.createdAt || 0);
      if (from && (!createdAt || createdAt < from)) return false;
      if (to && (!createdAt || createdAt > to)) return false;
      return true;
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const logs = filtered.slice(offset, offset + limit);
  res.json({ total: filtered.length, logs });
});

router.get("/moh-users", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();
  const users = await User.findAll({});
  const mohUsers = users
    .filter((user) => String(user.role || "").toLowerCase() === "moh")
    .filter((user) => {
      if (!search) return true;
      const haystack = [
        user.id,
        user.fullName,
        user.email,
        user.platformStaffId,
        user.mohRole,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    })
    .map((user) => ({
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      platformStaffId: user.platformStaffId || null,
      mohRole: user.mohRole || "analyst",
      mohLocked: Boolean(user.mohLocked),
      mohLockReason: user.mohLockReason || null,
      mohLockedAt: user.mohLockedAt || null,
      mohLockedBy: user.mohLockedBy || null,
      createdAt: user.createdAt || null,
    }))
    .sort((a, b) => String(a.fullName || "").localeCompare(String(b.fullName || "")));
  res.json({ users: mohUsers });
});

router.post("/moh-users", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const fullName = String(req.body?.fullName || "").trim();
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "").trim();
  const mohRole = String(req.body?.mohRole || "analyst").trim().toLowerCase();
  const allowed = ["analyst", "auditor", "supervisor"];
  if (!fullName || !email || !password) {
    return res.status(400).json({ error: "fullName, email, password are required" });
  }
  if (!allowed.includes(mohRole)) {
    return res.status(400).json({ error: "mohRole must be analyst, auditor, or supervisor" });
  }
  const normalized = normalizeEmail(email);
  const existing = await User.findOne({ where: { email: normalized } });
  if (existing) {
    return res.status(409).json({ error: "User already exists" });
  }
  const user = await User.create({
    fullName,
    email: normalized,
    role: "moh",
    mohRole,
    passwordHash: await hashPassword(password),
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.moh_user.create",
    entityType: "user",
    entityId: user.id,
    metadata: { mohRole },
  });
  return res.status(201).json({
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      mohRole: user.mohRole || "analyst",
    },
  });
});

router.post("/moh-users/:id/role", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || String(user.role || "").toLowerCase() !== "moh") {
    return res.status(404).json({ error: "MOH user not found" });
  }
  const nextRole = String(req.body?.mohRole || "").trim().toLowerCase();
  const allowed = ["analyst", "auditor", "supervisor"];
  if (!allowed.includes(nextRole)) {
    return res.status(400).json({ error: "mohRole must be analyst, auditor, or supervisor" });
  }
  user.mohRole = nextRole;
  await user.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.moh_role.update",
    entityType: "user",
    entityId: user.id,
    metadata: { mohRole: nextRole },
  });
  return res.json({
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      platformStaffId: user.platformStaffId || null,
      mohRole: user.mohRole || "analyst",
    },
  });
});

router.post("/moh-users/:id/lock", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user || String(user.role || "").toLowerCase() !== "moh") {
    return res.status(404).json({ error: "MOH user not found" });
  }
  const locked = Boolean(req.body?.locked);
  const reason = String(req.body?.reason || "").trim();
  user.mohLocked = locked;
  user.mohLockReason = locked ? reason || "Administrative lock" : null;
  user.mohLockedAt = locked ? new Date().toISOString() : null;
  user.mohLockedBy = locked ? req.user.id : null;
  await user.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: locked ? "admin.moh_user.lock" : "admin.moh_user.unlock",
    entityType: "user",
    entityId: user.id,
    metadata: { reason: user.mohLockReason },
  });
  return res.json({
    user: {
      id: user.id,
      mohLocked: Boolean(user.mohLocked),
      mohLockReason: user.mohLockReason || null,
      mohLockedAt: user.mohLockedAt || null,
      mohLockedBy: user.mohLockedBy || null,
    },
  });
});

router.post("/impersonate/:id", requireAuth, requireRoles(["admin"]), async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ error: "Impersonation disabled in production" });
  }
  const user = await User.findByPk(req.params.id);
  if (!user || String(user.role || "").toLowerCase() !== "moh") {
    return res.status(404).json({ error: "MOH user not found" });
  }
  const token = signAccessToken({ id: user.id, role: user.role });
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.moh_user.impersonate",
    entityType: "user",
    entityId: user.id,
  });
  return res.json({ user, token });
});

router.get("/moh-policies", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();
  const policies = await MohPolicy.findAll({});
  const rows = policies
    .filter((policy) => {
      if (!search) return true;
      const haystack = [policy.code, policy.name, policy.description, policy.status].join(" ").toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ policies: rows });
});

router.post("/moh-policies", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const name = String(req.body?.name || "").trim();
  const description = String(req.body?.description || "").trim();
  const status = String(req.body?.status || "active").trim().toLowerCase();
  if (!code || !name) {
    return res.status(400).json({ error: "code and name are required" });
  }
  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be active or inactive" });
  }
  const existing = await MohPolicy.findOne({ where: { code } });
  if (existing) {
    return res.status(409).json({ error: "Policy code already exists" });
  }
  const policy = await MohPolicy.create({
    code,
    name,
    description: description || null,
    status,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.moh_policy.create",
    entityType: "moh_policy",
    entityId: policy.id,
    metadata: { code, status },
  });
  return res.status(201).json({ policy });
});

router.put("/moh-policies/:id", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const policy = await MohPolicy.findByPk(req.params.id);
  if (!policy) {
    return res.status(404).json({ error: "Policy not found" });
  }
  const code = String(req.body?.code || policy.code || "").trim();
  const name = String(req.body?.name || policy.name || "").trim();
  const description = String(req.body?.description || "").trim();
  const status = String(req.body?.status || policy.status || "active").trim().toLowerCase();
  if (!code || !name) {
    return res.status(400).json({ error: "code and name are required" });
  }
  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ error: "status must be active or inactive" });
  }
  if (code !== policy.code) {
    const existing = await MohPolicy.findOne({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: "Policy code already exists" });
    }
  }
  policy.code = code;
  policy.name = name;
  policy.description = description || null;
  policy.status = status;
  await policy.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.moh_policy.update",
    entityType: "moh_policy",
    entityId: policy.id,
    metadata: { code, status },
  });
  return res.json({ policy });
});

const normalizeRegistrationPayload = (role, payload = {}) => {
  const base = {
    role,
    fullName: String(payload.fullName || "").trim(),
    email: normalizeEmail(payload.email || ""),
    phone: String(payload.phone || "").trim(),
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  const credentials = payload.credentials || {};
  if (role === "doctor") {
    base.credentials = {
      licenseNumber: String(credentials.licenseNumber || "").trim(),
      issuingBody: String(credentials.issuingBody || "").trim(),
      issuingCountry: String(credentials.issuingCountry || "").trim(),
      licenseExpiry: String(credentials.licenseExpiry || "").trim(),
      licenseClass: String(credentials.licenseClass || "").trim(),
      medicalCouncilId: String(credentials.medicalCouncilId || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
      notarizedDocIds: Array.isArray(credentials.notarizedDocIds)
        ? credentials.notarizedDocIds.map((id) => String(id || "").trim()).filter(Boolean)
        : String(credentials.notarizedDocIds || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
      clinicName: String(credentials.clinicName || "").trim(),
      clinicOwnershipType: String(credentials.clinicOwnershipType || "").trim(),
      practiceAddress: String(credentials.practiceAddress || "").trim(),
      parish: String(credentials.parish || "").trim(),
      contactPhone: String(credentials.contactPhone || "").trim(),
      governmentIdType: String(credentials.governmentIdType || "").trim(),
      governmentIdNumber: String(credentials.governmentIdNumber || "").trim(),
      professionalIndemnityPolicy: String(credentials.professionalIndemnityPolicy || "").trim(),
      professionalIndemnityExpiry: String(credentials.professionalIndemnityExpiry || "").trim(),
      specialty: String(credentials.specialty || "").trim(),
      subSpecialty: String(credentials.subSpecialty || "").trim(),
      dateOfBirth: String(credentials.dateOfBirth || "").trim(),
    };
  } else if (role === "pharmacy") {
    base.credentials = {
      registeredName: String(credentials.registeredName || "").trim(),
      councilReg: String(credentials.councilReg || "").trim(),
      businessRegNumber: String(credentials.businessRegNumber || "").trim(),
      pharmacistInCharge: String(credentials.pharmacistInCharge || "").trim(),
      pharmacistInChargeLicense: String(credentials.pharmacistInChargeLicense || "").trim(),
      issuingCountry: String(credentials.issuingCountry || "").trim(),
      licenseExpiry: String(credentials.licenseExpiry || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
      contactPhone: String(credentials.contactPhone || "").trim(),
      parish: String(credentials.parish || "").trim(),
      nhfParticipant: Boolean(credentials.nhfParticipant),
      nhfRegistryId: String(credentials.nhfRegistryId || "").trim(),
      controlledSubstanceLicense: String(credentials.controlledSubstanceLicense || "").trim(),
      controlledSubstanceExpiry: String(credentials.controlledSubstanceExpiry || "").trim(),
      insurancePolicyNumber: String(credentials.insurancePolicyNumber || "").trim(),
      insurancePolicyExpiry: String(credentials.insurancePolicyExpiry || "").trim(),
      notarizedDocIds: Array.isArray(credentials.notarizedDocIds)
        ? credentials.notarizedDocIds.map((id) => String(id || "").trim()).filter(Boolean)
        : String(credentials.notarizedDocIds || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
      address: String(credentials.address || "").trim(),
    };
  } else if (role === "nhf") {
    base.credentials = {
      organizationName: String(credentials.organizationName || "").trim(),
      registryId: String(credentials.registryId || "").trim(),
      contactPerson: String(credentials.contactPerson || "").trim(),
      nhfRole: String(credentials.nhfRole || "analyst").trim().toLowerCase(),
      issuingCountry: String(credentials.issuingCountry || "").trim(),
      licenseExpiry: String(credentials.licenseExpiry || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
      notarizedDocIds: Array.isArray(credentials.notarizedDocIds)
        ? credentials.notarizedDocIds.map((id) => String(id || "").trim()).filter(Boolean)
        : String(credentials.notarizedDocIds || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
      address: String(credentials.address || "").trim(),
    };
  } else if (role === "moh") {
    base.credentials = {
      employeeId: String(credentials.employeeId || "").trim(),
      department: String(credentials.department || "").trim(),
      region: String(credentials.region || "").trim(),
      mohRole: String(credentials.mohRole || "analyst").trim().toLowerCase(),
    };
  } else if (role === "courier") {
    base.credentials = {
      governmentIdType: String(credentials.governmentIdType || "").trim(),
      governmentIdNumber: String(credentials.governmentIdNumber || "").trim(),
      trn: String(credentials.trn || "").trim(),
      dateOfBirth: String(credentials.dateOfBirth || "").trim(),
      driverLicenseNumber: String(credentials.driverLicenseNumber || "").trim(),
      driverLicenseClass: String(credentials.driverLicenseClass || "").trim(),
      driverLicenseExpiry: String(credentials.driverLicenseExpiry || "").trim(),
      driverLicenseIssuingCountry: String(credentials.driverLicenseIssuingCountry || "").trim(),
      policeRecordNumber: String(credentials.policeRecordNumber || "").trim(),
      policeRecordExpiry: String(credentials.policeRecordExpiry || "").trim(),
      vehicleType: String(credentials.vehicleType || "").trim(),
      vehiclePlateNumber: String(credentials.vehiclePlateNumber || "").trim(),
      vehicleRegistrationNumber: String(credentials.vehicleRegistrationNumber || "").trim(),
      vehicleMakeModel: String(credentials.vehicleMakeModel || "").trim(),
      vehicleYear: String(credentials.vehicleYear || "").trim(),
      vehicleColor: String(credentials.vehicleColor || "").trim(),
      vehicleInsuranceProvider: String(credentials.vehicleInsuranceProvider || "").trim(),
      vehicleInsurancePolicyNumber: String(credentials.vehicleInsurancePolicyNumber || "").trim(),
      vehicleInsuranceExpiry: String(credentials.vehicleInsuranceExpiry || "").trim(),
      serviceZone: String(credentials.serviceZone || "").trim(),
      address: String(credentials.address || "").trim(),
      parish: String(credentials.parish || "").trim(),
      emergencyContactName: String(credentials.emergencyContactName || "").trim(),
      emergencyContactPhone: String(credentials.emergencyContactPhone || "").trim(),
      emergencyContactRelation: String(credentials.emergencyContactRelation || "").trim(),
      registryUrl: String(credentials.registryUrl || "").trim(),
      notarizedDocIds: Array.isArray(credentials.notarizedDocIds)
        ? credentials.notarizedDocIds.map((id) => String(id || "").trim()).filter(Boolean)
        : String(credentials.notarizedDocIds || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
    };
  } else {
    base.credentials = {};
  }
  return base;
};

const validateRegistration = async (entry) => {
  if (!entry.fullName || !entry.email) {
    return "fullName and email are required";
  }
  if (!entry.phone) {
    return "phone is required";
  }
  if (entry.role === "doctor") {
    const {
      licenseNumber,
      issuingBody,
      clinicName,
      practiceAddress,
      registryUrl,
      licenseExpiry,
      licenseClass,
      medicalCouncilId,
      parish,
      contactPhone,
      governmentIdType,
      governmentIdNumber,
      professionalIndemnityPolicy,
      professionalIndemnityExpiry,
      specialty,
      dateOfBirth,
    } =
      entry.credentials || {};
    if (!licenseNumber || !issuingBody || !clinicName || !practiceAddress) {
      return "doctor credentials are incomplete";
    }
    if (!licenseClass || !medicalCouncilId || !parish || !contactPhone) {
      return "doctor license class, council ID, parish, and contact phone are required";
    }
    if (!governmentIdType || !governmentIdNumber) {
      return "doctor government ID type and number are required";
    }
    if (!professionalIndemnityPolicy || !professionalIndemnityExpiry) {
      return "professional indemnity policy and expiry are required";
    }
    if (!specialty) return "doctor specialty is required";
    if (!dateOfBirth) return "doctor date of birth is required";
    if (registryUrl && !registryUrl.startsWith("http")) return "doctor registry URL must start with http";
    if (licenseExpiry && Number.isNaN(Date.parse(licenseExpiry))) return "doctor license expiry is invalid";
    if (professionalIndemnityExpiry && Number.isNaN(Date.parse(professionalIndemnityExpiry))) {
      return "professional indemnity expiry is invalid";
    }
    if (dateOfBirth && Number.isNaN(Date.parse(dateOfBirth))) return "doctor date of birth is invalid";
    const existing = await DoctorProfile.findOne({ where: { licenseNumber } });
    if (existing) return "doctor license already registered";
  }
  if (entry.role === "pharmacy") {
    const {
      councilReg,
      businessRegNumber,
      registeredName,
      pharmacistInCharge,
      registryUrl,
      licenseExpiry,
      pharmacistInChargeLicense,
      contactPhone,
      parish,
      controlledSubstanceLicense,
      controlledSubstanceExpiry,
      insurancePolicyNumber,
      insurancePolicyExpiry,
    } =
      entry.credentials || {};
    if (!councilReg || !businessRegNumber || !registeredName || !pharmacistInCharge) {
      return "pharmacy credentials are incomplete";
    }
    if (!pharmacistInChargeLicense) return "pharmacist-in-charge license is required";
    if (!contactPhone || !parish) return "pharmacy contact phone and parish are required";
    if (!controlledSubstanceLicense || !controlledSubstanceExpiry) {
      return "controlled substance license and expiry are required";
    }
    if (!insurancePolicyNumber || !insurancePolicyExpiry) {
      return "pharmacy insurance policy and expiry are required";
    }
    if (registryUrl && !registryUrl.startsWith("http")) return "pharmacy registry URL must start with http";
    if (licenseExpiry && Number.isNaN(Date.parse(licenseExpiry))) return "pharmacy license expiry is invalid";
    if (controlledSubstanceExpiry && Number.isNaN(Date.parse(controlledSubstanceExpiry))) {
      return "controlled substance expiry is invalid";
    }
    if (insurancePolicyExpiry && Number.isNaN(Date.parse(insurancePolicyExpiry))) {
      return "pharmacy insurance expiry is invalid";
    }
    const existing = await PharmacyProfile.findOne({ where: { councilReg } });
    if (existing) return "pharmacy council registration already registered";
  }
  if (entry.role === "nhf") {
    const { registryId, organizationName, registryUrl, licenseExpiry, nhfRole } = entry.credentials || {};
    if (!registryId || !organizationName) return "nhf credentials are incomplete";
    if (nhfRole && !["analyst", "reviewer", "finance", "supervisor", "auditor"].includes(nhfRole)) {
      return "nhfRole must be analyst, reviewer, finance, supervisor, or auditor";
    }
    if (registryUrl && !registryUrl.startsWith("http")) return "nhf registry URL must start with http";
    if (licenseExpiry && Number.isNaN(Date.parse(licenseExpiry))) return "nhf license expiry is invalid";
    const existing = await NhfProfile.findOne({ where: { registryId } });
    if (existing) return "nhf registry id already registered";
  }
  if (entry.role === "moh") {
    const { employeeId } = entry.credentials || {};
    if (!employeeId) return "moh employee id is required";
    const existing = await User.findOne({ where: { mohEmployeeId: employeeId } });
    if (existing) return "moh employee id already registered";
  }
  if (entry.role === "courier") {
    const {
      governmentIdType,
      governmentIdNumber,
      dateOfBirth,
      driverLicenseNumber,
      driverLicenseClass,
      driverLicenseExpiry,
      policeRecordNumber,
      policeRecordExpiry,
      vehicleType,
      vehiclePlateNumber,
      vehicleRegistrationNumber,
      vehicleInsurancePolicyNumber,
      vehicleInsuranceExpiry,
      serviceZone,
      address,
      parish,
      emergencyContactName,
      emergencyContactPhone,
      registryUrl,
    } = entry.credentials || {};
    if (!governmentIdType || !governmentIdNumber || !dateOfBirth) return "courier identity fields are required";
    if (!driverLicenseNumber || !driverLicenseClass || !driverLicenseExpiry) return "driver license fields are required";
    if (!policeRecordNumber || !policeRecordExpiry) return "police record fields are required";
    if (!vehicleType || !vehiclePlateNumber || !vehicleRegistrationNumber) return "vehicle fields are required";
    if (!vehicleInsurancePolicyNumber || !vehicleInsuranceExpiry) return "vehicle insurance fields are required";
    if (!serviceZone || !address || !parish) return "courier address/service zone required";
    if (!emergencyContactName || !emergencyContactPhone) return "emergency contact required";
    if (registryUrl && !registryUrl.startsWith("http")) return "courier registry URL must start with http";
    if (driverLicenseExpiry && Number.isNaN(Date.parse(driverLicenseExpiry))) return "driver license expiry is invalid";
    if (policeRecordExpiry && Number.isNaN(Date.parse(policeRecordExpiry))) return "police record expiry is invalid";
    if (vehicleInsuranceExpiry && Number.isNaN(Date.parse(vehicleInsuranceExpiry))) return "vehicle insurance expiry is invalid";
    if (dateOfBirth && Number.isNaN(Date.parse(dateOfBirth))) return "date of birth is invalid";
  }
  const existingUser = await User.findOne({ where: { email: entry.email } });
  if (existingUser) return "email already registered";
  return "";
};

router.get("/registrations", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const status = String(req.query.status || "all").trim().toLowerCase();
  const role = String(req.query.role || "all").trim().toLowerCase();
  const search = String(req.query.search || "").trim().toLowerCase();
  const registrations = await EntityRegistration.findAll({});
  const rows = registrations
    .filter((entry) => (status === "all" ? true : String(entry.status || "") === status))
    .filter((entry) => (role === "all" ? true : String(entry.role || "") === role))
    .filter((entry) => {
      if (!search) return true;
      const haystack = [
        entry.id,
        entry.fullName,
        entry.email,
        entry.role,
        entry.status,
        JSON.stringify(entry.credentials || {}),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    })
    .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
  res.json({ registrations: rows });
});

router.post("/registrations", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const role = String(req.body?.role || "").trim().toLowerCase();
  if (!["doctor", "pharmacy", "courier", "nhf", "moh"].includes(role)) {
    return res.status(400).json({ error: "role must be doctor, pharmacy, courier, nhf, or moh" });
  }
  const entry = normalizeRegistrationPayload(role, req.body || {});
  const validationError = await validateRegistration(entry);
  if (validationError) return res.status(400).json({ error: validationError });
  const registration = await EntityRegistration.create({
    ...entry,
    submittedBy: req.user.id,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.registration.create",
    entityType: "entity_registration",
    entityId: registration.id,
    metadata: { role },
  });
  return res.status(201).json({ registration });
});

router.post("/registrations/:id/decision", requireAuth, requireRoles(["admin"]), async (req, res) => {
  const registration = await EntityRegistration.findByPk(req.params.id);
  if (!registration) return res.status(404).json({ error: "Registration not found" });
  if (registration.status !== "pending") {
    return res.status(409).json({ error: "Registration already reviewed" });
  }
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "decision must be approved or rejected" });
  }
  const reason = String(req.body?.reason || "").trim();
  registration.status = decision;
  registration.reviewedAt = new Date().toISOString();
  registration.reviewedBy = req.user.id;
  registration.reviewReason = reason || null;

  let user = null;
  if (decision === "approved") {
    const password = String(req.body?.tempPassword || "").trim() || "Refillit123!";
    const passwordHash = await hashPassword(password);
    user = await User.create({
      fullName: registration.fullName,
      email: registration.email,
      role: registration.role,
      passwordHash,
      nhfRole: registration.role === "nhf" ? registration.credentials?.nhfRole || "analyst" : undefined,
      mohRole: registration.role === "moh" ? registration.credentials?.mohRole || "analyst" : undefined,
      mohEmployeeId: registration.role === "moh" ? registration.credentials?.employeeId || null : undefined,
      mohDepartment: registration.role === "moh" ? registration.credentials?.department || null : undefined,
      mohRegion: registration.role === "moh" ? registration.credentials?.region || null : undefined,
    });
    if (registration.role === "doctor") {
      await DoctorProfile.create({
        userId: user.id,
        licenseNumber: registration.credentials?.licenseNumber || "",
        licenseExpiry: registration.credentials?.licenseExpiry || null,
        licenseClass: registration.credentials?.licenseClass || null,
        medicalCouncilId: registration.credentials?.medicalCouncilId || null,
        issuingCountry: registration.credentials?.issuingCountry || null,
        registryUrl: registration.credentials?.registryUrl || null,
        notarizedDocIds: registration.credentials?.notarizedDocIds || [],
        mohVerified: true,
        clinicInfo: {
          name: registration.credentials?.clinicName || "",
          issuingBody: registration.credentials?.issuingBody || "",
          address: registration.credentials?.practiceAddress || "",
          phone: registration.credentials?.contactPhone || registration.phone || "",
          parish: registration.credentials?.parish || "",
          ownershipType: registration.credentials?.clinicOwnershipType || "",
        },
        governmentIdType: registration.credentials?.governmentIdType || null,
        governmentIdNumber: registration.credentials?.governmentIdNumber || null,
        professionalIndemnityPolicy: registration.credentials?.professionalIndemnityPolicy || null,
        professionalIndemnityExpiry: registration.credentials?.professionalIndemnityExpiry || null,
        specialty: registration.credentials?.specialty || null,
        subSpecialty: registration.credentials?.subSpecialty || null,
        dateOfBirth: registration.credentials?.dateOfBirth || null,
      });
    } else if (registration.role === "pharmacy") {
      await PharmacyProfile.create({
        userId: user.id,
        councilReg: registration.credentials?.councilReg || "",
        registeredName: registration.credentials?.registeredName || registration.fullName,
        licenseExpiry: registration.credentials?.licenseExpiry || null,
        issuingCountry: registration.credentials?.issuingCountry || null,
        registryUrl: registration.credentials?.registryUrl || null,
        notarizedDocIds: registration.credentials?.notarizedDocIds || [],
        city: "Kingston",
        town: registration.credentials?.parish || "Kingston",
        pharmacists: registration.credentials?.pharmacistInCharge
          ? [{
              name: registration.credentials.pharmacistInCharge,
              employeeId: "PH-NEW",
              licenseNumber: registration.credentials?.pharmacistInChargeLicense || "",
            }]
          : [],
        branches: [
          {
            branchId: "main",
            address: registration.credentials?.address || "",
            coords: { lat: 0, lng: 0 },
            hours: "9am-5pm",
          },
        ],
        businessRegNumber: registration.credentials?.businessRegNumber || null,
        contactPhone: registration.credentials?.contactPhone || null,
        parish: registration.credentials?.parish || null,
        nhfParticipant: Boolean(registration.credentials?.nhfParticipant),
        nhfRegistryId: registration.credentials?.nhfRegistryId || null,
        controlledSubstanceLicense: registration.credentials?.controlledSubstanceLicense || null,
        controlledSubstanceExpiry: registration.credentials?.controlledSubstanceExpiry || null,
        insurancePolicyNumber: registration.credentials?.insurancePolicyNumber || null,
        insurancePolicyExpiry: registration.credentials?.insurancePolicyExpiry || null,
      });
    } else if (registration.role === "nhf") {
      await NhfProfile.create({
        userId: user.id,
        registryId: registration.credentials?.registryId || "",
        organizationName: registration.credentials?.organizationName || registration.fullName,
        contactPerson: registration.credentials?.contactPerson || registration.fullName,
        licenseExpiry: registration.credentials?.licenseExpiry || null,
        issuingCountry: registration.credentials?.issuingCountry || null,
        registryUrl: registration.credentials?.registryUrl || null,
        notarizedDocIds: registration.credentials?.notarizedDocIds || [],
        address: registration.credentials?.address || "",
        phone: registration.phone || "",
      });
    } else if (registration.role === "courier") {
      await CourierProfile.create({
        userId: user.id,
        governmentIdType: registration.credentials?.governmentIdType || "",
        governmentIdNumber: registration.credentials?.governmentIdNumber || "",
        trn: registration.credentials?.trn || null,
        dateOfBirth: registration.credentials?.dateOfBirth || null,
        driverLicenseNumber: registration.credentials?.driverLicenseNumber || "",
        driverLicenseClass: registration.credentials?.driverLicenseClass || "",
        driverLicenseExpiry: registration.credentials?.driverLicenseExpiry || null,
        driverLicenseIssuingCountry: registration.credentials?.driverLicenseIssuingCountry || null,
        policeRecordNumber: registration.credentials?.policeRecordNumber || "",
        policeRecordExpiry: registration.credentials?.policeRecordExpiry || null,
        vehicleType: registration.credentials?.vehicleType || "",
        vehiclePlateNumber: registration.credentials?.vehiclePlateNumber || "",
        vehicleRegistrationNumber: registration.credentials?.vehicleRegistrationNumber || "",
        vehicleMakeModel: registration.credentials?.vehicleMakeModel || null,
        vehicleYear: registration.credentials?.vehicleYear || null,
        vehicleColor: registration.credentials?.vehicleColor || null,
        vehicleInsuranceProvider: registration.credentials?.vehicleInsuranceProvider || null,
        vehicleInsurancePolicyNumber: registration.credentials?.vehicleInsurancePolicyNumber || "",
        vehicleInsuranceExpiry: registration.credentials?.vehicleInsuranceExpiry || null,
        serviceZone: registration.credentials?.serviceZone || "",
        address: registration.credentials?.address || "",
        parish: registration.credentials?.parish || "",
        emergencyContactName: registration.credentials?.emergencyContactName || "",
        emergencyContactPhone: registration.credentials?.emergencyContactPhone || "",
        emergencyContactRelation: registration.credentials?.emergencyContactRelation || null,
        registryUrl: registration.credentials?.registryUrl || null,
        notarizedDocIds: registration.credentials?.notarizedDocIds || [],
      });
    }
  }

  await registration.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "admin.registration.decision",
    entityType: "entity_registration",
    entityId: registration.id,
    metadata: { decision, reason },
  });
  return res.json({ registration, user });
});

router.get("/id-resolve", requireAuth, requireRoles(["admin"]), async (req, res) => {
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
      profile.governmentIdNumber,
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

module.exports = router;

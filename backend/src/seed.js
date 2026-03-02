require("./config/env");

const { sequelize } = require("./db");
  const {
    initModels,
    DoctorProfile,
    PatientProfile,
    PharmacyProfile,
    User,
    Prescription,
    Order,
    Appointment,
    NhfClaim,
    NhfDispute,
    MohPolicy,
    MohClinicalCatalogEntry,
    WalletLedger,
    NhfCreditLedger,
    ComplianceReportSnapshot,
  } = require("./models");
const { hashPassword } = require("./utils/password");
const { hashIdentifier, normalizeEmail } = require("./utils/crypto");
const { encryptValue } = require("./utils/fieldCrypto");
const { ensurePlatformStaffId } = require("./utils/platformStaffId");

const DEFAULT_PASSWORD = "Refillit123!";
const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

const seedUsers = async () => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Seeding is disabled in production.");
  }

  const password = process.env.DEV_SEED_PASSWORD || DEFAULT_PASSWORD;
  const passwordHash = await hashPassword(password);

  const users = [
    { role: "admin", fullName: "Admin User", email: "admin@refillit.dev" },
    { role: "doctor", fullName: "Doctor User", email: "doctor@refillit.dev" },
    { role: "receptionist", fullName: "Receptionist User", email: "receptionist@refillit.dev" },
    { role: "pharmacy", fullName: "Pharmacy User", email: "pharmacy@refillit.dev" },
    { role: "courier", fullName: "Courier User", email: "courier@refillit.dev" },
    { role: "nhf", fullName: "NHF User", email: "nhf@refillit.dev", nhfRole: "supervisor" },
    { role: "moh", fullName: "MOH User", email: "moh@refillit.dev", mohRole: "supervisor" },
    { role: "patient", fullName: "Patient User", email: "patient@refillit.dev" },
  ];

  const results = [];
  const seededUserByEmail = new Map();
  for (const user of users) {
    const normalizedEmail = normalizeEmail(user.email);
    const emailHash = hashIdentifier(normalizedEmail);
    // eslint-disable-next-line no-await-in-loop
    let existing = await User.findOne({ where: { emailHash } });
    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      existing = await User.create({
        fullName: user.fullName,
        role: user.role,
        nhfRole: user.nhfRole,
        mohRole: user.mohRole,
        passwordHash,
        email: user.email,
        platformStaffId: user.role === "receptionist" ? "RCPT-SEED00-00001" : undefined,
      });
    }
    if (existing.role === "receptionist" && !existing.platformStaffId) {
      // eslint-disable-next-line no-await-in-loop
      await ensurePlatformStaffId({ UserModel: User, user: existing, role: "receptionist" });
    }
    if (existing.role === "nhf" && !existing.nhfRole) {
      existing.nhfRole = user.nhfRole || "supervisor";
      // eslint-disable-next-line no-await-in-loop
      await existing.save();
    }
    if (existing.role === "doctor") {
      // eslint-disable-next-line no-await-in-loop
      const profile = await DoctorProfile.findOne({ where: { userId: existing.id } });
      if (!profile) {
        // eslint-disable-next-line no-await-in-loop
        await DoctorProfile.create({
          userId: existing.id,
          licenseNumber: `DOC-${existing.id.slice(0, 6)}`,
          mohVerified: true,
          clinicInfo: { name: "Refillit Clinic" },
        });
      }
    }

    if (existing.role === "pharmacy") {
      // eslint-disable-next-line no-await-in-loop
      const profile = await PharmacyProfile.findOne({ where: { userId: existing.id } });
      if (!profile) {
        // eslint-disable-next-line no-await-in-loop
        await PharmacyProfile.create({
          userId: existing.id,
          councilReg: `PHARM-${existing.id.slice(0, 6)}`,
          registeredName: "Refillit Pharmacy",
          city: "Kingston",
          town: "New Kingston",
          pharmacists: [
            { name: "Alicia James", employeeId: "PH-1001" },
            { name: "Marcus Reid", employeeId: "PH-1002" },
          ],
          branches: [{
            branchId: "main",
            address: "Junction, St Elizabeth, Jamaica",
            coords: { lat: 18.0179, lng: -76.8099 },
            hours: "9am-5pm",
          }],
        });
      }
    }

    if (existing.role === "patient") {
      // eslint-disable-next-line no-await-in-loop
      const profile = await PatientProfile.findOne({ where: { userId: existing.id } });
      if (!profile) {
        // eslint-disable-next-line no-await-in-loop
        await PatientProfile.create({
          userId: existing.id,
          dob: "1990-01-01",
          phone: "+1-876-555-0199",
          address: encryptValue("Kingston 8"),
          idNumber: encryptValue("JAM-123456789"),
          trn: encryptValue("TRN-000111222"),
          idNumberHash: hashIdentifier("JAM-123456789"),
          trnHash: hashIdentifier("TRN-000111222"),
          weightKg: 72,
          weightLbs: 158.73,
        });
      } else {
        if (!profile.weightKg) profile.weightKg = 72;
        if (!profile.weightLbs) profile.weightLbs = 158.73;
        // eslint-disable-next-line no-await-in-loop
        await profile.save();
      }
    }

    results.push({
      id: existing.id,
      role: existing.role,
      fullName: existing.fullName,
      email: user.email,
      platformStaffId: existing.platformStaffId || null,
    });
    seededUserByEmail.set(normalizedEmail, existing);
  }

  // Optional dev-only ownership auto-link.
  // Keeps receptionist -> doctor employer relationship stable across restarts
  // when running with in-memory persistence.
  if (isTruthy(process.env.DEV_AUTO_LINK_RECEPTIONIST_OWNER)) {
    const doctorEmail = normalizeEmail(
      process.env.DEV_AUTO_LINK_DOCTOR_EMAIL || "doctor@refillit.dev"
    );
    const receptionistEmail = normalizeEmail(
      process.env.DEV_AUTO_LINK_RECEPTIONIST_EMAIL || "receptionist@refillit.dev"
    );
    const doctor = seededUserByEmail.get(doctorEmail);
    const receptionist = seededUserByEmail.get(receptionistEmail);
    if (doctor && doctor.role === "doctor" && receptionist && receptionist.role === "receptionist") {
      if (receptionist.createdByDoctorId !== doctor.id) {
        receptionist.createdByDoctorId = doctor.id;
        await receptionist.save();
      }
    }
  }

  const defaultPolicies = [
    {
      code: "POLICY-2026.02",
      name: "Policy 2026.02 (current)",
      description: "Baseline MOH review controls and enforcement thresholds.",
      status: "active",
    },
    {
      code: "POLICY-2025.10",
      name: "Policy 2025.10",
      description: "Legacy guidance retained for historical review references.",
      status: "inactive",
    },
  ];

  for (const policy of defaultPolicies) {
    // eslint-disable-next-line no-await-in-loop
    const existingPolicy = await MohPolicy.findOne({ where: { code: policy.code } });
    if (!existingPolicy) {
      // eslint-disable-next-line no-await-in-loop
      await MohPolicy.create(policy);
    }
  }

  const defaultClinicalCatalogEntries = [
    {
      diagnosisCode: "I10",
      diagnosisLabel: "Essential (primary) hypertension",
      diagnosisAliases: ["Hypertension", "High blood pressure"],
      medicationCode: "M001",
      medicationName: "Amlodipine",
      medicationType: "Antihypertensive",
      usedFor: "Blood pressure control",
      strengths: ["5mg", "10mg"],
      defaultStrength: "5mg",
      controlledSubstance: false,
      status: "approved",
      notes: "Default MOH starter option for uncomplicated HTN.",
      policyCode: "POLICY-2026.02",
    },
    {
      diagnosisCode: "E11.9",
      diagnosisLabel: "Type 2 diabetes mellitus without complications",
      diagnosisAliases: ["Type 2 diabetes", "T2DM", "Diabetes"],
      medicationCode: "M002",
      medicationName: "Metformin",
      medicationType: "Antidiabetic",
      usedFor: "Glycemic control in type 2 diabetes",
      strengths: ["500mg", "850mg"],
      defaultStrength: "500mg",
      controlledSubstance: false,
      status: "approved",
      notes: "Default first-line option when no contraindication is documented.",
      policyCode: "POLICY-2026.02",
    },
    {
      diagnosisCode: "J45.909",
      diagnosisLabel: "Unspecified asthma, uncomplicated",
      diagnosisAliases: ["Asthma", "Reactive airway disease"],
      medicationCode: "M005",
      medicationName: "Salbutamol",
      medicationType: "Bronchodilator",
      usedFor: "Acute wheeze and shortness of breath relief",
      strengths: ["100mcg inhaler"],
      defaultStrength: "100mcg inhaler",
      controlledSubstance: false,
      status: "approved",
      notes: "Reliever inhaler for asthma symptoms.",
      policyCode: "POLICY-2026.02",
    },
  ];

  for (const entry of defaultClinicalCatalogEntries) {
    // eslint-disable-next-line no-await-in-loop
    const existingEntry = await MohClinicalCatalogEntry.findOne({
      where: {
        diagnosisCode: entry.diagnosisCode,
        medicationCode: entry.medicationCode,
      },
    });
    if (!existingEntry) {
      // eslint-disable-next-line no-await-in-loop
      await MohClinicalCatalogEntry.create({
        ...entry,
        submittedBy: null,
        submittedByRole: "seed",
        approvedBy: null,
        approvedAt: new Date().toISOString(),
      });
    }
  }

  const doctorUser = seededUserByEmail.get(normalizeEmail("doctor@refillit.dev"));
  const pharmacyUser = seededUserByEmail.get(normalizeEmail("pharmacy@refillit.dev"));
  const patientUser = seededUserByEmail.get(normalizeEmail("patient@refillit.dev"));
  const nhfUser = seededUserByEmail.get(normalizeEmail("nhf@refillit.dev"));

  const isoDaysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const ensureSeedRow = async (Model, id, payload) => {
    const existing = await Model.findByPk(id);
    if (existing) return existing;
    return Model.create({ id, ...payload });
  };

  if (doctorUser && pharmacyUser && patientUser && nhfUser) {
    const walletSeedRef = `seed-wallet-${patientUser.id}`;
    const nhfCreditSeedRef = `seed-nhf-${patientUser.id}`;
    const existingWalletSeed = await WalletLedger.findOne({ where: { reference: walletSeedRef } });
    if (!existingWalletSeed) {
      await WalletLedger.create({
        patientId: patientUser.id,
        amount: 10000,
        currency: "JMD",
        type: "credit",
        reason: "seed_topup",
        reference: walletSeedRef,
      });
    }
    const existingNhfSeed = await NhfCreditLedger.findOne({ where: { reference: nhfCreditSeedRef } });
    if (!existingNhfSeed) {
      await NhfCreditLedger.create({
        patientId: patientUser.id,
        amount: 8000,
        currency: "JMD",
        type: "credit",
        reason: "seed_nhf_credit",
        reference: nhfCreditSeedRef,
      });
    }

    await ensureSeedRow(Prescription, "seed-presc-001", {
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      meds: [
        { name: "Amlodipine 5mg", qty: 30 },
        { name: "Metformin 500mg", qty: 60 },
      ],
      diagnosis: "Hypertension / Type 2 diabetes",
      createdAt: isoDaysAgo(6),
    });
    await ensureSeedRow(Prescription, "seed-presc-002", {
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      meds: [{ name: "Atorvastatin 20mg", qty: 30 }],
      diagnosis: "Hyperlipidemia",
      createdAt: isoDaysAgo(4),
    });

    await ensureSeedRow(Order, "seed-order-001", {
      patientId: patientUser.id,
      prescId: "seed-presc-001",
      pharmacyId: pharmacyUser.id,
      orderStatus: "ready",
      payment: { amount: 9000, currency: "JMD" },
      prescriptionSnapshot: { doctorId: doctorUser.id, meds: [{ name: "Amlodipine 5mg", qty: 30 }] },
      createdAt: isoDaysAgo(5),
    });
    await ensureSeedRow(Order, "seed-order-002", {
      patientId: patientUser.id,
      prescId: "seed-presc-002",
      pharmacyId: pharmacyUser.id,
      orderStatus: "delivered",
      payment: { amount: 7600, currency: "JMD" },
      prescriptionSnapshot: { doctorId: doctorUser.id, meds: [{ name: "Atorvastatin 20mg", qty: 30 }] },
      createdAt: isoDaysAgo(3),
    });

    await ensureSeedRow(Appointment, "seed-appt-001", {
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      feeAmount: 10000,
      nhfDeductionAmount: 7000,
      paymentCollectedAmount: 1000,
      createdAt: isoDaysAgo(5),
    });
    await ensureSeedRow(Appointment, "seed-appt-002", {
      patientId: patientUser.id,
      doctorId: doctorUser.id,
      feeAmount: 12000,
      nhfDeductionAmount: 8000,
      paymentCollectedAmount: 2000,
      createdAt: isoDaysAgo(2),
    });

    await ensureSeedRow(NhfClaim, "seed-claim-approved-001", {
      patientId: patientUser.id,
      prescId: "seed-presc-001",
      orderId: "seed-order-001",
      doctorId: doctorUser.id,
      pharmacyId: pharmacyUser.id,
      patientNhfId: "NHF-00112233",
      amountCovered: 3200,
      status: "approved",
      sourceRole: "pharmacy",
      sourceUserId: pharmacyUser.id,
      calculationSnapshot: { baseAmount: 9000, nhfCoverage: 3200, source: "seed" },
      reviewedBy: nhfUser.id,
      reviewedAt: isoDaysAgo(1),
      createdAt: isoDaysAgo(4),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-mismatch-001", {
      patientId: patientUser.id,
      appointmentId: "seed-appt-002",
      doctorId: doctorUser.id,
      patientNhfId: "NHF-00112233",
      amountCovered: 6000,
      status: "submitted",
      sourceRole: "doctor",
      sourceUserId: doctorUser.id,
      calculationSnapshot: { baseAmount: 12000, nhfCoverage: 6000, source: "seed" },
      createdAt: isoDaysAgo(2),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-missing-order-001", {
      patientId: patientUser.id,
      orderId: "seed-order-missing-999",
      doctorId: doctorUser.id,
      pharmacyId: pharmacyUser.id,
      patientNhfId: "NHF-00998877",
      amountCovered: 4100,
      status: "submitted",
      sourceRole: "pharmacy",
      sourceUserId: pharmacyUser.id,
      calculationSnapshot: { baseAmount: 7000, nhfCoverage: 4100, source: "seed" },
      createdAt: isoDaysAgo(3),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-high-001", {
      patientId: patientUser.id,
      orderId: "seed-order-001",
      doctorId: doctorUser.id,
      pharmacyId: pharmacyUser.id,
      patientNhfId: null,
      amountCovered: 70000,
      status: "pending",
      sourceRole: "pharmacy",
      sourceUserId: pharmacyUser.id,
      calculationSnapshot: { baseAmount: 9000, nhfCoverage: 70000, source: "seed" },
      createdAt: isoDaysAgo(6),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-dup-order-001", {
      patientId: patientUser.id,
      orderId: "seed-order-002",
      doctorId: doctorUser.id,
      pharmacyId: pharmacyUser.id,
      patientNhfId: "NHF-00112233",
      amountCovered: 5000,
      status: "submitted",
      sourceRole: "pharmacy",
      sourceUserId: pharmacyUser.id,
      calculationSnapshot: { baseAmount: 7600, nhfCoverage: 5000, source: "seed" },
      createdAt: isoDaysAgo(3),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-dup-order-002", {
      patientId: patientUser.id,
      orderId: "seed-order-002",
      doctorId: doctorUser.id,
      pharmacyId: pharmacyUser.id,
      patientNhfId: "NHF-00112233",
      amountCovered: 5200,
      status: "submitted",
      sourceRole: "pharmacy",
      sourceUserId: pharmacyUser.id,
      calculationSnapshot: { baseAmount: 7600, nhfCoverage: 5200, source: "seed" },
      createdAt: isoDaysAgo(2),
    });
    await ensureSeedRow(NhfClaim, "seed-claim-stale-001", {
      patientId: patientUser.id,
      prescId: "seed-presc-001",
      doctorId: doctorUser.id,
      patientNhfId: "NHF-00556677",
      amountCovered: 2800,
      status: "pending",
      sourceRole: "doctor",
      sourceUserId: doctorUser.id,
      calculationSnapshot: { baseAmount: 8000, nhfCoverage: 2800, source: "seed" },
      createdAt: isoDaysAgo(7),
    });

    await ensureSeedRow(NhfDispute, "seed-dispute-open-001", {
      claimId: "seed-claim-mismatch-001",
      reason: "Seeded mismatch requires review",
      status: "open",
      createdBy: nhfUser.id,
      notes: "Created by seed for NHF workflow testing",
      createdAt: isoDaysAgo(1),
    });
  }

  if (doctorUser && pharmacyUser) {
    const existingSnapshots = await ComplianceReportSnapshot.findAll({});
    if (!existingSnapshots.length) {
      await ComplianceReportSnapshot.create({
        label: "Dispense Compliance Snapshot",
        pharmacyId: pharmacyUser.id,
        signedBy: doctorUser.id,
        signedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        checksum: "seeded-checksum",
        signature: {
          signerId: doctorUser.id,
          signedAt: new Date().toISOString(),
          signatureHash: "seeded-signature",
        },
        summary: { total: 3, critical: 0, high: 1, moderate: 1 },
        events: [
          { id: "evt-1", severity: "high", detail: "Controlled substance review" },
          { id: "evt-2", severity: "moderate", detail: "Missing patient contact" },
          { id: "evt-3", severity: "low", detail: "Late pickup" },
        ],
        mohSubmission: {
          status: "submitted",
          submittedAt: new Date().toISOString(),
          submittedBy: pharmacyUser.id,
          submissionNote: "Seeded snapshot for MOH UI visibility.",
          policyVersion: defaultPolicies[0].code,
        },
      });
    }
  }

  return { password, users: results };
};

const run = async () => {
  initModels();
  await sequelize.authenticate();
  const result = await seedUsers();
  console.log("Seed complete", result);
  await sequelize.close();
};

if (require.main === module) {
  run().catch((error) => {
    console.error("Seed failed", error);
    process.exit(1);
  });
}

module.exports = { seedUsers };

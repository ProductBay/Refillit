const { DataTypes } = require("sequelize");
const { sequelize } = require("./sequelize");

// Define models with minimal fields needed for seeded/demo flows.
const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    fullName: DataTypes.STRING,
    email: DataTypes.STRING,
    emailHash: DataTypes.STRING,
    role: DataTypes.STRING,
    nhfRole: DataTypes.STRING,
    mohRole: DataTypes.STRING,
    passwordHash: DataTypes.STRING,
    platformStaffId: DataTypes.STRING,
  },
  { tableName: "users", timestamps: true }
);

const DoctorProfile = sequelize.define(
  "DoctorProfile",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: DataTypes.UUID,
    licenseNumber: DataTypes.STRING,
    mohVerified: DataTypes.BOOLEAN,
    clinicInfo: DataTypes.JSONB,
  },
  { tableName: "doctor_profiles", timestamps: true }
);

const PatientProfile = sequelize.define(
  "PatientProfile",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: DataTypes.UUID,
    dob: DataTypes.DATE,
    phone: DataTypes.STRING,
    address: DataTypes.STRING,
    idNumber: DataTypes.STRING,
    trn: DataTypes.STRING,
    idNumberHash: DataTypes.STRING,
    trnHash: DataTypes.STRING,
    weightKg: DataTypes.DECIMAL,
    weightLbs: DataTypes.DECIMAL,
  },
  { tableName: "patient_profiles", timestamps: true }
);

const PharmacyProfile = sequelize.define(
  "PharmacyProfile",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: DataTypes.UUID,
    councilReg: DataTypes.STRING,
    registeredName: DataTypes.STRING,
    city: DataTypes.STRING,
    town: DataTypes.STRING,
    pharmacists: DataTypes.JSONB,
    branches: DataTypes.JSONB,
  },
  { tableName: "pharmacy_profiles", timestamps: true }
);

const NhfProfile = sequelize.define(
  "NhfProfile",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, userId: DataTypes.UUID },
  { tableName: "nhf_profiles", timestamps: true }
);

const CourierProfile = sequelize.define(
  "CourierProfile",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, userId: DataTypes.UUID },
  { tableName: "courier_profiles", timestamps: true }
);

const Prescription = sequelize.define(
  "Prescription",
  {
    id: { type: DataTypes.STRING, primaryKey: true },
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    meds: DataTypes.JSONB,
    diagnosis: DataTypes.STRING,
  },
  { tableName: "prescriptions", timestamps: true }
);

const Order = sequelize.define(
  "Order",
  {
    id: { type: DataTypes.STRING, primaryKey: true },
    patientId: DataTypes.UUID,
    prescId: DataTypes.STRING,
    pharmacyId: DataTypes.UUID,
    orderType: DataTypes.STRING,
    orderStatus: DataTypes.STRING,
    payment: DataTypes.JSONB,
    paymentIntentId: DataTypes.UUID,
    paymentStatus: DataTypes.STRING,
    paymentMethod: DataTypes.STRING,
    paymentCurrency: DataTypes.STRING,
    paymentAmount: DataTypes.DECIMAL,
    otcSummary: DataTypes.JSONB,
    otcSafety: DataTypes.JSONB,
    otcPackingStatus: DataTypes.STRING,
    otcPackedAt: DataTypes.DATE,
    otcPackedBy: DataTypes.UUID,
    otcPackingNote: DataTypes.TEXT,
    prescriptionSnapshot: DataTypes.JSONB,
  },
  { tableName: "orders", timestamps: true }
);

const NhfClaim = sequelize.define(
  "NhfClaim",
  {
    id: { type: DataTypes.STRING, primaryKey: true },
    patientId: DataTypes.UUID,
    prescId: DataTypes.STRING,
    orderId: DataTypes.STRING,
    doctorId: DataTypes.UUID,
    pharmacyId: DataTypes.UUID,
    patientNhfId: DataTypes.STRING,
    amountCovered: DataTypes.DECIMAL,
    status: DataTypes.STRING,
    sourceRole: DataTypes.STRING,
    sourceUserId: DataTypes.UUID,
    calculationSnapshot: DataTypes.JSONB,
    reviewedBy: DataTypes.UUID,
    reviewedAt: DataTypes.DATE,
  },
  { tableName: "nhf_claims", timestamps: true }
);

const NhfDispute = sequelize.define(
  "NhfDispute",
  {
    id: { type: DataTypes.STRING, primaryKey: true },
    claimId: DataTypes.STRING,
    reason: DataTypes.TEXT,
    status: DataTypes.STRING,
    createdBy: DataTypes.UUID,
    notes: DataTypes.TEXT,
  },
  { tableName: "nhf_disputes", timestamps: true }
);

const AuditLog = sequelize.define(
  "AuditLog",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, payload: DataTypes.JSONB },
  { tableName: "audit_logs", timestamps: true }
);

const ChatThread = sequelize.define(
  "ChatThread",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, metadata: DataTypes.JSONB },
  { tableName: "chat_threads", timestamps: true }
);

const ChatMessage = sequelize.define(
  "ChatMessage",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, threadId: DataTypes.UUID, authorId: DataTypes.UUID, body: DataTypes.TEXT, meta: DataTypes.JSONB },
  { tableName: "chat_messages", timestamps: true }
);

const DoctorPrivateNote = sequelize.define(
  "DoctorPrivateNote",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, userId: DataTypes.UUID, body: DataTypes.TEXT },
  { tableName: "doctor_private_notes", timestamps: true }
);

// Generic/simple models for remaining tables as JSON containers
const GenericJson = (name, table) =>
  sequelize.define(
    name,
    { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, data: DataTypes.JSONB },
    { tableName: table, timestamps: true }
  );

const DoctorConnection = GenericJson("DoctorConnection", "doctor_connections");
const DoctorReceptionAccess = GenericJson("DoctorReceptionAccess", "doctor_reception_access");
const AppointmentAvailability = GenericJson("AppointmentAvailability", "appointment_availability");
const Appointment = sequelize.define(
  "Appointment",
  {
    id: { type: DataTypes.STRING, primaryKey: true },
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    feeAmount: DataTypes.DECIMAL,
    nhfDeductionAmount: DataTypes.DECIMAL,
    paymentCollectedAmount: DataTypes.DECIMAL,
  },
  { tableName: "appointments", timestamps: true }
);

const DoctorPrescriptionTemplate = GenericJson("DoctorPrescriptionTemplate", "doctor_prescription_templates");
const DoctorFavoriteMed = GenericJson("DoctorFavoriteMed", "doctor_favorite_meds");
const AppointmentWaitlist = GenericJson("AppointmentWaitlist", "appointment_waitlist");
const Referral = GenericJson("Referral", "referrals");
const PharmacyIntervention = GenericJson("PharmacyIntervention", "pharmacy_interventions");
const SharedCareNote = GenericJson("SharedCareNote", "shared_care_notes");
const SoapNote = GenericJson("SoapNote", "soap_notes");
const ConsentRecord = GenericJson("ConsentRecord", "consent_records");
const CareInstructionBroadcast = GenericJson("CareInstructionBroadcast", "care_instruction_broadcasts");
const RefillRequest = GenericJson("RefillRequest", "refill_requests");
const PatientMedicationReminder = GenericJson("PatientMedicationReminder", "patient_medication_reminders");
const PatientVisitPrepItem = GenericJson("PatientVisitPrepItem", "patient_visit_prep_items");
const PatientCareTask = GenericJson("PatientCareTask", "patient_care_tasks");
const PatientProxyAccess = GenericJson("PatientProxyAccess", "patient_proxy_access");
const InstallmentProposal = GenericJson("InstallmentProposal", "installment_proposals");
const ComplianceReportSnapshot = sequelize.define(
  "ComplianceReportSnapshot",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, label: DataTypes.STRING, pharmacyId: DataTypes.UUID, signedBy: DataTypes.UUID, signedAt: DataTypes.DATE, checksum: DataTypes.STRING, signature: DataTypes.JSONB, summary: DataTypes.JSONB, events: DataTypes.JSONB, mohSubmission: DataTypes.JSONB },
  { tableName: "compliance_report_snapshots", timestamps: true }
);

const MohExportJob = GenericJson("MohExportJob", "moh_export_jobs");
const MohPolicy = sequelize.define(
  "MohPolicy",
  { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, code: DataTypes.STRING, name: DataTypes.STRING, description: DataTypes.TEXT, status: DataTypes.STRING },
  { tableName: "moh_policies", timestamps: true }
);

const MohClinicalCatalogEntry = sequelize.define(
  "MohClinicalCatalogEntry",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    diagnosisCode: DataTypes.STRING,
    diagnosisLabel: DataTypes.STRING,
    diagnosisAliases: DataTypes.JSONB,
    medicationCode: DataTypes.STRING,
    medicationName: DataTypes.STRING,
    medicationType: DataTypes.STRING,
    usedFor: DataTypes.STRING,
    strengths: DataTypes.JSONB,
    defaultStrength: DataTypes.STRING,
    controlledSubstance: DataTypes.BOOLEAN,
    status: DataTypes.STRING,
    submittedBy: DataTypes.UUID,
    submittedByRole: DataTypes.STRING,
    approvedBy: DataTypes.UUID,
    approvedAt: DataTypes.DATE,
    rejectedBy: DataTypes.UUID,
    rejectedAt: DataTypes.DATE,
    rejectionReason: DataTypes.TEXT,
    notes: DataTypes.TEXT,
    policyCode: DataTypes.STRING,
  },
  { tableName: "moh_clinical_catalog_entries", timestamps: true }
);

const PaymentIntent = GenericJson("PaymentIntent", "payment_intents");
const WalletLedger = GenericJson("WalletLedger", "wallet_ledger");
const NhfCreditLedger = GenericJson("NhfCreditLedger", "nhf_credit_ledger");

const EntityRegistration = GenericJson("EntityRegistration", "entity_registrations");

const OtcProduct = sequelize.define(
  "OtcProduct",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    sku: DataTypes.STRING,
    name: DataTypes.STRING,
    category: DataTypes.STRING,
    dosageForm: DataTypes.STRING,
    strength: DataTypes.STRING,
    activeIngredient: DataTypes.STRING,
    requiresAgeCheck: DataTypes.BOOLEAN,
    maxQtyPerOrder: DataTypes.INTEGER,
    isActive: DataTypes.BOOLEAN,
    metadata: DataTypes.JSONB,
  },
  { tableName: "otc_products", timestamps: true }
);

const PharmacyOtcInventory = sequelize.define(
  "PharmacyOtcInventory",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    pharmacyId: DataTypes.UUID,
    productId: DataTypes.UUID,
    onHand: DataTypes.INTEGER,
    unitPrice: DataTypes.DECIMAL,
    maxPerOrder: DataTypes.INTEGER,
    isListed: DataTypes.BOOLEAN,
    metadata: DataTypes.JSONB,
  },
  { tableName: "pharmacy_otc_inventory", timestamps: true }
);

const OtcOrderItem = sequelize.define(
  "OtcOrderItem",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    orderId: DataTypes.STRING,
    productId: DataTypes.UUID,
    sku: DataTypes.STRING,
    productName: DataTypes.STRING,
    qty: DataTypes.INTEGER,
    unitPrice: DataTypes.DECIMAL,
    lineTotal: DataTypes.DECIMAL,
    metadata: DataTypes.JSONB,
  },
  { tableName: "otc_order_items", timestamps: true }
);

const DemoNdaAcceptance = sequelize.define(
  "DemoNdaAcceptance",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    userId: DataTypes.UUID,
    agreementVersion: DataTypes.STRING,
    agreementHash: DataTypes.STRING,
    agreementTitle: DataTypes.STRING,
    agreementText: DataTypes.TEXT,
    acceptedAt: DataTypes.DATE,
    acceptedName: DataTypes.STRING,
    acceptedByRole: DataTypes.STRING,
    ipAddress: DataTypes.STRING,
    userAgent: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
  },
  { tableName: "demo_nda_acceptances", timestamps: true }
);

const initModels = async () => {
  await sequelize.authenticate();
  await sequelize.sync();
  return true;
};

module.exports = {
  initModels,
  sequelize,
  User,
  DoctorProfile,
  PatientProfile,
  PharmacyProfile,
  NhfProfile,
  CourierProfile,
  Prescription,
  Order,
  NhfClaim,
  NhfDispute,
  AuditLog,
  ChatThread,
  ChatMessage,
  DoctorPrivateNote,
  DoctorConnection,
  DoctorReceptionAccess,
  AppointmentAvailability,
  Appointment,
  DoctorPrescriptionTemplate,
  DoctorFavoriteMed,
  AppointmentWaitlist,
  Referral,
  PharmacyIntervention,
  SharedCareNote,
  SoapNote,
  ConsentRecord,
  CareInstructionBroadcast,
  RefillRequest,
  PatientMedicationReminder,
  PatientVisitPrepItem,
  PatientCareTask,
  PatientProxyAccess,
  InstallmentProposal,
  ComplianceReportSnapshot,
  MohExportJob,
  MohPolicy,
  MohClinicalCatalogEntry,
  PaymentIntent,
  WalletLedger,
  NhfCreditLedger,
  EntityRegistration,
  OtcProduct,
  PharmacyOtcInventory,
  OtcOrderItem,
  DemoNdaAcceptance,
};

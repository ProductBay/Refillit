const { randomUUID } = require("crypto");
const { DataTypes } = require("sequelize");
const { sequelize } = require("./sequelize");

const stringPrimaryKey = (prefix) => ({
  type: DataTypes.STRING,
  primaryKey: true,
  defaultValue: () => `${prefix}_${randomUUID()}`,
});

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
    createdByDoctorId: DataTypes.UUID,
    nhfLocked: DataTypes.BOOLEAN,
    mohLocked: DataTypes.BOOLEAN,
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
    specialty: DataTypes.STRING,
    issuingBody: DataTypes.STRING,
    metadata: DataTypes.JSONB,
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
    allergies: DataTypes.JSONB,
    conditions: DataTypes.JSONB,
    emergencyContactName: DataTypes.TEXT,
    emergencyContactPhone: DataTypes.TEXT,
    insuranceProvider: DataTypes.TEXT,
    insurancePolicyNumber: DataTypes.TEXT,
    nhfNumber: DataTypes.TEXT,
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
    address: DataTypes.TEXT,
    pharmacistInCharge: DataTypes.STRING,
    registryUrl: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
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
    id: stringPrimaryKey("rx"),
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    meds: DataTypes.JSONB,
    diagnosis: DataTypes.STRING,
    allowedRefills: DataTypes.INTEGER,
    expiryDate: DataTypes.DATE,
    controlledSubstanceJustification: DataTypes.TEXT,
    linkCode: DataTypes.STRING,
    linked: DataTypes.BOOLEAN,
    qrDataUrl: DataTypes.TEXT,
    qrPayload: DataTypes.JSONB,
  },
  { tableName: "prescriptions", timestamps: true }
);

const Order = sequelize.define(
  "Order",
  {
    id: stringPrimaryKey("ord"),
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
    id: stringPrimaryKey("claim"),
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
    id: stringPrimaryKey("dispute"),
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
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    pharmacyId: DataTypes.UUID,
    participants: DataTypes.JSONB,
    threadType: DataTypes.STRING,
    doctorLastReadAt: DataTypes.DATE,
    patientLastReadAt: DataTypes.DATE,
    pharmacyLastReadAt: DataTypes.DATE,
    readBy: DataTypes.JSONB,
    lastMessageAt: DataTypes.DATE,
    lastMessageText: DataTypes.TEXT,
    lastMessageSenderId: DataTypes.UUID,
    metadata: DataTypes.JSONB,
  },
  { tableName: "chat_threads", timestamps: true }
);

const ChatMessage = sequelize.define(
  "ChatMessage",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    threadId: DataTypes.UUID,
    senderId: DataTypes.UUID,
    message: DataTypes.TEXT,
    authorId: DataTypes.UUID,
    body: DataTypes.TEXT,
    meta: DataTypes.JSONB,
  },
  { tableName: "chat_messages", timestamps: true }
);

const DoctorPrivateNote = sequelize.define(
  "DoctorPrivateNote",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    text: DataTypes.TEXT,
    tags: DataTypes.JSONB,
    visibility: DataTypes.STRING,
    userId: DataTypes.UUID,
    body: DataTypes.TEXT,
  },
  { tableName: "doctor_private_notes", timestamps: true }
);

// Generic/simple models for remaining tables as JSON containers
const GenericJson = (name, table) =>
  sequelize.define(
    name,
    { id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }, data: DataTypes.JSONB },
    { tableName: table, timestamps: true }
  );

const DoctorConnection = sequelize.define(
  "DoctorConnection",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    status: DataTypes.STRING,
    source: DataTypes.STRING,
    approvedAt: DataTypes.DATE,
    declinedAt: DataTypes.DATE,
    notes: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
  },
  { tableName: "doctor_connections", timestamps: true }
);

const DoctorReceptionAccess = sequelize.define(
  "DoctorReceptionAccess",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    receptionistId: DataTypes.UUID,
    status: DataTypes.STRING,
    canViewDemographics: DataTypes.BOOLEAN,
    canViewAppointments: DataTypes.BOOLEAN,
    canViewPrivateNotes: DataTypes.BOOLEAN,
    canViewPrescriptions: DataTypes.BOOLEAN,
    grantedByUserId: DataTypes.UUID,
    revokedByUserId: DataTypes.UUID,
    notes: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
  },
  { tableName: "doctor_reception_access", timestamps: true }
);

const AppointmentAvailability = sequelize.define(
  "AppointmentAvailability",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    startAt: DataTypes.DATE,
    endAt: DataTypes.DATE,
    mode: DataTypes.STRING,
    location: DataTypes.TEXT,
    maxBookings: DataTypes.INTEGER,
    feeRequired: DataTypes.BOOLEAN,
    feeAmount: DataTypes.DECIMAL,
    feeCurrency: DataTypes.STRING,
    isActive: DataTypes.BOOLEAN,
    metadata: DataTypes.JSONB,
  },
  { tableName: "appointment_availability", timestamps: true }
);
const Appointment = sequelize.define(
  "Appointment",
  {
    id: stringPrimaryKey("appt"),
    availabilityId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    startAt: DataTypes.DATE,
    endAt: DataTypes.DATE,
    mode: DataTypes.STRING,
    location: DataTypes.TEXT,
    reason: DataTypes.TEXT,
    triageTags: DataTypes.JSONB,
    source: DataTypes.STRING,
    status: DataTypes.STRING,
    arrivalStatus: DataTypes.STRING,
    arrivedAt: DataTypes.DATE,
    checkedInAt: DataTypes.DATE,
    checkedInBy: DataTypes.UUID,
    inRoomAt: DataTypes.DATE,
    completedAt: DataTypes.DATE,
    reminderChannel: DataTypes.STRING,
    reminderDefault24h: DataTypes.BOOLEAN,
    reminderCustomAlertAt: DataTypes.DATE,
    reminderDefaultSentAt: DataTypes.DATE,
    reminderCustomSentAt: DataTypes.DATE,
    reminderLastSentAt: DataTypes.DATE,
    reminderHistory: DataTypes.JSONB,
    doctorAlerts: DataTypes.JSONB,
    feeRequired: DataTypes.BOOLEAN,
    feeAmount: DataTypes.DECIMAL,
    feeCurrency: DataTypes.STRING,
    consultationFee: DataTypes.DECIMAL,
    additionalCharges: DataTypes.DECIMAL,
    nhfDeductionAmount: DataTypes.DECIMAL,
    nhfReference: DataTypes.STRING,
    paymentStatus: DataTypes.STRING,
    paymentCollectedAmount: DataTypes.DECIMAL,
    paymentMethod: DataTypes.STRING,
    paymentReference: DataTypes.STRING,
    paymentCollectedAt: DataTypes.DATE,
    paymentCollectedBy: DataTypes.UUID,
    paymentNotes: DataTypes.TEXT,
    paymentHistory: DataTypes.JSONB,
    paymentDueDate: DataTypes.DATE,
    billingReadyForCollection: DataTypes.BOOLEAN,
    billingReadyAt: DataTypes.DATE,
    visitChargeUpdatedAt: DataTypes.DATE,
    visitChargeUpdatedBy: DataTypes.UUID,
    receptionHandoffAt: DataTypes.DATE,
    receptionHandoffBy: DataTypes.UUID,
    receptionHandoffNote: DataTypes.TEXT,
    receptionUpdatedAt: DataTypes.DATE,
    receptionUpdatedBy: DataTypes.UUID,
    receptionNote: DataTypes.TEXT,
  },
  { tableName: "appointments", timestamps: true }
);

const DoctorPrescriptionTemplate = sequelize.define(
  "DoctorPrescriptionTemplate",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    name: DataTypes.STRING,
    diagnosis: DataTypes.STRING,
    meds: DataTypes.JSONB,
    allowedRefills: DataTypes.INTEGER,
    notes: DataTypes.TEXT,
  },
  { tableName: "doctor_prescription_templates", timestamps: true }
);

const DoctorFavoriteMed = sequelize.define(
  "DoctorFavoriteMed",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    ndcCode: DataTypes.STRING,
    name: DataTypes.STRING,
    strength: DataTypes.STRING,
    qty: DataTypes.INTEGER,
    allowedRefills: DataTypes.INTEGER,
    medicationType: DataTypes.STRING,
    usedFor: DataTypes.TEXT,
    controlledSubstance: DataTypes.BOOLEAN,
  },
  { tableName: "doctor_favorite_meds", timestamps: true }
);

const AppointmentWaitlist = sequelize.define(
  "AppointmentWaitlist",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    status: DataTypes.STRING,
    preferredDate: DataTypes.DATE,
    reason: DataTypes.TEXT,
    triageTags: DataTypes.JSONB,
    bookedAppointmentId: DataTypes.STRING,
    bookedAt: DataTypes.DATE,
    metadata: DataTypes.JSONB,
  },
  { tableName: "appointment_waitlist", timestamps: true }
);

const Referral = sequelize.define(
  "Referral",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    referralReference: DataTypes.STRING,
    referralType: DataTypes.STRING,
    targetName: DataTypes.STRING,
    targetSpecialty: DataTypes.STRING,
    targetContact: DataTypes.STRING,
    reason: DataTypes.TEXT,
    clinicalQuestion: DataTypes.TEXT,
    requestedByDate: DataTypes.STRING,
    priority: DataTypes.STRING,
    status: DataTypes.STRING,
    attachmentUrls: DataTypes.JSONB,
    statusTimeline: DataTypes.JSONB,
  },
  { tableName: "referrals", timestamps: true }
);

const PharmacyIntervention = sequelize.define(
  "PharmacyIntervention",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    pharmacyId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    orderId: DataTypes.STRING,
    interventionType: DataTypes.STRING,
    details: DataTypes.TEXT,
    suggestedAlternative: DataTypes.JSONB,
    severity: DataTypes.STRING,
    status: DataTypes.STRING,
    resolvedAt: DataTypes.DATE,
    resolvedBy: DataTypes.UUID,
    resolutionNote: DataTypes.TEXT,
  },
  { tableName: "pharmacy_interventions", timestamps: true }
);

const SharedCareNote = sequelize.define(
  "SharedCareNote",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    text: DataTypes.TEXT,
    visibilityRoles: DataTypes.JSONB,
    tags: DataTypes.JSONB,
    metadata: DataTypes.JSONB,
  },
  { tableName: "shared_care_notes", timestamps: true }
);

const SoapNote = sequelize.define(
  "SoapNote",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    subjective: DataTypes.TEXT,
    objective: DataTypes.TEXT,
    assessment: DataTypes.TEXT,
    plan: DataTypes.TEXT,
    diagnosisCodes: DataTypes.JSONB,
    procedureCodes: DataTypes.JSONB,
    signature: DataTypes.TEXT,
    signedBy: DataTypes.UUID,
    signedAt: DataTypes.DATE,
    locked: DataTypes.BOOLEAN,
  },
  { tableName: "soap_notes", timestamps: true }
);

const ConsentRecord = sequelize.define(
  "ConsentRecord",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    consentType: DataTypes.STRING,
    grantedAt: DataTypes.DATE,
    expiresAt: DataTypes.DATE,
    status: DataTypes.STRING,
    notes: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
  },
  { tableName: "consent_records", timestamps: true }
);

const CareInstructionBroadcast = sequelize.define(
  "CareInstructionBroadcast",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    doctorId: DataTypes.UUID,
    patientId: DataTypes.UUID,
    language: DataTypes.STRING,
    text: DataTypes.TEXT,
    cohort: DataTypes.STRING,
    deliveredAt: DataTypes.DATE,
    readAt: DataTypes.DATE,
    escalatedAt: DataTypes.DATE,
    contact: DataTypes.STRING,
    escalationLevel: DataTypes.INTEGER,
  },
  { tableName: "care_instruction_broadcasts", timestamps: true }
);

const RefillRequest = sequelize.define(
  "RefillRequest",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    prescId: DataTypes.STRING,
    reason: DataTypes.TEXT,
    status: DataTypes.STRING,
    decidedAt: DataTypes.DATE,
    decisionNotes: DataTypes.TEXT,
  },
  { tableName: "refill_requests", timestamps: true }
);

const PatientMedicationReminder = sequelize.define(
  "PatientMedicationReminder",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    title: DataTypes.STRING,
    note: DataTypes.TEXT,
    dosage: DataTypes.STRING,
    timeOfDay: DataTypes.STRING,
    frequency: DataTypes.STRING,
    active: DataTypes.BOOLEAN,
    lastAction: DataTypes.STRING,
    lastActionAt: DataTypes.DATE,
  },
  { tableName: "patient_medication_reminders", timestamps: true }
);

const PatientVisitPrepItem = sequelize.define(
  "PatientVisitPrepItem",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    text: DataTypes.TEXT,
    category: DataTypes.STRING,
    visitDate: DataTypes.STRING,
    symptomName: DataTypes.STRING,
    symptomExplanation: DataTypes.TEXT,
    symptomSeverity: DataTypes.STRING,
    occurredAt: DataTypes.DATE,
    sharedWithDoctor: DataTypes.BOOLEAN,
    sharedDoctorId: DataTypes.UUID,
    sharedAt: DataTypes.DATE,
    sharedForVirtualDiagnosis: DataTypes.BOOLEAN,
    sharedNote: DataTypes.TEXT,
    reviewedByDoctorAt: DataTypes.DATE,
    reviewedByDoctorId: DataTypes.UUID,
    doctorReviewNote: DataTypes.TEXT,
    completed: DataTypes.BOOLEAN,
  },
  { tableName: "patient_visit_prep_items", timestamps: true }
);

const PatientCareTask = sequelize.define(
  "PatientCareTask",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    text: DataTypes.TEXT,
    dueDate: DataTypes.STRING,
    source: DataTypes.STRING,
    completed: DataTypes.BOOLEAN,
    completedAt: DataTypes.DATE,
  },
  { tableName: "patient_care_tasks", timestamps: true }
);

const PatientProxyAccess = sequelize.define(
  "PatientProxyAccess",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    proxyUserId: DataTypes.UUID,
    relationship: DataTypes.STRING,
    phone: DataTypes.STRING,
    idType: DataTypes.STRING,
    idNumber: DataTypes.TEXT,
    idNumberMasked: DataTypes.STRING,
    organizationName: DataTypes.STRING,
    verificationStatus: DataTypes.STRING,
    verificationVerifiedAt: DataTypes.DATE,
    verificationNote: DataTypes.TEXT,
    active: DataTypes.BOOLEAN,
    canViewEmergencyCard: DataTypes.BOOLEAN,
    canRequestRefills: DataTypes.BOOLEAN,
    canBookAppointments: DataTypes.BOOLEAN,
    notes: DataTypes.TEXT,
  },
  { tableName: "patient_proxy_access", timestamps: true }
);

const InstallmentProposal = sequelize.define(
  "InstallmentProposal",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    appointmentId: DataTypes.STRING,
    patientId: DataTypes.UUID,
    doctorId: DataTypes.UUID,
    proposedByUserId: DataTypes.UUID,
    proposedByRole: DataTypes.STRING,
    installments: DataTypes.INTEGER,
    amountEach: DataTypes.DECIMAL,
    totalAmount: DataTypes.DECIMAL,
    currency: DataTypes.STRING,
    startDate: DataTypes.STRING,
    status: DataTypes.STRING,
    reviewNote: DataTypes.TEXT,
    reviewedByUserId: DataTypes.UUID,
    reviewedByRole: DataTypes.STRING,
    reviewedAt: DataTypes.DATE,
    metadata: DataTypes.JSONB,
  },
  { tableName: "installment_proposals", timestamps: true }
);
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

const PaymentIntent = sequelize.define(
  "PaymentIntent",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    prescId: DataTypes.STRING,
    paymentScope: DataTypes.STRING,
    pharmacyId: DataTypes.UUID,
    method: DataTypes.STRING,
    currency: DataTypes.STRING,
    refillAmount: DataTypes.DECIMAL,
    subtotal: DataTypes.DECIMAL,
    deliveryFee: DataTypes.DECIMAL,
    totalAmount: DataTypes.DECIMAL,
    allocations: DataTypes.JSONB,
    otcItems: DataTypes.JSONB,
    status: DataTypes.STRING,
    orderId: DataTypes.STRING,
    authorizedAt: DataTypes.DATE,
    paidAt: DataTypes.DATE,
  },
  { tableName: "payment_intents", timestamps: true }
);

const WalletLedger = sequelize.define(
  "WalletLedger",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    amount: DataTypes.DECIMAL,
    currency: DataTypes.STRING,
    type: DataTypes.STRING,
    reason: DataTypes.STRING,
    paymentIntentId: DataTypes.UUID,
  },
  { tableName: "wallet_ledger", timestamps: true }
);

const NhfCreditLedger = sequelize.define(
  "NhfCreditLedger",
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    patientId: DataTypes.UUID,
    amount: DataTypes.DECIMAL,
    currency: DataTypes.STRING,
    type: DataTypes.STRING,
    reason: DataTypes.STRING,
    paymentIntentId: DataTypes.UUID,
  },
  { tableName: "nhf_credit_ledger", timestamps: true }
);

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
  await sequelize.sync({ alter: true });
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

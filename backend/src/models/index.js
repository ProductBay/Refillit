let exportsObj;

if (process.env.USE_PG === "true") {
  // When using Postgres, export Sequelize-backed models
  const seq = require("../db/sequelize-models");
  // Preserve behavior: normalize email and set emailHash on create like MemoryModel did
  try {
    const { normalizeEmail, hashIdentifier } = require("../utils/crypto");
    const origCreate = seq.User.create.bind(seq.User);
    seq.User.create = async function createUser(payload, options) {
      const email = payload.email ? normalizeEmail(payload.email) : payload.email;
      const emailHash = email ? hashIdentifier(email) : payload.emailHash;
      return origCreate({ ...payload, email, emailHash }, options);
    };
  } catch (err) {
    // ignore; keep default create if utils not available
  }

  exportsObj = seq;
} else {
  const { MemoryModel } = require("../db/memoryStore");

  class User extends MemoryModel {}
  User.table = "users";
  const { hashIdentifier, normalizeEmail } = require("../utils/crypto");

  User.create = async function createUser(payload) {
    const email = payload.email ? normalizeEmail(payload.email) : payload.email;
    const emailHash = email ? hashIdentifier(email) : payload.emailHash;
    return MemoryModel.create.call(User, {
      ...payload,
      email,
      emailHash,
    });
  };

  class DoctorProfile extends MemoryModel {}
  DoctorProfile.table = "doctor_profiles";

  class PatientProfile extends MemoryModel {}
  PatientProfile.table = "patient_profiles";

  class PharmacyProfile extends MemoryModel {}
  PharmacyProfile.table = "pharmacy_profiles";

  class NhfProfile extends MemoryModel {}
  NhfProfile.table = "nhf_profiles";

  class CourierProfile extends MemoryModel {}
  CourierProfile.table = "courier_profiles";

  class Prescription extends MemoryModel {}
  Prescription.table = "prescriptions";

  class Order extends MemoryModel {}
  Order.table = "orders";

  class NhfClaim extends MemoryModel {}
  NhfClaim.table = "nhf_claims";

  class NhfPayoutRun extends MemoryModel {}
  NhfPayoutRun.table = "nhf_payout_runs";

  class NhfDispute extends MemoryModel {}
  NhfDispute.table = "nhf_disputes";

  class NhfResolutionEvent extends MemoryModel {}
  NhfResolutionEvent.table = "nhf_resolution_events";

  class AuditLog extends MemoryModel {}
  AuditLog.table = "audit_logs";

  class ChatThread extends MemoryModel {}
  ChatThread.table = "chat_threads";

  class ChatMessage extends MemoryModel {}
  ChatMessage.table = "chat_messages";

  class DoctorPrivateNote extends MemoryModel {}
  DoctorPrivateNote.table = "doctor_private_notes";

  class DoctorConnection extends MemoryModel {}
  DoctorConnection.table = "doctor_connections";

  class DoctorReceptionAccess extends MemoryModel {}
  DoctorReceptionAccess.table = "doctor_reception_access";

  class AppointmentAvailability extends MemoryModel {}
  AppointmentAvailability.table = "appointment_availability";

  class Appointment extends MemoryModel {}
  Appointment.table = "appointments";

  class DoctorPrescriptionTemplate extends MemoryModel {}
  DoctorPrescriptionTemplate.table = "doctor_prescription_templates";

  class DoctorFavoriteMed extends MemoryModel {}
  DoctorFavoriteMed.table = "doctor_favorite_meds";

  class AppointmentWaitlist extends MemoryModel {}
  AppointmentWaitlist.table = "appointment_waitlist";

  class Referral extends MemoryModel {}
  Referral.table = "referrals";

  class PharmacyIntervention extends MemoryModel {}
  PharmacyIntervention.table = "pharmacy_interventions";

  class SharedCareNote extends MemoryModel {}
  SharedCareNote.table = "shared_care_notes";

  class SoapNote extends MemoryModel {}
  SoapNote.table = "soap_notes";

  class ConsentRecord extends MemoryModel {}
  ConsentRecord.table = "consent_records";

  class CareInstructionBroadcast extends MemoryModel {}
  CareInstructionBroadcast.table = "care_instruction_broadcasts";

  class RefillRequest extends MemoryModel {}
  RefillRequest.table = "refill_requests";

  class PatientMedicationReminder extends MemoryModel {}
  PatientMedicationReminder.table = "patient_medication_reminders";

  class PatientVisitPrepItem extends MemoryModel {}
  PatientVisitPrepItem.table = "patient_visit_prep_items";

  class PatientCareTask extends MemoryModel {}
  PatientCareTask.table = "patient_care_tasks";

  class PatientProxyAccess extends MemoryModel {}
  PatientProxyAccess.table = "patient_proxy_access";

  class InstallmentProposal extends MemoryModel {}
  InstallmentProposal.table = "installment_proposals";

  class ComplianceReportSnapshot extends MemoryModel {}
  ComplianceReportSnapshot.table = "compliance_report_snapshots";

  class MohExportJob extends MemoryModel {}
  MohExportJob.table = "moh_export_jobs";

  class MohPolicy extends MemoryModel {}
  MohPolicy.table = "moh_policies";

  class MohClinicalCatalogEntry extends MemoryModel {}
  MohClinicalCatalogEntry.table = "moh_clinical_catalog_entries";

  class PaymentIntent extends MemoryModel {}
  PaymentIntent.table = "payment_intents";

  class WalletLedger extends MemoryModel {}
  WalletLedger.table = "wallet_ledger";

  class NhfCreditLedger extends MemoryModel {}
  NhfCreditLedger.table = "nhf_credit_ledger";

  class EntityRegistration extends MemoryModel {}
  EntityRegistration.table = "entity_registrations";

  class OtcProduct extends MemoryModel {}
  OtcProduct.table = "otc_products";

  class PharmacyOtcInventory extends MemoryModel {}
  PharmacyOtcInventory.table = "pharmacy_otc_inventory";

  class OtcOrderItem extends MemoryModel {}
  OtcOrderItem.table = "otc_order_items";

  class DemoNdaAcceptance extends MemoryModel {}
  DemoNdaAcceptance.table = "demo_nda_acceptances";

  const initModels = () => true;

  exportsObj = {
    initModels,
    User,
    DoctorProfile,
    PatientProfile,
    PharmacyProfile,
    NhfProfile,
    CourierProfile,
    Prescription,
    Order,
    NhfClaim,
    NhfPayoutRun,
    NhfDispute,
    NhfResolutionEvent,
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
}

module.exports = exportsObj;

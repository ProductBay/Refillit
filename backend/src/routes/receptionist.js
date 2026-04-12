const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  Appointment,
  AppointmentAvailability,
  AppointmentWaitlist,
  DoctorConnection,
  DoctorReceptionAccess,
  PatientProfile,
  User,
  InstallmentProposal,
} = require("../models");
const { writeAudit } = require("../utils/audit");
const { normalizeEmail, hashIdentifier } = require("../utils/crypto");
const { hashPassword } = require("../utils/password");
const { decryptValue, encryptValue } = require("../utils/fieldCrypto");
const { sendReminder } = require("../utils/reminderDelivery");

const router = express.Router();

const toDateKey = (value) => {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
};
const addDays = (isoDateOrValue, days) => {
  const base = new Date(isoDateOrValue || new Date());
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + Number(days || 0));
  return base.toISOString();
};
const ARRIVAL_STATES = ["waiting", "arrived", "in_room", "completed"];
const PAYMENT_METHODS = new Set(["cash", "card", "transfer", "insurance", "waived", "other"]);
const ARRIVAL_TRANSITIONS = {
  waiting: new Set(["arrived"]),
  arrived: new Set(["in_room", "completed"]),
  in_room: new Set(["completed"]),
  completed: new Set([]),
};
const ACTIVE_BOOKING_STATUSES = new Set(["pending", "approved", "arrived", "in_room"]);

const getActiveGrant = async ({ receptionistId, doctorId, patientId }) => {
  return DoctorReceptionAccess.findOne({
    where: {
      receptionistId,
      doctorId,
      patientId,
      status: "active",
    },
  });
};

const canSeeDemographics = (grant) => Boolean(grant && grant.canViewDemographics);
const canManageAppointments = (grant) => Boolean(grant && grant.canViewAppointments);
const isOwnerLinkedDoctor = ({ receptionist, doctorId }) =>
  Boolean(receptionist?.createdByDoctorId && String(receptionist.createdByDoctorId) === String(doctorId));
const canOperateForDoctor = ({ receptionist, doctorId, grant }) =>
  isOwnerLinkedDoctor({ receptionist, doctorId }) || canManageAppointments(grant);
const toMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};
const defaultFeeCurrency = (value) => String(value || "JMD").trim().toUpperCase().slice(0, 8) || "JMD";
const parseAllergyListInput = (value) => {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 50);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  return [];
};
const makeTemporaryPassword = () => `Temp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const getDoctorSchedulingAuthorization = async ({ receptionistId, receptionist, doctorId }) => {
  if (isOwnerLinkedDoctor({ receptionist, doctorId })) return true;
  const doctorGrants = await DoctorReceptionAccess.findAll({
    where: { receptionistId, doctorId, status: "active" },
  });
  return doctorGrants.some((entry) => canManageAppointments(entry));
};
const ensureReceptionGrantForDoctorPatient = async ({ receptionistId, doctorId, patientId }) => {
  let grant = await DoctorReceptionAccess.findOne({
    where: {
      receptionistId,
      doctorId,
      patientId,
      status: "active",
    },
  });
  if (!grant) {
    grant = await DoctorReceptionAccess.create({
      receptionistId,
      doctorId,
      patientId,
      status: "active",
      canViewDemographics: true,
      canViewAppointments: true,
      canViewPrivateNotes: false,
      canViewPrescriptions: false,
      grantedByDoctorId: doctorId,
      updatedByDoctorId: doctorId,
    });
  }
  return grant;
};
const buildBillingPacket = (appointment) => {
  const consultationFee = toMoney(appointment.consultationFee || 0);
  const additionalCharges = toMoney(appointment.additionalCharges || 0);
  const feeAmount = toMoney(appointment.feeAmount || consultationFee + additionalCharges);
  const nhfDeductionAmount = toMoney(appointment.nhfDeductionAmount || 0);
  const paidAmount = toMoney(appointment.paymentCollectedAmount || 0);
  return {
    consultationFee,
    additionalCharges,
    feeAmount,
    feeCurrency: defaultFeeCurrency(appointment.feeCurrency),
    nhfDeductionAmount,
    nhfReference: appointment.nhfReference || null,
    balanceAmount: Math.max(0, toMoney(feeAmount - nhfDeductionAmount - paidAmount)),
    status: String(appointment.paymentStatus || "").toLowerCase() || "not_required",
    chargeNotes: appointment.chargeNotes || null,
    billingReadyForCollection: Boolean(appointment.billingReadyForCollection),
    billingReadyAt: appointment.billingReadyAt || null,
    visitChargeUpdatedAt: appointment.visitChargeUpdatedAt || null,
    visitChargeUpdatedBy: appointment.visitChargeUpdatedBy || null,
    receptionHandoffAt: appointment.receptionHandoffAt || null,
    receptionHandoffBy: appointment.receptionHandoffBy || null,
    receptionHandoffNote: appointment.receptionHandoffNote || null,
  };
};
const normalizeNhfDeduction = ({ appointment, value }) => {
  const feeAmount = toMoney(appointment?.feeAmount || 0);
  const raw = toMoney(value || 0);
  if (!Number.isFinite(raw) || raw < 0) {
    return { error: "nhfDeductionAmount must be 0 or greater" };
  }
  if (raw > feeAmount) {
    return { error: "nhfDeductionAmount cannot exceed the appointment fee" };
  }
  return { value: raw };
};
const buildReceiptRecord = ({
  appointment,
  paymentEntry,
  doctor,
  patient,
  receptionist,
}) => {
  const currency = defaultFeeCurrency(appointment.feeCurrency);
  const amount = toMoney(paymentEntry?.amount || 0);
  const collectedAt = paymentEntry?.at || appointment.paymentCollectedAt || new Date().toISOString();
  return {
    receiptNumber: `RCPT-${String(appointment.id || "").slice(0, 8)}-${String(paymentEntry?.id || "latest").slice(-6)}`,
    collectedAt,
    currency,
    amount,
    method: paymentEntry?.method || appointment.paymentMethod || "unknown",
    reference: paymentEntry?.reference || appointment.paymentReference || null,
    notes: paymentEntry?.notes || appointment.paymentNotes || null,
    appointment: {
      id: appointment.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      mode: appointment.mode || null,
      location: appointment.location || null,
      feeRequired: Boolean(appointment.feeRequired),
      feeAmount: toMoney(appointment.feeAmount || 0),
      nhfDeductionAmount: toMoney(appointment.nhfDeductionAmount || 0),
      nhfReference: appointment.nhfReference || null,
      paymentStatus: appointment.paymentStatus || null,
      paymentCollectedAmount: toMoney(appointment.paymentCollectedAmount || 0),
      paymentBalanceAmount: toMoney(
        Math.max(
          0,
          toMoney(appointment.feeAmount || 0)
            - toMoney(appointment.nhfDeductionAmount || 0)
            - toMoney(appointment.paymentCollectedAmount || 0)
        )
      ),
    },
    doctor: {
      id: doctor?.id || appointment.doctorId,
      name: doctor?.fullName || "Unknown doctor",
    },
    patient: {
      id: patient?.id || appointment.patientId,
      name: patient?.fullName || "Unknown patient",
    },
    receptionist: {
      id: receptionist?.id || appointment.paymentCollectedBy || null,
      name: receptionist?.fullName || "Unknown receptionist",
      platformStaffId: receptionist?.platformStaffId || null,
      certificationId: receptionist?.platformStaffId || null,
    },
  };
};
const derivePaymentSummary = (appointment) => {
  const required = Boolean(appointment.feeRequired);
  const feeAmount = toMoney(appointment.feeAmount || 0);
  const nhfDeductionAmount = toMoney(appointment.nhfDeductionAmount || 0);
  const paidAmount = toMoney(appointment.paymentCollectedAmount || 0);
  const baseBalance = required ? Math.max(0, feeAmount - nhfDeductionAmount - paidAmount) : 0;
  const statusRaw = String(appointment.paymentStatus || "").toLowerCase();
  const status = statusRaw || (required ? (baseBalance > 0 ? "unpaid" : "paid") : "not_required");
  return {
    feeRequired: required,
    feeAmount,
    feeCurrency: defaultFeeCurrency(appointment.feeCurrency),
    nhfDeductionAmount,
    nhfReference: appointment.nhfReference || null,
    paidAmount,
    balanceAmount: toMoney(status === "waived" ? 0 : baseBalance),
    status,
    method: appointment.paymentMethod || null,
    reference: appointment.paymentReference || null,
    collectedAt: appointment.paymentCollectedAt || null,
    collectedBy: appointment.paymentCollectedBy || null,
    notes: appointment.paymentNotes || null,
    history: Array.isArray(appointment.paymentHistory) ? appointment.paymentHistory : [],
  };
};

const deriveArrivalStatus = (appointment) => {
  const raw = String(appointment.arrivalStatus || "").trim().toLowerCase();
  if (ARRIVAL_STATES.includes(raw)) return raw;
  if (appointment.status === "completed") return "completed";
  if (appointment.inRoomAt) return "in_room";
  if (appointment.arrivedAt || appointment.checkedInAt) return "arrived";
  return "waiting";
};
const pushDoctorAlert = (appointment, payload) => {
  const alerts = Array.isArray(appointment.doctorAlerts) ? appointment.doctorAlerts : [];
  alerts.push({
    id: `dralert-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    read: false,
    ...payload,
  });
  appointment.doctorAlerts = alerts.slice(-50);
};
const tryAutoFillWaitlistReplacementForDoctor = async ({ doctorId }) => {
  const waiting = await AppointmentWaitlist.findAll({
    where: { doctorId, status: "waiting" },
  });
  if (!waiting.length) {
    return { replaced: false, reason: "no_waitlist" };
  }
  waiting.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const slots = await AppointmentAvailability.findAll({ where: { doctorId } });
  const now = new Date();
  const activeFutureSlots = slots
    .filter((slot) => slot.isActive !== false && new Date(slot.startAt) > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  if (!activeFutureSlots.length) {
    return { replaced: false, reason: "no_future_slots" };
  }

  const existingBookings = await Appointment.findAll({ where: { doctorId } });
  const nextEntry = waiting.find((candidate) => candidate.status === "waiting");
  if (!nextEntry) return { replaced: false, reason: "no_waiting_candidate" };

  for (const slot of activeFutureSlots) {
    const maxBookings = Number(slot.maxBookings || 1);
    const slotBookings = existingBookings.filter(
      (booking) => booking.availabilityId === slot.id && ACTIVE_BOOKING_STATUSES.has(String(booking.status || "").toLowerCase())
    );
    const openSpots = Math.max(0, maxBookings - slotBookings.length);
    if (!openSpots) continue;

    const duplicateForSlot = existingBookings.some(
      (booking) =>
        booking.availabilityId === slot.id &&
        booking.patientId === nextEntry.patientId &&
        ACTIVE_BOOKING_STATUSES.has(String(booking.status || "").toLowerCase())
    );
    if (duplicateForSlot) {
      nextEntry.status = "skipped_duplicate";
      await nextEntry.save();
      return { replaced: false, reason: "duplicate_in_slot" };
    }

    const booking = await Appointment.create({
      availabilityId: slot.id,
      doctorId,
      patientId: nextEntry.patientId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      mode: slot.mode || "in-person",
      location: slot.location || null,
      reason: nextEntry.reason || "Auto-filled after no-show",
      triageTags: Array.isArray(nextEntry.triageTags) ? nextEntry.triageTags : ["routine"],
      source: "waitlist_autofill_reception",
      status: "pending",
      reminderChannel: "email",
      reminderDefault24h: true,
      reminderCustomAlertAt: null,
      reminderDefaultSentAt: null,
      reminderCustomSentAt: null,
      reminderLastSentAt: null,
      reminderHistory: [],
      feeRequired: Boolean(slot.feeRequired),
      feeAmount: toMoney(slot.feeAmount || 0),
      feeCurrency: defaultFeeCurrency(slot.feeCurrency),
      paymentStatus: Boolean(slot.feeRequired) && toMoney(slot.feeAmount || 0) > 0 ? "unpaid" : "not_required",
      paymentCollectedAmount: 0,
      paymentMethod: null,
      paymentReference: null,
      paymentCollectedAt: null,
      paymentCollectedBy: null,
      paymentNotes: null,
      paymentHistory: [],
      consultationFee: toMoney(slot.feeAmount || 0),
      additionalCharges: 0,
      nhfDeductionAmount: 0,
      billingReadyForCollection: false,
      billingReadyAt: null,
    });

    nextEntry.status = "booked";
    nextEntry.bookedAppointmentId = booking.id;
    nextEntry.bookedAt = new Date().toISOString();
    await nextEntry.save();
    return {
      replaced: true,
      bookingId: booking.id,
      waitlistId: nextEntry.id,
      startAt: booking.startAt,
    };
  }

  return { replaced: false, reason: "no_open_slot" };
};
const getPaymentDueDate = (appointment) => {
  if (appointment?.paymentDueDate) return appointment.paymentDueDate;
  return addDays(appointment?.endAt || appointment?.startAt || new Date(), 7);
};
const isOverdue = (dueDateIso, now = new Date()) => {
  const due = new Date(dueDateIso);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
};

const normalizeEligibilityPayload = (payload = {}) => {
  const payerTypeRaw = String(payload.payerType || "").trim().toLowerCase();
  const payerType = ["nhf", "insurance", "self_pay"].includes(payerTypeRaw) ? payerTypeRaw : "nhf";
  const memberId = String(payload.memberId || "").trim();
  const planName = String(payload.planName || "").trim();
  const serviceDate = toDateKey(payload.serviceDate || new Date()) || toDateKey(new Date());
  const expectedAmount = Math.max(0, toMoney(payload.expectedAmount || 0));
  return { payerType, memberId, planName, serviceDate, expectedAmount };
};

const buildEligibilityResult = ({ payload, appointment, checkedBy }) => {
  const feeAmount = toMoney(payload.expectedAmount || appointment?.feeAmount || 0);
  const now = new Date().toISOString();
  const hasValidMember = /^[A-Za-z0-9-]{6,32}$/.test(payload.memberId || "");

  if (payload.payerType === "self_pay") {
    return {
      payerType: payload.payerType,
      memberId: null,
      planName: "Self Pay",
      serviceDate: payload.serviceDate,
      expectedAmount: feeAmount,
      status: "eligible",
      reason: "Self-pay selected; eligibility verification not required.",
      approvedAmount: feeAmount,
      coPayAmount: 0,
      reference: `SELF-${Date.now().toString(36).toUpperCase()}`,
      checkedAt: now,
      checkedBy,
    };
  }

  if (!hasValidMember) {
    return {
      payerType: payload.payerType,
      memberId: payload.memberId || null,
      planName: payload.planName || null,
      serviceDate: payload.serviceDate,
      expectedAmount: feeAmount,
      status: "ineligible",
      reason: "Member ID is missing or invalid format.",
      approvedAmount: 0,
      coPayAmount: feeAmount,
      reference: null,
      checkedAt: now,
      checkedBy,
    };
  }

  if (payload.payerType === "nhf") {
    const approvedAmount = Math.max(0, toMoney(Math.min(feeAmount, feeAmount * 0.7)));
    return {
      payerType: payload.payerType,
      memberId: payload.memberId,
      planName: payload.planName || "NHF Standard",
      serviceDate: payload.serviceDate,
      expectedAmount: feeAmount,
      status: "eligible",
      reason: "NHF member verified for outpatient visit.",
      approvedAmount,
      coPayAmount: Math.max(0, toMoney(feeAmount - approvedAmount)),
      reference: `NHF-${Date.now().toString(36).toUpperCase()}`,
      checkedAt: now,
      checkedBy,
    };
  }

  const approvedAmount = Math.max(0, toMoney(Math.min(feeAmount, feeAmount * 0.8)));
  return {
    payerType: payload.payerType,
    memberId: payload.memberId,
    planName: payload.planName || "Insurance Plan",
    serviceDate: payload.serviceDate,
    expectedAmount: feeAmount,
    status: "eligible",
    reason: "Insurance member verified for scheduled appointment.",
    approvedAmount,
    coPayAmount: Math.max(0, toMoney(feeAmount - approvedAmount)),
    reference: `INS-${Date.now().toString(36).toUpperCase()}`,
    checkedAt: now,
    checkedBy,
  };
};

const applyArrivalTransition = ({ appointment, targetStatus, actorUserId, note }) => {
  const current = deriveArrivalStatus(appointment);
  const target = String(targetStatus || "").trim().toLowerCase();
  if (!ARRIVAL_STATES.includes(target)) {
    return { error: "status must be waiting, arrived, in_room, or completed" };
  }
  if (!ARRIVAL_TRANSITIONS[current]?.has(target)) {
    return { error: `Invalid transition from ${current} to ${target}` };
  }

  const now = new Date().toISOString();
  appointment.arrivalStatus = target;
  appointment.receptionUpdatedAt = now;
  appointment.receptionUpdatedBy = actorUserId;
  if (note) {
    appointment.receptionNote = note;
  }
  if (target === "arrived") {
    appointment.arrivedAt = appointment.arrivedAt || now;
    appointment.checkedInAt = appointment.checkedInAt || now;
    appointment.checkedInBy = appointment.checkedInBy || actorUserId;
    if (appointment.status === "pending") {
      appointment.status = "approved";
    }
  } else if (target === "in_room") {
    appointment.inRoomAt = appointment.inRoomAt || now;
    if (appointment.status === "pending") {
      appointment.status = "approved";
    }
  } else if (target === "completed") {
    appointment.completedAt = appointment.completedAt || now;
    appointment.status = "completed";
  }
  return { appointment, current, target };
};

router.get("/access-grants", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  grants.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  const doctorIds = Array.from(new Set(grants.map((entry) => entry.doctorId)));
  const patientIds = Array.from(new Set(grants.map((entry) => entry.patientId)));
  const doctorMap = new Map();
  const patientMap = new Map();

  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor && doctor.role === "doctor") doctorMap.set(doctorId, doctor);
  }
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient && patient.role === "patient") patientMap.set(patientId, patient);
  }
  let assignedDoctor = null;
  if (req.user.createdByDoctorId) {
    assignedDoctor = await User.findByPk(req.user.createdByDoctorId);
  }

  return res.json({
    receptionist: {
      id: req.user.id,
      fullName: req.user.fullName || null,
      platformStaffId: req.user.platformStaffId || null,
      certificationId: req.user.platformStaffId || null,
      createdByDoctorId: req.user.createdByDoctorId || null,
      assignedDoctorName: assignedDoctor?.fullName || null,
    },
    grants: grants.map((entry) => {
      const doctor = doctorMap.get(entry.doctorId);
      const patient = patientMap.get(entry.patientId);
      const showDemographics = canSeeDemographics(entry);
      return {
        id: entry.id,
        doctorId: entry.doctorId,
        doctorName: doctor?.fullName || "Unknown doctor",
        patientId: entry.patientId,
        patientName: showDemographics
          ? patient?.fullName || "Unknown patient"
          : `Patient ${String(entry.patientId || "").slice(0, 8)}`,
        scopes: {
          canViewDemographics: Boolean(entry.canViewDemographics),
          canViewAppointments: Boolean(entry.canViewAppointments),
          canViewPrivateNotes: Boolean(entry.canViewPrivateNotes),
          canViewPrescriptions: Boolean(entry.canViewPrescriptions),
        },
        updatedAt: entry.updatedAt || entry.createdAt,
      };
    }),
  });
});

router.get("/cashier-summary", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const date = toDateKey(req.query.date || new Date()) || toDateKey(new Date());
  const allAppointments = await Appointment.findAll({});
  const totals = {
    date,
    cashierUserId: req.user.id,
    cashierName: req.user.fullName || null,
    cashierPlatformStaffId: req.user.platformStaffId || null,
    transactionCount: 0,
    totalCollected: 0,
    cashTotal: 0,
    cardTotal: 0,
    transferTotal: 0,
    insuranceTotal: 0,
    waivedCount: 0,
    byCurrency: {},
  };

  for (const appointment of allAppointments) {
    const history = Array.isArray(appointment.paymentHistory) ? appointment.paymentHistory : [];
    for (const entry of history) {
      if (String(entry?.by || "") !== String(req.user.id || "")) continue;
      if (toDateKey(entry?.at) !== date) continue;
      const method = String(entry?.method || "").toLowerCase();
      const amount = toMoney(entry?.amount || 0);
      const currency = defaultFeeCurrency(appointment.feeCurrency);
      totals.transactionCount += 1;
      if (method === "waived") {
        totals.waivedCount += 1;
      } else {
        totals.totalCollected = toMoney(totals.totalCollected + amount);
        totals.byCurrency[currency] = toMoney((totals.byCurrency[currency] || 0) + amount);
      }
      if (method === "cash") totals.cashTotal = toMoney(totals.cashTotal + amount);
      if (method === "card") totals.cardTotal = toMoney(totals.cardTotal + amount);
      if (method === "transfer") totals.transferTotal = toMoney(totals.transferTotal + amount);
      if (method === "insurance") totals.insuranceTotal = toMoney(totals.insuranceTotal + amount);
    }
  }

  return res.json({ summary: totals });
});

router.get("/billing-alerts", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const date = toDateKey(req.query.date || "");
  const allAppointments = await Appointment.findAll({});
  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  const managedDoctorIds = new Set(
    grants.map((entry) => String(entry.doctorId))
  );
  if (req.user.createdByDoctorId) {
    managedDoctorIds.add(String(req.user.createdByDoctorId));
  }
  const grantMap = new Map(
    grants.map((entry) => [`${entry.doctorId}:${entry.patientId}`, entry])
  );

  const billables = allAppointments.filter((entry) => {
    if (!managedDoctorIds.has(String(entry.doctorId))) return false;
    if (date && toDateKey(entry.startAt) !== date) return false;
    const payment = derivePaymentSummary(entry);
    const hasOutstandingBalance = Boolean(payment.feeRequired) && ["unpaid", "partial"].includes(payment.status);
    return (entry.billingReadyForCollection === true || Boolean(entry.receptionHandoffAt)) && hasOutstandingBalance;
  });
  billables.sort((a, b) => new Date(b.createdAt || b.startAt) - new Date(a.createdAt || a.startAt));

  const doctorIds = Array.from(new Set(billables.map((entry) => entry.doctorId)));
  const patientIds = Array.from(new Set(billables.map((entry) => entry.patientId)));
  const doctorMap = new Map();
  const patientMap = new Map();
  const patientProfileMap = new Map();
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor) doctorMap.set(doctorId, doctor);
  }
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(patientId, patient);
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: patientId } });
    if (profile) patientProfileMap.set(patientId, profile);
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const alerts = billables.map((entry) => {
    const payment = derivePaymentSummary(entry);
    const createdMs = new Date(entry.createdAt || entry.startAt || Date.now()).getTime();
    return {
      id: `bill-${entry.id}`,
      type: "patient_bill_created",
      isNew: Number.isFinite(createdMs) ? createdMs >= cutoff : false,
      createdAt: entry.createdAt || entry.startAt || null,
      appointment: {
        ...entry,
        payment,
        billing: buildBillingPacket(entry),
      },
      doctor: {
        id: entry.doctorId,
        name: doctorMap.get(entry.doctorId)?.fullName || "Unknown doctor",
      },
      patient: {
        id: entry.patientId,
        name: patientMap.get(entry.patientId)?.fullName || `Patient ${String(entry.patientId || "").slice(0, 8)}`,
        email: canSeeDemographics(grantMap.get(`${entry.doctorId}:${entry.patientId}`))
          ? patientMap.get(entry.patientId)?.email || null
          : null,
        phone: canSeeDemographics(grantMap.get(`${entry.doctorId}:${entry.patientId}`))
          ? patientProfileMap.get(entry.patientId)?.phone || null
          : null,
        dob: canSeeDemographics(grantMap.get(`${entry.doctorId}:${entry.patientId}`))
          ? patientProfileMap.get(entry.patientId)?.dob || null
          : null,
        address: canSeeDemographics(grantMap.get(`${entry.doctorId}:${entry.patientId}`))
          ? decryptValue(patientProfileMap.get(entry.patientId)?.address) || null
          : null,
      },
      message: `New bill for appointment ${String(entry.id).slice(0, 8)} is awaiting collection.`,
    };
  });

  return res.json({
    unreadCount: alerts.filter((entry) => entry.isNew).length,
    totalCount: alerts.length,
    alerts,
  });
});

router.get("/search", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const queryRaw = String(req.query.query || "").trim();
  const query = queryRaw.toLowerCase();
  if (!queryRaw) return res.json({ results: [] });

  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  const managedDoctorIds = new Set(
    grants.filter((entry) => canManageAppointments(entry)).map((entry) => String(entry.doctorId))
  );
  if (req.user.createdByDoctorId) managedDoctorIds.add(String(req.user.createdByDoctorId));
  const grantMap = new Map(
    grants
      .filter((entry) => canManageAppointments(entry))
      .map((entry) => [`${entry.doctorId}:${entry.patientId}`, entry])
  );

  const allAppointments = await Appointment.findAll({});
  const visibleAppointments = allAppointments.filter((entry) => managedDoctorIds.has(String(entry.doctorId)));
  const patientIds = Array.from(new Set(visibleAppointments.map((entry) => entry.patientId)));
  const doctorIds = Array.from(new Set(visibleAppointments.map((entry) => entry.doctorId)));
  const doctorMap = new Map();
  const patientMap = new Map();
  const patientProfileMap = new Map();
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor) doctorMap.set(String(doctorId), doctor);
  }
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(String(patientId), patient);
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: patientId } });
    if (profile) patientProfileMap.set(String(patientId), profile);
  }

  const results = [];
  for (const appointment of visibleAppointments) {
    const key = `${appointment.doctorId}:${appointment.patientId}`;
    const grant = grantMap.get(key);
    const showDemographics = isOwnerLinkedDoctor({ receptionist: req.user, doctorId: appointment.doctorId }) || canSeeDemographics(grant);
    const patient = patientMap.get(String(appointment.patientId));
    const doctor = doctorMap.get(String(appointment.doctorId));
    const profile = patientProfileMap.get(String(appointment.patientId));
    const payment = derivePaymentSummary(appointment);
    const phone = showDemographics ? String(profile?.phone || "") : "";
    const patientName = String(patient?.fullName || "");
    const appointmentId = String(appointment.id || "");
    const patientId = String(appointment.patientId || "");
    const doctorId = String(appointment.doctorId || "");
    const receiptMatch = Array.isArray(appointment.paymentHistory)
      ? appointment.paymentHistory.find((entry) =>
        String(entry?.reference || "").toLowerCase().includes(query)
        || String(entry?.id || "").toLowerCase().includes(query))
      : null;

    const appointmentMatch =
      patientName.toLowerCase().includes(query)
      || phone.toLowerCase().includes(query)
      || appointmentId.toLowerCase().includes(query)
      || patientId.toLowerCase().includes(query)
      || doctorId.toLowerCase().includes(query)
      || String(patient?.platformStaffId || "").toLowerCase().includes(query)
      || String(doctor?.platformStaffId || "").toLowerCase().includes(query);

    if (appointmentMatch) {
      results.push({
        id: `appt-${appointment.id}`,
        type: "appointment",
        label: `${patientName || `Patient ${patientId.slice(0, 8)}`} with ${doctor?.fullName || "Doctor"}`,
        subtitle: `${new Date(appointment.startAt).toLocaleString()} | ${appointment.status || "n/a"} | ${appointment.arrivalStatus || "waiting"} | Balance: ${defaultFeeCurrency(payment.feeCurrency)} ${Number(payment.balanceAmount || 0).toFixed(2)}`,
        appointmentId: appointment.id,
        startAt: appointment.startAt || null,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
      });
    }

    if (receiptMatch) {
      results.push({
        id: `receipt-${appointment.id}-${receiptMatch.id}`,
        type: "receipt",
        label: `Receipt ${receiptMatch.reference || receiptMatch.id || "n/a"} | ${patientName || "Patient"}`,
        subtitle: `${new Date(receiptMatch.at || appointment.startAt).toLocaleString()} | ${receiptMatch.method || "n/a"} | ${defaultFeeCurrency(appointment.feeCurrency)} ${Number(receiptMatch.amount || 0).toFixed(2)}`,
        appointmentId: appointment.id,
        startAt: appointment.startAt || null,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        paymentId: receiptMatch.id || null,
      });
    }
  }

  return res.json({ results: results.slice(0, 120) });
});

router.get("/outstanding-balances", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const date = toDateKey(req.query.date || new Date()) || toDateKey(new Date());
  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  const managedDoctorIds = new Set(
    grants.filter((entry) => canManageAppointments(entry)).map((entry) => String(entry.doctorId))
  );
  if (req.user.createdByDoctorId) managedDoctorIds.add(String(req.user.createdByDoctorId));
  const grantMap = new Map(
    grants
      .filter((entry) => canManageAppointments(entry))
      .map((entry) => [`${entry.doctorId}:${entry.patientId}`, entry])
  );

  const allAppointments = await Appointment.findAll({});
  const billables = allAppointments.filter((entry) => {
    if (!managedDoctorIds.has(String(entry.doctorId))) return false;
    const payment = derivePaymentSummary(entry);
    return Boolean(payment.feeRequired) && ["unpaid", "partial"].includes(payment.status) && Number(payment.balanceAmount || 0) > 0;
  });

  const patientIds = Array.from(new Set(billables.map((entry) => entry.patientId)));
  const doctorIds = Array.from(new Set(billables.map((entry) => entry.doctorId)));
  const patientMap = new Map();
  const doctorMap = new Map();
  const patientProfileMap = new Map();
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(String(patientId), patient);
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: patientId } });
    if (profile) patientProfileMap.set(String(patientId), profile);
  }
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor) doctorMap.set(String(doctorId), doctor);
  }

  const byPatient = new Map();
  const now = new Date(`${date}T23:59:59.999Z`);
  for (const entry of billables) {
    const payment = derivePaymentSummary(entry);
    const dueDate = getPaymentDueDate(entry);
    const overdue = isOverdue(dueDate, now);
    const patientId = String(entry.patientId);
    if (!byPatient.has(patientId)) {
      const grant = grantMap.get(`${entry.doctorId}:${entry.patientId}`);
      const showDemographics = isOwnerLinkedDoctor({ receptionist: req.user, doctorId: entry.doctorId }) || canSeeDemographics(grant);
      byPatient.set(patientId, {
        patientId: entry.patientId,
        patientName: patientMap.get(patientId)?.fullName || `Patient ${patientId.slice(0, 8)}`,
        patientPhone: showDemographics ? patientProfileMap.get(patientId)?.phone || null : null,
        patientEmail: showDemographics ? patientMap.get(patientId)?.email || null : null,
        balanceTotal: 0,
        overdueCount: 0,
        openCount: 0,
        nextDueDate: dueDate,
        appointments: [],
      });
    }
    const bucket = byPatient.get(patientId);
    bucket.balanceTotal = toMoney(bucket.balanceTotal + Number(payment.balanceAmount || 0));
    bucket.openCount += 1;
    if (overdue) bucket.overdueCount += 1;
    if (!bucket.nextDueDate || new Date(dueDate) < new Date(bucket.nextDueDate)) {
      bucket.nextDueDate = dueDate;
    }
    bucket.appointments.push({
      appointmentId: entry.id,
      doctorId: entry.doctorId,
      doctorName: doctorMap.get(String(entry.doctorId))?.fullName || "Doctor",
      startAt: entry.startAt,
      dueDate,
      overdue,
      balanceAmount: Number(payment.balanceAmount || 0),
      feeCurrency: payment.feeCurrency || "JMD",
      paymentStatus: payment.status,
    });
  }

  const accounts = Array.from(byPatient.values())
    .sort((a, b) => {
      if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
      return Number(b.balanceTotal || 0) - Number(a.balanceTotal || 0);
    });
  const totals = accounts.reduce((acc, entry) => {
    acc.patientCount += 1;
    acc.openCount += Number(entry.openCount || 0);
    acc.overdueCount += Number(entry.overdueCount || 0);
    acc.balanceTotal = toMoney(acc.balanceTotal + Number(entry.balanceTotal || 0));
    return acc;
  }, { patientCount: 0, openCount: 0, overdueCount: 0, balanceTotal: 0 });

  return res.json({ date, totals, accounts });
});

router.post("/reminders/dispatch", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const body = req.body || {};
  const channelsRaw = Array.isArray(body.channels) ? body.channels : ["email"];
  const channels = channelsRaw
    .map((entry) => String(entry || "").toLowerCase())
    .filter((entry) => ["email", "sms", "whatsapp"].includes(entry));
  if (!channels.length) {
    return res.status(400).json({ error: "At least one channel is required: email, sms, whatsapp" });
  }
  const includeTomorrow = body.includeTomorrowAppointments !== false;
  const includeOverdue = body.includeOverdueBalances !== false;

  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  const managedDoctorIds = new Set(
    grants.filter((entry) => canManageAppointments(entry)).map((entry) => String(entry.doctorId))
  );
  if (req.user.createdByDoctorId) managedDoctorIds.add(String(req.user.createdByDoctorId));

  const allAppointments = await Appointment.findAll({});
  const now = new Date();
  const tomorrowKey = toDateKey(addDays(now, 1));
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const candidates = [];
  for (const appointment of allAppointments) {
    if (!managedDoctorIds.has(String(appointment.doctorId))) continue;
    const appointmentDate = toDateKey(appointment.startAt);
    const payment = derivePaymentSummary(appointment);
    const dueDate = getPaymentDueDate(appointment);
    const overdue = Boolean(payment.feeRequired) && Number(payment.balanceAmount || 0) > 0 && isOverdue(dueDate, todayEnd);
    if (includeTomorrow && appointmentDate === tomorrowKey && ["pending", "approved"].includes(String(appointment.status || "").toLowerCase())) {
      candidates.push({ appointment, type: "appointment_tomorrow" });
    }
    if (includeOverdue && overdue) {
      candidates.push({ appointment, type: "balance_overdue", dueDate, balanceAmount: Number(payment.balanceAmount || 0) });
    }
  }

  const patientIds = Array.from(new Set(candidates.map((entry) => entry.appointment.patientId)));
  const doctorIds = Array.from(new Set(candidates.map((entry) => entry.appointment.doctorId)));
  const patientMap = new Map();
  const patientProfileMap = new Map();
  const doctorMap = new Map();
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(String(patientId), patient);
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: patientId } });
    if (profile) patientProfileMap.set(String(patientId), profile);
  }
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor) doctorMap.set(String(doctorId), doctor);
  }

  let tomorrowCount = 0;
  let overdueCount = 0;
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const dispatchLog = [];

  for (const item of candidates) {
    const appointment = item.appointment;
    const patient = patientMap.get(String(appointment.patientId));
    const doctor = doctorMap.get(String(appointment.doctorId));
    const patientProfile = patientProfileMap.get(String(appointment.patientId));
    const recipient = {
      email: patient?.email || "",
      phone: patientProfile?.phone || "",
    };
    const subject =
      item.type === "appointment_tomorrow"
        ? `Reminder: Appointment tomorrow with ${doctor?.fullName || "your doctor"}`
        : `Payment reminder: balance due for appointment ${String(appointment.id || "").slice(0, 8)}`;
    const messageText =
      item.type === "appointment_tomorrow"
        ? `Hello ${patient?.fullName || "Patient"}, this is a reminder for your appointment on ${new Date(appointment.startAt).toLocaleString()} with ${doctor?.fullName || "your doctor"}.`
        : `Hello ${patient?.fullName || "Patient"}, your outstanding balance is ${defaultFeeCurrency(appointment.feeCurrency)} ${Number(item.balanceAmount || 0).toFixed(2)} due by ${toDateKey(item.dueDate) || "the due date"}.`;
    const reminderHistory = Array.isArray(appointment.reminderHistory) ? appointment.reminderHistory : [];

    for (const channel of channels) {
      // eslint-disable-next-line no-await-in-loop
      const sendResult = await sendReminder({
        channel,
        recipient,
        subject,
        messageText,
        messageHtml: null,
      });
      const status = String(sendResult?.status || "failed");
      if (status === "sent") sentCount += 1;
      if (status === "failed") failedCount += 1;
      if (status === "skipped") skippedCount += 1;
      if (item.type === "appointment_tomorrow") tomorrowCount += 1;
      if (item.type === "balance_overdue") overdueCount += 1;
      const record = {
        id: `rmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        by: req.user.id,
        type: item.type,
        channel,
        status,
        provider: sendResult?.provider || null,
        error: sendResult?.error || null,
      };
      reminderHistory.push(record);
      dispatchLog.push({
        appointmentId: appointment.id,
        type: item.type,
        channel,
        status,
        provider: sendResult?.provider || null,
        error: sendResult?.error || null,
      });
    }
    appointment.reminderHistory = reminderHistory.slice(-200);
    appointment.reminderLastSentAt = reminderHistory[reminderHistory.length - 1]?.at || appointment.reminderLastSentAt;
    // eslint-disable-next-line no-await-in-loop
    await appointment.save();
  }

  await writeAudit({
    actorUserId: req.user.id,
    action: "receptionist.reminders.dispatch",
    entityType: "appointment",
    entityId: null,
    metadata: {
      channels,
      includeTomorrow,
      includeOverdue,
      tomorrowCount,
      overdueCount,
      totalProcessed: tomorrowCount + overdueCount,
      sentCount,
      failedCount,
      skippedCount,
    },
  });

  return res.json({
    channels,
    includeTomorrow,
    includeOverdue,
    queued: {
      tomorrowAppointments: tomorrowCount,
      overdueBalances: overdueCount,
      total: tomorrowCount + overdueCount,
    },
    delivery: {
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
    },
    dispatchLog: dispatchLog.slice(0, 200),
  });
});

router.post("/patients", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const body = req.body || {};
  const doctorId = String(body.doctorId || req.user.createdByDoctorId || "").trim();
  if (!doctorId) {
    return res.status(400).json({ error: "doctorId is required for receptionist patient enrollment" });
  }
  if (!body.fullName || !body.email) {
    return res.status(400).json({ error: "fullName and email are required" });
  }

  const authorized = await getDoctorSchedulingAuthorization({
    receptionistId: req.user.id,
    receptionist: req.user,
    doctorId,
  });
  if (!authorized) {
    return res.status(403).json({ error: "Receptionist is not authorized for this doctor" });
  }

  const doctor = await User.findByPk(doctorId);
  if (!doctor || doctor.role !== "doctor") {
    return res.status(404).json({ error: "Doctor not found" });
  }

  const email = normalizeEmail(body.email);
  const emailHash = hashIdentifier(email);
  const existing = await User.findOne({ where: { emailHash } });
  if (existing) {
    return res.status(409).json({ error: "Patient already exists with this email" });
  }

  const tempPassword = String(body.password || "").trim() || makeTemporaryPassword();
  const user = await User.create({
    fullName: String(body.fullName || "").trim(),
    email,
    role: "patient",
    passwordHash: await hashPassword(tempPassword),
    createdByDoctorId: doctorId,
  });

  const idNumberRaw = String(body.idNumber || "").trim();
  const trnRaw = String(body.trn || "").trim();
  const allergies = parseAllergyListInput(body.allergies);
  const profile = await PatientProfile.create({
    userId: user.id,
    dob: body.dob || null,
    phone: body.phone || null,
    address: encryptValue(body.address || null),
    idNumber: encryptValue(idNumberRaw || null),
    trn: encryptValue(trnRaw || null),
    idNumberHash: idNumberRaw ? hashIdentifier(idNumberRaw) : null,
    trnHash: trnRaw ? hashIdentifier(trnRaw) : null,
    emergencyContactName: encryptValue(body.emergencyContactName || null),
    emergencyContactPhone: encryptValue(body.emergencyContactPhone || null),
    allergies: allergies.length ? encryptValue(JSON.stringify(allergies)) : null,
  });

  await DoctorConnection.create({
    doctorId,
    patientId: user.id,
    status: "approved",
    source: "receptionist_created",
  });

  let accessGrant = await DoctorReceptionAccess.findOne({
    where: {
      doctorId,
      patientId: user.id,
      receptionistId: req.user.id,
      status: "active",
    },
  });
  if (!accessGrant) {
    accessGrant = await DoctorReceptionAccess.create({
      doctorId,
      patientId: user.id,
      receptionistId: req.user.id,
      canViewDemographics: true,
      canViewAppointments: true,
      canViewPrivateNotes: false,
      canViewPrescriptions: false,
      status: "active",
      grantedByDoctorId: doctorId,
      updatedByDoctorId: doctorId,
    });
  }

  await writeAudit({
    actorUserId: req.user.id,
    action: "receptionist.patient.create",
    entityType: "user",
    entityId: user.id,
    metadata: { doctorId, receptionistId: req.user.id },
  });

  return res.status(201).json({
    patient: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      dob: profile?.dob || null,
      phone: profile?.phone || null,
      address: profile?.address ? decryptValue(profile.address) : null,
      idNumberLast4: idNumberRaw ? idNumberRaw.slice(-4) : null,
      trnLast4: trnRaw ? trnRaw.slice(-4) : null,
    },
    accessGrant: {
      id: accessGrant.id,
      doctorId,
      doctorName: doctor.fullName,
      patientId: user.id,
      patientName: user.fullName,
      scopes: {
        canViewDemographics: Boolean(accessGrant.canViewDemographics),
        canViewAppointments: Boolean(accessGrant.canViewAppointments),
        canViewPrivateNotes: Boolean(accessGrant.canViewPrivateNotes),
        canViewPrescriptions: Boolean(accessGrant.canViewPrescriptions),
      },
      updatedAt: accessGrant.updatedAt || accessGrant.createdAt,
    },
    credentialsIssued: { email, temporaryPassword: tempPassword },
  });
});

router.get("/patients", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const doctorId = String(req.query.doctorId || req.user.createdByDoctorId || "").trim();
  const query = String(req.query.query || "").trim().toLowerCase();
  if (!doctorId) {
    return res.status(400).json({ error: "doctorId query is required" });
  }
  const authorized = await getDoctorSchedulingAuthorization({
    receptionistId: req.user.id,
    receptionist: req.user,
    doctorId,
  });
  if (!authorized) {
    return res.json({
      patients: [],
      authorized: false,
      reason: "Receptionist is not authorized for this doctor",
    });
  }

  const ownerLinked = isOwnerLinkedDoctor({ receptionist: req.user, doctorId });
  const links = await DoctorConnection.findAll({
    where: { doctorId, status: "approved" },
  });
  let patientIds = links.map((entry) => String(entry.patientId));

  patientIds = Array.from(new Set(patientIds));
  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, doctorId, status: "active" },
  });
  const grantMap = new Map(grants.map((entry) => [String(entry.patientId), entry]));

  const patients = [];
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (!patient || patient.role !== "patient") continue;
    const grant = grantMap.get(String(patient.id));
    const showDemographics = ownerLinked || canSeeDemographics(grant);
    // eslint-disable-next-line no-await-in-loop
    const profile = showDemographics
      ? await PatientProfile.findOne({ where: { userId: patient.id } })
      : null;
    const nameMatch = String(patient.fullName || "").toLowerCase().includes(query);
    const emailMatch = String(patient.email || "").toLowerCase().includes(query);
    const idMatch = String(patient.id || "").toLowerCase().includes(query);
    if (query && !nameMatch && !emailMatch && !idMatch) continue;
    patients.push({
      id: patient.id,
      fullName: patient.fullName,
      email: showDemographics ? patient.email : null,
      phone: showDemographics ? profile?.phone || null : null,
      dob: showDemographics ? profile?.dob || null : null,
      hasActiveGrant: Boolean(grant),
      isDoctorConnected: true,
      doctorId,
    });
    if (patients.length >= 100) break;
  }

  // Walk-in support: include existing platform patients when searching,
  // even if not yet linked to this doctor. Linking happens when assigned/booked.
  if (query.length >= 2 && patients.length < 100) {
    const connectedSet = new Set(patients.map((entry) => String(entry.id)));
    const allUsers = await User.findAll({});
    for (const entry of allUsers) {
      if (entry.role !== "patient") continue;
      if (connectedSet.has(String(entry.id))) continue;
      const nameMatch = String(entry.fullName || "").toLowerCase().includes(query);
      const emailMatch = String(entry.email || "").toLowerCase().includes(query);
      const idMatch = String(entry.id || "").toLowerCase().includes(query);
      if (!nameMatch && !emailMatch && !idMatch) continue;
      patients.push({
        id: entry.id,
        fullName: entry.fullName,
        email: entry.email || null,
        phone: null,
        dob: null,
        hasActiveGrant: false,
        isDoctorConnected: false,
        doctorId,
      });
      if (patients.length >= 100) break;
    }
  }

  patients.sort((a, b) => String(a.fullName || "").localeCompare(String(b.fullName || "")));
  return res.json({ patients, authorized: true });
});

router.post("/patients/:id/assign", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const doctorId = String(req.body?.doctorId || req.user.createdByDoctorId || "").trim();
  const patientId = String(req.params.id || "").trim();
  if (!doctorId || !patientId) {
    return res.status(400).json({ error: "doctorId and patient id are required" });
  }
  const authorized = await getDoctorSchedulingAuthorization({
    receptionistId: req.user.id,
    receptionist: req.user,
    doctorId,
  });
  if (!authorized) {
    return res.status(403).json({ error: "Receptionist is not authorized for this doctor" });
  }
  const patient = await User.findByPk(patientId);
  if (!patient || patient.role !== "patient") {
    return res.status(404).json({ error: "Patient not found" });
  }
  let connection = await DoctorConnection.findOne({
    where: { doctorId, patientId, status: "approved" },
  });
  if (!connection) {
    connection = await DoctorConnection.create({
      doctorId,
      patientId,
      status: "approved",
      source: "receptionist_assign",
    });
  }
  const grant = await ensureReceptionGrantForDoctorPatient({
    receptionistId: req.user.id,
    doctorId,
    patientId,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "receptionist.patient.assign",
    entityType: "user",
    entityId: patientId,
    metadata: { doctorId, receptionistId: req.user.id },
  });
  return res.json({
    grant: {
      id: grant.id,
      doctorId,
      patientId,
      scopes: {
        canViewDemographics: Boolean(grant.canViewDemographics),
        canViewAppointments: Boolean(grant.canViewAppointments),
        canViewPrivateNotes: Boolean(grant.canViewPrivateNotes),
        canViewPrescriptions: Boolean(grant.canViewPrescriptions),
      },
    },
  });
});

router.get(
  "/appointments/doctors/:doctorId/availability",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const doctorId = req.params.doctorId;
    const patientId = String(req.query.patientId || "").trim();
    const authorized = await getDoctorSchedulingAuthorization({
      receptionistId: req.user.id,
      receptionist: req.user,
      doctorId,
    });
    if (!authorized) {
      return res.json({
        availability: [],
        authorized: false,
        reason: "Receptionist is not authorized for appointment scheduling",
      });
    }

    if (patientId) {
      let grant = await getActiveGrant({
        receptionistId: req.user.id,
        doctorId,
        patientId,
      });
      if (!canOperateForDoctor({ receptionist: req.user, doctorId, grant })) {
        grant = await ensureReceptionGrantForDoctorPatient({
          receptionistId: req.user.id,
          doctorId,
          patientId,
        });
      }
    }

    const slots = await AppointmentAvailability.findAll({ where: { doctorId } });
    const availability = [];
    for (const slot of slots.filter((entry) => entry.isActive !== false)) {
      // eslint-disable-next-line no-await-in-loop
      const booked = await Appointment.count({ where: { availabilityId: slot.id } });
      const maxBookings = Number(slot.maxBookings || 1);
      const remaining = Math.max(0, maxBookings - booked);
      if (remaining > 0) {
        availability.push({
          ...(typeof slot?.toJSON === "function" ? slot.toJSON() : slot),
          remaining,
        });
      }
    }
    availability.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    return res.json({ availability, authorized: true });
  }
);

router.post("/appointments/bookings", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const body = req.body || {};
  const doctorId = String(body.doctorId || "").trim();
  const patientId = String(body.patientId || "").trim();
  const availabilityId = String(body.availabilityId || "").trim();
  if (!doctorId || !patientId || !availabilityId) {
    return res.status(400).json({ error: "doctorId, patientId, and availabilityId are required" });
  }

  let grant = await getActiveGrant({
    receptionistId: req.user.id,
    doctorId,
    patientId,
  });
  if (!canOperateForDoctor({ receptionist: req.user, doctorId, grant })) {
    const authorized = await getDoctorSchedulingAuthorization({
      receptionistId: req.user.id,
      receptionist: req.user,
      doctorId,
    });
    if (authorized) {
      grant = await ensureReceptionGrantForDoctorPatient({
        receptionistId: req.user.id,
        doctorId,
        patientId,
      });
    }
  }
  if (!canOperateForDoctor({ receptionist: req.user, doctorId, grant })) {
    return res.status(403).json({ error: "Receptionist is not authorized for appointment scheduling" });
  }
  if (!grant && isOwnerLinkedDoctor({ receptionist: req.user, doctorId })) {
    grant = await ensureReceptionGrantForDoctorPatient({
      receptionistId: req.user.id,
      doctorId,
      patientId,
    });
  }
  const existingConnection = await DoctorConnection.findOne({
    where: { doctorId, patientId, status: "approved" },
  });
  if (!existingConnection) {
    await DoctorConnection.create({
      doctorId,
      patientId,
      status: "approved",
      source: "receptionist_booking",
    });
  }

  const slot = await AppointmentAvailability.findByPk(availabilityId);
  if (!slot || slot.doctorId !== doctorId || slot.isActive === false) {
    return res.status(404).json({ error: "Availability slot not found" });
  }
  const booked = await Appointment.count({ where: { availabilityId: slot.id } });
  const maxBookings = Number(slot.maxBookings || 1);
  if (booked >= maxBookings) {
    return res.status(409).json({ error: "Selected appointment slot is full" });
  }

  const booking = await Appointment.create({
    availabilityId: slot.id,
    doctorId: slot.doctorId,
    patientId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    mode: slot.mode || "in-person",
    location: slot.location || null,
    reason: body.reason || null,
    triageTags: Array.isArray(body.triageTags) ? body.triageTags.slice(0, 4) : ["routine"],
    source: "receptionist_booking",
    bookingCreatedBy: req.user.id,
    bookingCreatedAt: new Date().toISOString(),
    status: "pending",
    reminderChannel: "email",
    reminderDefault24h: true,
    reminderCustomAlertAt: null,
    reminderDefaultSentAt: null,
    reminderCustomSentAt: null,
    reminderLastSentAt: null,
    reminderHistory: [],
    feeRequired: Boolean(slot.feeRequired),
    feeAmount: toMoney(slot.feeAmount || 0),
    feeCurrency: defaultFeeCurrency(slot.feeCurrency),
    nhfDeductionAmount: 0,
    nhfReference: null,
    paymentStatus: Boolean(slot.feeRequired) && toMoney(slot.feeAmount || 0) > 0 ? "unpaid" : "not_required",
    paymentCollectedAmount: 0,
    paymentMethod: null,
    paymentReference: null,
    paymentCollectedAt: null,
    paymentCollectedBy: null,
    paymentNotes: null,
    paymentHistory: [],
    consultationFee: toMoney(slot.feeAmount || 0),
    additionalCharges: 0,
    nhfDeductionAmount: 0,
    billingReadyForCollection: false,
    billingReadyAt: null,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "receptionist.appointment.create",
    entityType: "appointment",
    entityId: booking.id,
    metadata: { doctorId, patientId, availabilityId },
  });
  return res.status(201).json({ booking });
});

router.get("/appointments", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const date = toDateKey(req.query.date || "");
  const allAppointments = await Appointment.findAll({});
  const grants = await DoctorReceptionAccess.findAll({
    where: { receptionistId: req.user.id, status: "active" },
  });
  const managedDoctorIds = new Set(
    grants.filter((entry) => canManageAppointments(entry)).map((entry) => String(entry.doctorId))
  );
  if (req.user.createdByDoctorId) {
    managedDoctorIds.add(String(req.user.createdByDoctorId));
  }
  const grantMap = new Map(
    grants
      .filter((entry) => canManageAppointments(entry))
      .map((entry) => [`${entry.doctorId}:${entry.patientId}`, entry])
  );

  const visible = allAppointments.filter((entry) => {
    if (!managedDoctorIds.has(String(entry.doctorId))) return false;
    if (!date) return true;
    return toDateKey(entry.startAt) === date;
  });
  visible.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  const doctorIds = Array.from(new Set(visible.map((entry) => entry.doctorId)));
  const patientIds = Array.from(new Set(visible.map((entry) => entry.patientId)));
  const doctorMap = new Map();
  const patientMap = new Map();
  const patientProfileMap = new Map();
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor) doctorMap.set(doctorId, doctor);
  }
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient) patientMap.set(patientId, patient);
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: patientId } });
    if (profile) patientProfileMap.set(patientId, profile);
  }

  return res.json({
    appointments: visible.map((entry) => {
      const grant = grantMap.get(`${entry.doctorId}:${entry.patientId}`);
      const showDemographics = canSeeDemographics(grant);
      const arrivalStatus = deriveArrivalStatus(entry);
      return {
        ...entry,
        arrivalStatus,
        doctorName: doctorMap.get(entry.doctorId)?.fullName || "Unknown doctor",
        patientName: patientMap.get(entry.patientId)?.fullName || `Patient ${String(entry.patientId || "").slice(0, 8)}`,
        patientEmail: showDemographics ? patientMap.get(entry.patientId)?.email || null : null,
        patientPhone: showDemographics ? patientProfileMap.get(entry.patientId)?.phone || null : null,
        patientDob: showDemographics ? patientProfileMap.get(entry.patientId)?.dob || null : null,
        patientAddress: showDemographics
          ? decryptValue(patientProfileMap.get(entry.patientId)?.address) || null
          : null,
        payment: derivePaymentSummary(entry),
        billing: buildBillingPacket(entry),
        structuredDoctorHandoff: entry.structuredDoctorHandoff || null,
        lateArrivalAt: entry.lateArrivalAt || null,
        noShowMarkedAt: entry.noShowMarkedAt || null,
        doctorAlerts: Array.isArray(entry.doctorAlerts) ? entry.doctorAlerts : [],
        insuranceEligibility: entry.insuranceEligibility || {
          payerType: "nhf",
          memberId: null,
          planName: null,
          serviceDate: toDateKey(entry.startAt || new Date()) || null,
          expectedAmount: toMoney(entry.feeAmount || 0),
          status: "unchecked",
          reason: null,
          approvedAmount: 0,
          coPayAmount: 0,
          reference: null,
          checkedAt: null,
          checkedBy: null,
        },
      };
    }),
  });
});

router.post(
  "/appointments/:id/doctor-handoff",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }

    const reason = String(req.body?.reason || "").trim();
    const billing = String(req.body?.billing || "").trim();
    const specialHandling = String(req.body?.specialHandling || "").trim();
    if (!reason && !billing && !specialHandling) {
      return res.status(400).json({ error: "At least one handoff note field is required" });
    }
    const priorityRaw = String(req.body?.priority || "normal").trim().toLowerCase();
    const priority = ["normal", "urgent"].includes(priorityRaw) ? priorityRaw : "normal";
    const handoff = {
      reason: reason || null,
      billing: billing || null,
      specialHandling: specialHandling || null,
      priority,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id,
    };
    appointment.structuredDoctorHandoff = handoff;
    pushDoctorAlert(appointment, {
      type: "reception_handoff",
      message: "Receptionist submitted structured handoff note.",
      priority,
      handoff,
    });
    await appointment.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.handoff_note",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
        priority,
      },
    });

    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
        structuredDoctorHandoff: appointment.structuredDoctorHandoff,
      },
    });
  }
);

router.post(
  "/appointments/:id/no-show",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }
    if (!["pending", "approved"].includes(String(appointment.status || "").toLowerCase())) {
      return res.status(409).json({ error: "Only pending/approved appointments can be marked as no_show" });
    }

    appointment.status = "no_show";
    appointment.arrivalStatus = "waiting";
    appointment.noShowMarkedAt = new Date().toISOString();
    appointment.noShowMarkedBy = req.user.id;
    pushDoctorAlert(appointment, {
      type: "appointment_no_show",
      message: "Appointment was marked no-show by receptionist.",
      priority: "normal",
      noShowMarkedAt: appointment.noShowMarkedAt,
    });
    await appointment.save();

    const replacement = await tryAutoFillWaitlistReplacementForDoctor({ doctorId: appointment.doctorId });
    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.no_show",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
        replacement,
      },
    });

    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
      },
      replacement,
    });
  }
);

router.post(
  "/appointments/:id/late-arrival",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }
    if (!["pending", "approved", "waiting"].includes(String(appointment.status || "").toLowerCase())) {
      return res.status(409).json({ error: "Late-arrival can only be set on pending/approved appointments" });
    }
    const note = String(req.body?.note || "").trim() || null;
    appointment.lateArrivalAt = new Date().toISOString();
    appointment.arrivalStatus = "arrived";
    if (appointment.status === "pending") appointment.status = "approved";
    appointment.receptionNote = note || appointment.receptionNote || null;
    pushDoctorAlert(appointment, {
      type: "appointment_late_arrival",
      message: "Patient arrived late and is ready for review.",
      priority: "normal",
      note,
      lateArrivalAt: appointment.lateArrivalAt,
    });
    await appointment.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.late_arrival",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
      },
    });

    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
      },
    });
  }
);

router.post(
  "/appointments/:id/insurance-eligibility-check",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }

    const payload = normalizeEligibilityPayload(req.body || {});
    const result = buildEligibilityResult({
      payload,
      appointment,
      checkedBy: req.user.id,
    });

    appointment.insuranceEligibility = result;
    await appointment.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.insurance_eligibility_check",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
        payerType: result.payerType,
        status: result.status,
        reference: result.reference || null,
      },
    });

    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
        payment: derivePaymentSummary(appointment),
        billing: buildBillingPacket(appointment),
        insuranceEligibility: result,
      },
      eligibility: result,
    });
  }
);

router.post(
  "/appointments/:id/payment",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }

    const method = String(req.body?.method || "").trim().toLowerCase();
    if (!PAYMENT_METHODS.has(method)) {
      return res.status(400).json({ error: "method must be cash, card, transfer, insurance, waived, or other" });
    }
    const feeAmount = toMoney(appointment.feeAmount || 0);
    const feeRequired = Boolean(appointment.feeRequired) && feeAmount > 0;
    if (!feeRequired) {
      return res.status(409).json({ error: "No fee is configured for this appointment" });
    }

    const currentPayment = derivePaymentSummary(appointment);
    if (["paid", "waived"].includes(currentPayment.status)) {
      return res.status(409).json({ error: "Appointment payment is already settled" });
    }

    const amount = toMoney(req.body?.amount || 0);
    const nhfDeductionCheck = normalizeNhfDeduction({
      appointment,
      value: req.body?.nhfDeductionAmount ?? appointment.nhfDeductionAmount ?? 0,
    });
    if (nhfDeductionCheck.error) {
      return res.status(400).json({ error: nhfDeductionCheck.error });
    }
    const nhfDeductionAmount = nhfDeductionCheck.value;
    const nhfReference = String(req.body?.nhfReference || appointment.nhfReference || "").trim() || null;
    const reference = String(req.body?.reference || "").trim() || null;
    const notes = String(req.body?.notes || "").trim() || null;
    const previousNhfDeduction = toMoney(appointment.nhfDeductionAmount || 0);
    const nhfIncrease = Math.max(0, toMoney(nhfDeductionAmount - previousNhfDeduction));
    if (method !== "waived" && amount <= 0 && nhfIncrease <= 0) {
      return res.status(400).json({ error: "amount must be greater than 0 unless waived or NHF deduction increases" });
    }

    const now = new Date().toISOString();
    const history = Array.isArray(appointment.paymentHistory) ? appointment.paymentHistory : [];

    if (method === "waived") {
      appointment.paymentStatus = "waived";
      appointment.paymentCollectedAmount = toMoney(appointment.paymentCollectedAmount || 0);
    } else {
      const nextPaid = toMoney((appointment.paymentCollectedAmount || 0) + amount);
      appointment.paymentCollectedAmount = nextPaid;
      const balance = Math.max(0, feeAmount - nhfDeductionAmount - nextPaid);
      appointment.paymentStatus = balance > 0 ? "partial" : "paid";
    }
    appointment.nhfDeductionAmount = nhfDeductionAmount;
    appointment.nhfReference = nhfReference;
    appointment.paymentMethod = method;
    appointment.paymentReference = reference;
    appointment.paymentCollectedAt = now;
    appointment.paymentCollectedBy = req.user.id;
    appointment.paymentNotes = notes;
    appointment.paymentHistory = history.concat([
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: now,
        by: req.user.id,
        method,
        amount: method === "waived" ? 0 : amount,
        nhfDeductionAmount,
        nhfReference,
        reference,
        notes,
      },
    ]);
    await appointment.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.payment.collect",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
        method,
        amount: method === "waived" ? 0 : amount,
        nhfDeductionAmount,
        nhfReference,
        status: appointment.paymentStatus,
      },
    });

    const doctor = await User.findByPk(appointment.doctorId);
    const patient = await User.findByPk(appointment.patientId);
    const receptionist = await User.findByPk(req.user.id);
    const latestEntry = (appointment.paymentHistory || [])[appointment.paymentHistory.length - 1] || null;
    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
        payment: derivePaymentSummary(appointment),
      },
      receipt: buildReceiptRecord({
        appointment,
        paymentEntry: latestEntry,
        doctor,
        patient,
        receptionist,
      }),
    });
  }
);

router.get(
  "/appointments/:id/payment-receipt",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }
    const history = Array.isArray(appointment.paymentHistory) ? appointment.paymentHistory : [];
    if (!history.length) {
      return res.status(404).json({ error: "No payment record found for this appointment" });
    }
    const paymentId = String(req.query.paymentId || "").trim();
    const paymentEntry = paymentId
      ? history.find((entry) => String(entry.id) === paymentId)
      : history[history.length - 1];
    if (!paymentEntry) {
      return res.status(404).json({ error: "Payment entry not found" });
    }
    const doctor = await User.findByPk(appointment.doctorId);
    const patient = await User.findByPk(appointment.patientId);
    const receptionist = await User.findByPk(paymentEntry.by || req.user.id);
    return res.json({
      receipt: buildReceiptRecord({
        appointment,
        paymentEntry,
        doctor,
        patient,
        receptionist,
      }),
    });
  }
);

router.post(
  "/appointments/:id/arrival-status",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }

    const transition = applyArrivalTransition({
      appointment,
      targetStatus: req.body?.status,
      actorUserId: req.user.id,
      note: String(req.body?.note || "").trim() || null,
    });
    if (transition.error) {
      return res.status(400).json({ error: transition.error });
    }

    await appointment.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.arrival_transition",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: {
        doctorId: appointment.doctorId,
        patientId: appointment.patientId,
        from: transition.current,
        to: transition.target,
      },
    });
    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
      },
    });
  }
);

router.post(
  "/appointments/:id/check-in",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const appointment = await Appointment.findByPk(req.params.id);
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: appointment.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this appointment" });
    }

    const transition = applyArrivalTransition({
      appointment,
      targetStatus: "arrived",
      actorUserId: req.user.id,
      note: String(req.body?.note || "").trim() || null,
    });
    if (transition.error) {
      return res.status(400).json({ error: transition.error });
    }

    await appointment.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.appointment.check_in",
      entityType: "appointment",
      entityId: appointment.id,
      metadata: { doctorId: appointment.doctorId, patientId: appointment.patientId },
    });
    return res.json({
      appointment: {
        ...appointment,
        arrivalStatus: deriveArrivalStatus(appointment),
      },
    });
  }
);

router.get("/installment-proposals", requireAuth, requireRoles(["receptionist"]), async (req, res) => {
  const proposals = await InstallmentProposal.findAll({});
  const visible = [];
  for (const proposal of proposals) {
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: proposal.doctorId,
      patientId: proposal.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: proposal.doctorId, grant })) continue;
    visible.push(proposal);
  }
  visible.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const doctorIds = Array.from(new Set(visible.map((entry) => String(entry.doctorId || "")).filter(Boolean)));
  const patientIds = Array.from(new Set(visible.map((entry) => String(entry.patientId || "")).filter(Boolean)));
  const doctorNameById = new Map();
  const patientNameById = new Map();
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor && doctor.role === "doctor") doctorNameById.set(doctorId, doctor.fullName || null);
  }
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient && patient.role === "patient") patientNameById.set(patientId, patient.fullName || null);
  }

  return res.json({
    proposals: visible.map((entry) => ({
      ...entry,
      doctorName: doctorNameById.get(String(entry.doctorId || "")) || null,
      patientName: patientNameById.get(String(entry.patientId || "")) || null,
    })),
  });
});

router.post(
  "/installment-proposals/:id/decision",
  requireAuth,
  requireRoles(["receptionist"]),
  async (req, res) => {
    const proposal = await InstallmentProposal.findByPk(req.params.id);
    if (!proposal) return res.status(404).json({ error: "Installment proposal not found" });
    const grant = await getActiveGrant({
      receptionistId: req.user.id,
      doctorId: proposal.doctorId,
      patientId: proposal.patientId,
    });
    if (!canOperateForDoctor({ receptionist: req.user, doctorId: proposal.doctorId, grant })) {
      return res.status(403).json({ error: "Receptionist is not authorized for this installment proposal" });
    }

    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }

    proposal.status = decision;
    proposal.reviewNote = String(req.body?.note || "").trim() || null;
    proposal.reviewedByUserId = req.user.id;
    proposal.reviewedByRole = req.user.role;
    proposal.reviewedAt = new Date().toISOString();
    await proposal.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "receptionist.installment_proposal.decision",
      entityType: "installment_proposal",
      entityId: proposal.id,
      metadata: {
        doctorId: proposal.doctorId,
        patientId: proposal.patientId,
        appointmentId: proposal.appointmentId,
        decision,
      },
    });

    return res.json({ proposal });
  }
);

module.exports = router;

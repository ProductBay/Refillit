import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";
import LocalQrCode from "../components/LocalQrCode.jsx";
import GlobalFeedbackOverlay from "../components/GlobalFeedbackOverlay.jsx";

const maskLinkCode = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "Not available";
  if (raw.length <= 2) return `${raw[0] || ""}•`;
  if (raw.length <= 4) return `${raw.slice(0, 1)}${"•".repeat(Math.max(1, raw.length - 2))}${raw.slice(-1)}`;
  return `${raw.slice(0, 2)}${"•".repeat(Math.max(2, raw.length - 4))}${raw.slice(-2)}`;
};

export default function PatientApp() {
  const FALLBACK_CODE_REVEAL_SECONDS = 20;
  const { apiBase, token, user } = useAuth();
  const role = String(user?.role || "").toLowerCase();
  const isCaregiverSession = role === "caregiver" || role === "patient_proxy";
  const [activeTab, setActiveTab] = useState("overview");
  const [prescId, setPrescId] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [pharmacyId, setPharmacyId] = useState("");
  const [otcPharmacyId, setOtcPharmacyId] = useState("");
  const [otcCatalog, setOtcCatalog] = useState([]);
  const [otcQuery, setOtcQuery] = useState("");
  const [otcCategory, setOtcCategory] = useState("");
  const [otcCartByProductId, setOtcCartByProductId] = useState({});
  const [otcPaymentMethod, setOtcPaymentMethod] = useState("card");
  const [otcSplit, setOtcSplit] = useState({ nhfCredit: "", rxCard: "", card: "" });
  const [otcWarnings, setOtcWarnings] = useState([]);
  const [acknowledgeOtcWarnings, setAcknowledgeOtcWarnings] = useState(false);
  const [isSubmittingOtcOrder, setIsSubmittingOtcOrder] = useState(false);
  const [isRunningOtcPreflight, setIsRunningOtcPreflight] = useState(false);
  const [otcPreflight, setOtcPreflight] = useState({
    state: "idle",
    blockers: [],
    warnings: [],
  });
  const [doctors, setDoctors] = useState([]);
  const [connectedDoctorsOnly, setConnectedDoctorsOnly] = useState(false);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [prescriptions, setPrescriptions] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [selectedAvailability, setSelectedAvailability] = useState("");
  const [appointmentReason, setAppointmentReason] = useState("");
  const [appointments, setAppointments] = useState([]);
  const [referrals, setReferrals] = useState([]);
  const [chatThreads, setChatThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threadMessages, setThreadMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [scanStatus, setScanStatus] = useState("");
  const [scannedPrescription, setScannedPrescription] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [medicationReminders, setMedicationReminders] = useState([]);
  const [medicationReminderForm, setMedicationReminderForm] = useState({
    title: "",
    dosage: "",
    timeOfDay: "",
    note: "",
  });
  const [visitPrepItems, setVisitPrepItems] = useState([]);
  const [visitPrepForm, setVisitPrepForm] = useState({
    text: "",
    category: "question",
    visitDate: "",
    symptomName: "",
    symptomExplanation: "",
    symptomSeverity: "mild",
    occurredDate: "",
    occurredTime: "",
    shareForVirtualNow: false,
  });
  const [careTasks, setCareTasks] = useState([]);
  const [careTaskForm, setCareTaskForm] = useState({
    text: "",
    dueDate: "",
  });
  const [caregiverProxies, setCaregiverProxies] = useState([]);
  const [caregiverForm, setCaregiverForm] = useState({
    fullName: "",
    email: "",
    relationship: "caregiver",
    idType: "national_id",
    idNumber: "",
    organizationName: "",
    phone: "",
    notes: "",
    permissions: {
      canViewEmergencyCard: true,
      canRequestRefills: true,
      canBookAppointments: true,
    },
  });
  const [lastCaregiverCredentials, setLastCaregiverCredentials] = useState(null);
  const [emergencyCard, setEmergencyCard] = useState(null);
  const [emergencyForm, setEmergencyForm] = useState({
    allergies: "",
    conditions: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    insuranceProvider: "",
    insurancePolicyNumber: "",
    nhfNumber: "",
  });
  const [smartRefillItems, setSmartRefillItems] = useState([]);
  const [walletSummary, setWalletSummary] = useState({
    currency: "JMD",
    walletBalance: 0,
    nhfCreditBalance: 0,
  });
  const [isRefillPaymentModalOpen, setIsRefillPaymentModalOpen] = useState(false);
  const [pendingRefillItem, setPendingRefillItem] = useState(null);
  const [refillPaymentMethod, setRefillPaymentMethod] = useState("card");
  const [refillSplit, setRefillSplit] = useState({ nhfCredit: "", rxCard: "", card: "" });
  const [isSubmittingRefillPayment, setIsSubmittingRefillPayment] = useState(false);
  const [patientOrders, setPatientOrders] = useState([]);
  const [trackingOrderId, setTrackingOrderId] = useState("");
  const [trackingData, setTrackingData] = useState(null);
  const [fallbackCodeVisible, setFallbackCodeVisible] = useState(false);
  const [fallbackCodeRemainingSec, setFallbackCodeRemainingSec] = useState(0);
  const [revealedPrescriptionId, setRevealedPrescriptionId] = useState("");
  const [revealedPrescriptionSeconds, setRevealedPrescriptionSeconds] = useState(0);
  const [deliveryPreferenceForm, setDeliveryPreferenceForm] = useState({
    instructions: "",
    recipientName: "",
    recipientPhone: "",
    allowProxyReceive: false,
    addressLine: "",
    city: "",
    parish: "",
    postalCode: "",
    lat: "",
    lng: "",
  });
  const [deliveryConfirmNote, setDeliveryConfirmNote] = useState("");
  const [billingInstallmentForm, setBillingInstallmentForm] = useState({
    appointmentId: "",
    installments: 3,
    startDate: "",
  });
  const [installmentPlans, setInstallmentPlans] = useState([]);
  const [languageMode, setLanguageMode] = useState("en");
  const [plainLanguageMode, setPlainLanguageMode] = useState(true);
  const [termLookup, setTermLookup] = useState("");
  const [televisitCheckRunning, setTelevisitCheckRunning] = useState(false);
  const [televisitReport, setTelevisitReport] = useState(null);
  const [backupCallNumber, setBackupCallNumber] = useState("");
  const [proxyPatients, setProxyPatients] = useState([]);
  const [activePatientId, setActivePatientId] = useState(() => sessionStorage.getItem("refillit_active_patient_id") || "");
  const scannerRef = useRef(null);
  const controlsRef = useRef(null);
  const videoRef = useRef(null);
  const doctorSectionRef = useRef(null);
  const prescriptionSectionRef = useRef(null);
  const chatSectionRef = useRef(null);
  const careSectionRef = useRef(null);
  const utilitiesSectionRef = useRef(null);
  const activePatientEntry = useMemo(
    () => proxyPatients.find((entry) => entry.id === activePatientId) || null,
    [proxyPatients, activePatientId]
  );
  const activePatientPermissions = activePatientEntry?.permissions || {};
  const validateCaregiverIdFormat = (idType, idNumber) => {
    const normalizedType = String(idType || "").trim().toLowerCase();
    const text = String(idNumber || "").trim();
    if (!text) return "ID number is required.";
    switch (normalizedType) {
      case "national_id":
        return /^\d{9,12}$/.test(text) ? "" : "National ID must be 9 to 12 digits.";
      case "passport":
        return /^[A-Z0-9]{6,9}$/i.test(text)
          ? ""
          : "Passport must be 6 to 9 alphanumeric characters.";
      case "driver_license":
        return /^[A-Z0-9-]{6,20}$/i.test(text)
          ? ""
          : "Driver license must be 6 to 20 characters (letters, numbers, hyphen).";
      case "employee_id":
        return /^[A-Z0-9-]{4,20}$/i.test(text)
          ? ""
          : "Employee ID must be 4 to 20 characters (letters, numbers, hyphen).";
      case "company_registration":
        return /^[A-Z0-9-]{5,25}$/i.test(text)
          ? ""
          : "Company registration must be 5 to 25 characters (letters, numbers, hyphen).";
      case "other":
        return /^.{4,30}$/.test(text) ? "" : "ID must be 4 to 30 characters.";
      default:
        return "Select a valid ID type.";
    }
  };
  const caregiverIdValidationError = useMemo(
    () => validateCaregiverIdFormat(caregiverForm.idType, caregiverForm.idNumber),
    [caregiverForm.idNumber, caregiverForm.idType]
  );
  const activePatientName = activePatientEntry?.fullName || user?.fullName || "Patient";
  const withCareContextPath = (path) => {
    if (!isCaregiverSession || !activePatientId) return path;
    const separator = path.includes("?") ? "&" : "?";
    return `${path}${separator}patientId=${encodeURIComponent(activePatientId)}`;
  };
  const ensureCareContext = () => {
    if (!isCaregiverSession) return true;
    if (activePatientId) return true;
    setError("Select an active patient to continue.");
    return false;
  };
  const hasCarePermission = (key) => {
    if (!isCaregiverSession) return true;
    return Boolean(activePatientPermissions?.[key]);
  };
  const selectedDoctorEntry = doctors.find((doctor) => doctor.id === selectedDoctor) || null;
  const visibleDoctors = useMemo(() => {
    if (!connectedDoctorsOnly) return doctors;
    return doctors.filter((doctor) => {
      const status = String(doctor.connectionStatus || "none").toLowerCase();
      return status === "approved" || status === "pending";
    });
  }, [connectedDoctorsOnly, doctors]);
  const selectedDoctorStatusClass = useMemo(() => {
    const status = String(selectedDoctorEntry?.connectionStatus || "none").toLowerCase();
    if (status === "approved") return "patient-doctor-status-badge patient-doctor-status-badge--approved";
    if (status === "pending") return "patient-doctor-status-badge patient-doctor-status-badge--pending";
    return "patient-doctor-status-badge patient-doctor-status-badge--none";
  }, [selectedDoctorEntry?.connectionStatus]);
  const connectedDoctorCount = useMemo(
    () => doctors.filter((doctor) => String(doctor.connectionStatus || "").toLowerCase() === "approved").length,
    [doctors]
  );
  const upcomingAppointmentCount = useMemo(
    () =>
      appointments.filter((booking) => {
        const time = new Date(booking.startAt).getTime();
        return Number.isFinite(time) && time >= Date.now();
      }).length,
    [appointments]
  );
  const referralCount = useMemo(() => referrals.length, [referrals]);
  const unreadDoctorMessages = useMemo(
    () => chatThreads.reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0),
    [chatThreads]
  );
  const isTabDisabled = (tabKey) => {
    if (!isCaregiverSession) return false;
    if (tabKey === "doctor" || tabKey === "prescription") {
      return !hasCarePermission("canBookAppointments");
    }
    if (tabKey === "chat") return !hasCarePermission("canBookAppointments");
    if (tabKey === "care") return !hasCarePermission("canRequestRefills");
    if (tabKey === "utilities") return !hasCarePermission("canBookAppointments");
    return false;
  };
  const isSymptomEntry = visitPrepForm.category === "symptom";
  const symptomFieldValidation = useMemo(() => {
    const symptomNameValid = String(visitPrepForm.symptomName || "").trim().length > 0;
    const occurredDateValid = /^\d{4}-\d{2}-\d{2}$/.test(String(visitPrepForm.occurredDate || "").trim());
    const occurredTimeValid = /^\d{2}:\d{2}$/.test(String(visitPrepForm.occurredTime || "").trim());
    const explanationValid = String(visitPrepForm.symptomExplanation || "").trim().length >= 8;
    return {
      symptomNameValid,
      occurredDateValid,
      occurredTimeValid,
      explanationValid,
      isValid: symptomNameValid && occurredDateValid && occurredTimeValid && explanationValid,
    };
  }, [
    visitPrepForm.symptomExplanation,
    visitPrepForm.symptomName,
    visitPrepForm.occurredDate,
    visitPrepForm.occurredTime,
  ]);
  const nowDate = useMemo(() => new Date(), [appointments, medicationReminders, visitPrepItems, careTasks]);
  const todayDateKey = nowDate.toISOString().slice(0, 10);
  const tomorrowDateKey = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nextAppointment = useMemo(() => {
    const upcoming = appointments
      .filter((booking) => {
        const time = new Date(booking.startAt).getTime();
        return Number.isFinite(time) && time >= Date.now();
      })
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    return upcoming[0] || null;
  }, [appointments]);
  const dueMedicationCount = useMemo(() => {
    const nowMinutes = (() => {
      const now = new Date();
      return now.getHours() * 60 + now.getMinutes();
    })();
    return medicationReminders.filter((item) => {
      if (!item?.active || !item?.timeOfDay) return false;
      const [hours, minutes] = String(item.timeOfDay)
        .split(":")
        .map((entry) => Number(entry || 0));
      const targetMinutes = hours * 60 + minutes;
      return Number.isFinite(targetMinutes) && targetMinutes <= nowMinutes;
    }).length;
  }, [medicationReminders]);
  const pendingVisitPrepCount = useMemo(
    () => visitPrepItems.filter((item) => !item.completed).length,
    [visitPrepItems]
  );
  const openCareTaskCount = useMemo(() => careTasks.filter((item) => !item.completed).length, [careTasks]);
  const toDateKey = (value) => {
    const parsed = new Date(value || "");
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  };
  const scrollToSection = (section) => {
    const refMap = {
      doctor: doctorSectionRef,
      prescription: prescriptionSectionRef,
      chat: chatSectionRef,
      care: careSectionRef,
      utilities: utilitiesSectionRef,
    };
    const tabMap = {
      doctor: "doctor",
      prescription: "prescription",
      chat: "chat",
      care: "care",
      utilities: "utilities",
    };
    if (tabMap[section]) {
      const nextTab = tabMap[section];
      setActiveTab(nextTab);
      window.setTimeout(() => {
        refMap[section]?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
      return;
    }
    refMap[section]?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const reminderPriority = (item) => {
    if (!item?.active || !item?.timeOfDay) return "green";
    const [hours, minutes] = String(item.timeOfDay)
      .split(":")
      .map((entry) => Number(entry || 0));
    const targetMinutes = hours * 60 + minutes;
    if (!Number.isFinite(targetMinutes)) return "green";
    const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
    const actionDate = toDateKey(item.lastActionAt);
    const alreadyTakenToday = String(item.lastAction || "").toLowerCase() === "taken" && actionDate === todayDateKey;
    if (targetMinutes <= nowMinutes && !alreadyTakenToday) return "red";
    if (targetMinutes - nowMinutes <= 120) return "amber";
    return "green";
  };
  const datedTaskPriority = (item, dateField) => {
    if (item?.completed) return "green";
    const key = String(item?.[dateField] || "").trim();
    if (!key) return "amber";
    if (key < todayDateKey) return "red";
    if (key === todayDateKey) return "amber";
    return "green";
  };
  const reminderNotifications = useMemo(() => {
    const notices = [];
    const nextStart = toDateKey(nextAppointment?.startAt);
    if (nextAppointment && (nextStart === todayDateKey || nextStart === tomorrowDateKey)) {
      notices.push({
        id: `appt-${nextAppointment.id}`,
        severity: nextStart === todayDateKey ? "amber" : "green",
        message: `Appointment ${nextStart === todayDateKey ? "today" : "tomorrow"} at ${new Date(
          nextAppointment.startAt
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} with ${
          nextAppointment.doctorName || "your doctor"
        }.`,
      });
    }
    for (const item of medicationReminders) {
      if (!item?.active || !item?.timeOfDay) continue;
      const sev = reminderPriority(item);
      if (!["red", "amber"].includes(sev)) continue;
      notices.push({
        id: `med-${item.id}`,
        severity: sev,
        message: `${item.title}: ${sev === "red" ? "due now" : "due soon"} (${item.timeOfDay}).`,
      });
    }
    for (const item of careTasks) {
      if (item?.completed) continue;
      const dueKey = String(item?.dueDate || "").trim();
      if (!dueKey) continue;
      if (![todayDateKey, tomorrowDateKey].includes(dueKey) && dueKey >= todayDateKey) continue;
      const sev = dueKey < todayDateKey ? "red" : dueKey === todayDateKey ? "amber" : "green";
      notices.push({
        id: `task-${item.id}`,
        severity: sev,
        message: `Care task "${item.text}" is ${sev === "red" ? "overdue" : dueKey === todayDateKey ? "due today" : "due tomorrow"}.`,
      });
    }
    return notices.slice(0, 8);
  }, [nextAppointment, todayDateKey, tomorrowDateKey, medicationReminders, careTasks]);
  const toMoney = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  };
  const currencyFormat = (currency, value) =>
    `${String(currency || "JMD").toUpperCase()} ${toMoney(value).toFixed(2)}`;
  const billingRows = useMemo(() => {
    return appointments
      .map((booking) => {
        const consultationFee = toMoney(booking.consultationFee ?? booking.feeAmount ?? 0);
        const additionalCharges = toMoney(booking.additionalCharges ?? 0);
        const gross = toMoney(consultationFee + additionalCharges);
        const nhfDeduction = toMoney(booking.nhfDeductionAmount ?? 0);
        const paid = toMoney(booking.paymentCollectedAmount ?? 0);
        const balance = Math.max(0, toMoney(gross - nhfDeduction - paid));
        return {
          id: booking.id,
          doctorName: booking.doctorName || booking.doctorId || "Doctor",
          startAt: booking.startAt,
          currency: booking.feeCurrency || "JMD",
          consultationFee,
          additionalCharges,
          gross,
          nhfDeduction,
          paid,
          balance,
          paymentStatus: String(booking.paymentStatus || "not_required").toLowerCase(),
          paymentHistory: Array.isArray(booking.paymentHistory) ? booking.paymentHistory : [],
        };
      })
      .sort((a, b) => new Date(b.startAt || 0) - new Date(a.startAt || 0));
  }, [appointments]);
  const paymentHistoryTimeline = useMemo(() => {
    return billingRows
      .flatMap((row) =>
        row.paymentHistory.map((entry) => ({
          id: `${row.id}-${entry.id || entry.at || Math.random()}`,
          appointmentId: row.id,
          date: entry.at || null,
          amount: toMoney(entry.amount || 0),
          method: entry.method || "N/A",
          status: entry.status || row.paymentStatus,
          reference: entry.reference || null,
          currency: row.currency,
        }))
      )
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }, [billingRows]);
  const openBalanceRows = useMemo(
    () => billingRows.filter((row) => row.balance > 0),
    [billingRows]
  );
  const otcCartItems = useMemo(
    () =>
      otcCatalog
        .filter((entry) => Number(otcCartByProductId[entry.productId] || 0) > 0)
        .map((entry) => ({
          ...entry,
          qty: Number(otcCartByProductId[entry.productId] || 0),
          lineTotal: Number((Number(entry.unitPrice || 0) * Number(otcCartByProductId[entry.productId] || 0)).toFixed(2)),
        })),
    [otcCatalog, otcCartByProductId]
  );
  const otcCartSubtotal = useMemo(
    () => Number(otcCartItems.reduce((sum, entry) => sum + Number(entry.lineTotal || 0), 0).toFixed(2)),
    [otcCartItems]
  );
  const otcPreflightBadge = useMemo(() => {
    if (isRunningOtcPreflight) {
      return {
        label: "Checking",
        className: "patient-priority-badge patient-priority-badge--amber",
      };
    }
    const state = String(otcPreflight.state || "idle").toLowerCase();
    if (state === "blocked") {
      return {
        label: "Blocked",
        className: "patient-priority-badge patient-priority-badge--red",
      };
    }
    if (state === "warning") {
      return {
        label: "Warning",
        className: "patient-priority-badge patient-priority-badge--amber",
      };
    }
    if (state === "ready") {
      return {
        label: "Ready",
        className: "patient-priority-badge patient-priority-badge--green",
      };
    }
    return {
      label: "Not checked",
      className: "patient-priority-badge patient-priority-badge--amber",
    };
  }, [isRunningOtcPreflight, otcPreflight.state]);
  const otcCategories = useMemo(
    () =>
      Array.from(
        new Set(otcCatalog.map((entry) => String(entry.category || "").trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b)),
    [otcCatalog]
  );
  const patientTabs = useMemo(
    () => [
      { key: "overview", label: "Overview", badge: null },
      { key: "doctor", label: "Doctors & Visits", badge: connectedDoctorCount + referralCount },
      { key: "prescription", label: "Prescriptions", badge: prescriptions.length },
      { key: "chat", label: "Chat", badge: unreadDoctorMessages },
      { key: "care", label: "Care Tools", badge: pendingVisitPrepCount + openCareTaskCount },
      { key: "utilities", label: "Billing & Utilities", badge: openBalanceRows.length },
    ],
    [
      connectedDoctorCount,
      referralCount,
      prescriptions.length,
      unreadDoctorMessages,
      pendingVisitPrepCount,
      openCareTaskCount,
      openBalanceRows.length,
    ]
  );
  const selectedInstallmentRow = useMemo(
    () => billingRows.find((row) => row.id === billingInstallmentForm.appointmentId) || null,
    [billingRows, billingInstallmentForm.appointmentId]
  );
  const installmentQuote = useMemo(() => {
    if (!selectedInstallmentRow) return null;
    const installments = Math.max(2, Number(billingInstallmentForm.installments || 2));
    const each = toMoney(selectedInstallmentRow.balance / installments);
    return {
      installments,
      each,
      total: selectedInstallmentRow.balance,
      currency: selectedInstallmentRow.currency,
    };
  }, [selectedInstallmentRow, billingInstallmentForm.installments]);
  const formatOtpStatusLabel = (otpState) => {
    const status = String(otpState?.status || "not_issued").toLowerCase();
    if (status === "issued") return "Delivery code active";
    if (status === "expired") return "Delivery code expired";
    if (status === "locked") return "Delivery code locked";
    if (status === "verified") return "Delivery code verified";
    return "Delivery code not issued yet";
  };
  const formatOtpStatusHint = (otpState) => {
    const status = String(otpState?.status || "not_issued").toLowerCase();
    if (status === "issued") {
      return `A secure delivery code has been generated. It expires at ${
        otpState?.expiresAt ? new Date(otpState.expiresAt).toLocaleString() : "the configured expiry time"
      }.`;
    }
    if (status === "expired") return "Your secure delivery code expired. Ask the courier to re-issue it.";
    if (status === "locked") {
      return `Too many incorrect attempts (${Number(otpState?.attempts || 0)}/${
        Number(otpState?.maxAttempts || 0) || 0
      }). Ask support/courier for reset.`;
    }
    if (status === "verified") return "Secure handoff has already been verified.";
    return "A secure delivery code will appear when your courier is ready to hand over.";
  };
  const otpStatusTone = (otpState) => {
    const status = String(otpState?.status || "not_issued").toLowerCase();
    if (status === "issued" || status === "verified") return "green";
    if (status === "expired" || status === "not_issued") return "amber";
    if (status === "locked") return "red";
    return "amber";
  };
  const showFallbackCode = () => {
    setFallbackCodeVisible(true);
    setFallbackCodeRemainingSec(FALLBACK_CODE_REVEAL_SECONDS);
  };
  const termDictionary = {
    triage: {
      plain: "Quickly sorting patients by urgency to decide who should be seen first.",
      es: "Clasificacion rapida por urgencia para decidir quien debe ser atendido primero.",
    },
    hypertension: {
      plain: "High blood pressure over time.",
      es: "Presion arterial alta con el tiempo.",
    },
    nhf: {
      plain: "National Health Fund support that can reduce your out-of-pocket cost.",
      es: "Apoyo del Fondo Nacional de Salud que puede reducir tu costo directo.",
    },
    refill: {
      plain: "Getting more of a medicine you already use.",
      es: "Obtener mas de un medicamento que ya usas.",
    },
    deductible: {
      plain: "Amount you pay before insurance starts covering costs.",
      es: "Cantidad que pagas antes de que el seguro cubra costos.",
    },
  };
  const termLookupResult = useMemo(() => {
    const key = String(termLookup || "").trim().toLowerCase();
    if (!key) return null;
    const exact = termDictionary[key];
    if (exact) return { term: key, ...exact };
    const partialKey = Object.keys(termDictionary).find((entry) => entry.includes(key));
    return partialKey ? { term: partialKey, ...termDictionary[partialKey] } : null;
  }, [termLookup]);
  const instructionTemplates = useMemo(
    () => [
      {
        id: "med_timing",
        en: "Take your medication at the same time daily with water.",
        es: "Tome su medicamento a la misma hora cada dia con agua.",
      },
      {
        id: "warning_signs",
        en: "If symptoms worsen, contact your clinic immediately or go to urgent care.",
        es: "Si los sintomas empeoran, contacte su clinica de inmediato o vaya a urgencias.",
      },
      {
        id: "follow_up",
        en: "Book your follow-up before leaving and bring your medication list.",
        es: "Programe su seguimiento antes de salir y traiga su lista de medicamentos.",
      },
    ],
    []
  );
  const runTelevisitReadinessCheck = async () => {
    setTelevisitCheckRunning(true);
    setError("");
    try {
      const online = navigator.onLine !== false;
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const networkType = conn?.effectiveType || "unknown";
      const downlink = Number(conn?.downlink || 0);
      const camera = { ok: false, reason: "" };
      const mic = { ok: false, reason: "" };
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        const tracks = stream.getTracks();
        camera.ok = tracks.some((track) => track.kind === "video");
        mic.ok = tracks.some((track) => track.kind === "audio");
        tracks.forEach((track) => track.stop());
      } catch (deviceErr) {
        const reason = String(deviceErr?.message || "Camera/mic access denied or unavailable.");
        camera.reason = reason;
        mic.reason = reason;
      }
      const networkOk = online && (downlink === 0 || downlink >= 1);
      const overall = camera.ok && mic.ok && networkOk;
      setTelevisitReport({
        checkedAt: new Date().toISOString(),
        overall,
        online,
        networkType,
        downlink,
        networkOk,
        camera,
        mic,
      });
      if (!overall) {
        setStatus("Televisit check completed with issues. Use backup phone call if needed.");
      } else {
        setStatus("Televisit check passed. You are ready for virtual visit.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setTelevisitCheckRunning(false);
    }
  };
  const saveInstallmentPlan = async () => {
    if (!selectedInstallmentRow || !installmentQuote) {
      setError("Select a billing item before creating an installment plan.");
      return;
    }
    const startDate = String(billingInstallmentForm.startDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      setError("Select a valid installment start date.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/installment-proposals"),
        method: "POST",
        body: {
          appointmentId: selectedInstallmentRow.id,
          installments: installmentQuote.installments,
          startDate,
        },
      });
      await loadInstallmentPlans();
      setStatus("Installment proposal submitted for doctor/front-desk approval.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const stopScan = () => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    setScanStatus("Scanner stopped");
  };

  const handleScannedQr = async (raw) => {
    const data = await apiFetch({
      apiBase,
      token,
      path: "/api/patient/scan-prescription",
      method: "POST",
      body: { qrContent: raw },
    });
    setScannedPrescription(data.prescription);
    if (data.prescription?.id) {
      setPrescId(data.prescription.id);
    }
    if (data.prescription?.linkCode) {
      setLinkCode(data.prescription.linkCode);
    }
  };

  const startScan = async () => {
    setError("");
    setScanStatus("Starting camera...");
    try {
      if (!scannerRef.current) {
        scannerRef.current = new BrowserMultiFormatReader();
      }
      const controls = await scannerRef.current.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        async (result, decodeError, localControls) => {
          controlsRef.current = localControls;
          if (result) {
            const raw = result.getText();
            setScanStatus("QR captured");
            localControls.stop();
            controlsRef.current = null;
            try {
              await handleScannedQr(raw);
            } catch (err) {
              setError(err.message);
            }
          } else if (decodeError) {
            setScanStatus("Scanning...");
          }
        }
      );
      controlsRef.current = controls;
      setScanStatus("Scanning...");
    } catch (err) {
      setError(err.message);
      setScanStatus("");
    }
  };

  const loadProxyPatients = async () => {
    if (!isCaregiverSession) {
      setProxyPatients([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/proxy-patients",
      });
      const patients = Array.isArray(data?.patients) ? data.patients : [];
      setProxyPatients(patients);
      if (!patients.length) {
        setActivePatientId("");
        sessionStorage.removeItem("refillit_active_patient_id");
        return;
      }
      const isCurrentValid = patients.some((entry) => entry.id === activePatientId);
      if (!isCurrentValid) {
        const fallbackId = patients[0]?.id || "";
        setActivePatientId(fallbackId);
        if (fallbackId) {
          sessionStorage.setItem("refillit_active_patient_id", fallbackId);
        }
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadDoctors = async () => {
    if (isCaregiverSession && !ensureCareContext()) return;
    if (isCaregiverSession && !hasCarePermission("canBookAppointments")) {
      setDoctors([]);
      return;
    }
    try {
      const data = await apiFetch({ apiBase, token, path: withCareContextPath("/api/patient/doctors") });
      const list = data.doctors || [];
      setDoctors(list);
      if (selectedDoctor && !list.some((doctor) => doctor.id === selectedDoctor)) {
        setSelectedDoctor("");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const requestDoctor = async () => {
    if (isCaregiverSession) {
      setError("Caregiver accounts cannot submit new doctor connection requests.");
      return;
    }
    if (!selectedDoctor) {
      setError("Select a doctor first.");
      return;
    }
    await apiFetch({
      apiBase,
      token,
      path: "/api/patient/doctor-requests",
      method: "POST",
      body: { doctorId: selectedDoctor },
    });
    setStatus("Doctor connection requested");
    setError("");
    await loadDoctors();
  };

  const loadAvailability = async () => {
    if (!hasCarePermission("canBookAppointments")) {
      setAvailability([]);
      return;
    }
    if (!ensureCareContext()) return;
    if (!selectedDoctor) {
      setError("Select a doctor first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/appointments/doctors/${selectedDoctor}/availability`),
      });
      setAvailability(data.availability || []);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const bookAppointment = async () => {
    if (!hasCarePermission("canBookAppointments")) {
      setError("Active caregiver permissions do not allow appointment booking.");
      return;
    }
    if (!ensureCareContext()) return;
    if (!selectedDoctor || !selectedAvailability) {
      setError("Select doctor and availability slot.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/appointments/bookings"),
        method: "POST",
        body: {
          doctorId: selectedDoctor,
          availabilityId: selectedAvailability,
          reason: appointmentReason,
        },
      });
      setStatus("Appointment booking request submitted.");
      setSelectedAvailability("");
      setAppointmentReason("");
      await loadMyAppointments();
      await loadAvailability();
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadMyAppointments = async () => {
    if (!hasCarePermission("canBookAppointments")) {
      setAppointments([]);
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/appointments/bookings"),
      });
      setAppointments(data.bookings || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadInstallmentPlans = async () => {
    if (!hasCarePermission("canBookAppointments")) {
      setInstallmentPlans([]);
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/installment-proposals"),
      });
      setInstallmentPlans(data.proposals || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadChatThreads = async () => {
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/chat/threads" });
      setChatThreads(data.threads || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const openDoctorChat = async () => {
    if (!selectedDoctor) {
      setError("Select a doctor first.");
      return;
    }
    if (selectedDoctorEntry?.connectionStatus !== "approved") {
      setError("Doctor chat requires an approved doctor connection.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/chat/threads",
        method: "POST",
        body: { doctorId: selectedDoctor, patientId: user?.id },
      });
      if (data.thread?.id) {
        setActiveThreadId(data.thread.id);
        await loadChatThreads();
      }
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadThreadMessages = async (threadId) => {
    if (!threadId) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${threadId}/messages`,
      });
      setThreadMessages(data.messages || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const sendChatMessage = async () => {
    const content = chatDraft.trim();
    if (!activeThreadId || !content) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${activeThreadId}/messages`,
        method: "POST",
        body: { message: content },
      });
      setChatDraft("");
      await loadThreadMessages(activeThreadId);
    } catch (err) {
      setError(err.message);
    }
  };

  const linkPrescription = async () => {
    if (isCaregiverSession) {
      setError("Prescription linking is only available in the patient account.");
      return;
    }
    if (!prescId.trim() || !linkCode.trim()) {
      setError("Prescription ID and link code are required.");
      return;
    }
    await apiFetch({
      apiBase,
      token,
      path: `/api/patient/prescriptions/${prescId}/link`,
      method: "POST",
      body: { code: linkCode },
    });
    setStatus("Prescription linked");
    setError("");
    await loadPrescriptions();
    await loadSmartRefillAssistant();
  };

  const createOrder = async () => {
    if (isCaregiverSession) {
      setError("Order creation is only available in the patient account.");
      return;
    }
    if (!prescId.trim()) {
      setError("Select or enter a prescription ID first.");
      return;
    }
    if (!pharmacyId.trim()) {
      setError("Enter a pharmacy profile ID.");
      return;
    }
    const data = await apiFetch({
      apiBase,
      token,
      path: "/api/patient/orders",
      method: "POST",
      body: {
        prescId,
        pharmacyId,
        deliveryOption: "delivery",
        payment: { method: "cash", amount: 0, status: "pending" },
        instructions: deliveryPreferenceForm.instructions,
        recipientName: deliveryPreferenceForm.recipientName,
        recipientPhone: deliveryPreferenceForm.recipientPhone,
        allowProxyReceive: deliveryPreferenceForm.allowProxyReceive === true,
        deliveryAddress: {
          addressLine: deliveryPreferenceForm.addressLine,
          city: deliveryPreferenceForm.city,
          parish: deliveryPreferenceForm.parish,
          postalCode: deliveryPreferenceForm.postalCode,
          lat: deliveryPreferenceForm.lat,
          lng: deliveryPreferenceForm.lng,
        },
      },
    });
    setStatus(`Order created: ${data.order.id}`);
    setError("");
    await loadPatientOrders();
    if (data.order?.id) {
      setTrackingOrderId(data.order.id);
      await loadOrderTracking(data.order.id);
    }
    await loadSmartRefillAssistant();
  };

  const loadOtcCatalog = async () => {
    if (isCaregiverSession) {
      setOtcCatalog([]);
      return;
    }
    try {
      const params = new URLSearchParams();
      if (otcPharmacyId.trim()) params.set("pharmacyId", otcPharmacyId.trim());
      if (otcQuery.trim()) params.set("q", otcQuery.trim());
      if (otcCategory.trim()) params.set("category", otcCategory.trim());
      params.set("limit", "60");
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/patient/otc/catalog${query}`,
      });
      const items = data.items || [];
      setOtcCatalog(items);
      if (!otcPharmacyId.trim()) {
        const firstPharmacyId = String(items[0]?.pharmacyId || "").trim();
        if (firstPharmacyId) setOtcPharmacyId(firstPharmacyId);
      }
      setOtcPreflight({ state: "idle", blockers: [], warnings: [] });
      setOtcWarnings([]);
      setAcknowledgeOtcWarnings(false);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const setOtcCartQty = (productId, qty) => {
    const product = otcCatalog.find((entry) => String(entry.productId) === String(productId));
    if (!product) return;
    const maxQty = Math.max(0, Number(product.maxPerOrder || 0));
    const nextQty = Math.max(0, Math.min(maxQty || 0, Number(qty || 0)));
    setOtcCartByProductId((current) => ({
      ...current,
      [productId]: nextQty,
    }));
    setAcknowledgeOtcWarnings(false);
  };

  const runOtcPreflight = async () => {
    if (isCaregiverSession) {
      setOtcPreflight({ state: "idle", blockers: [], warnings: [] });
      return;
    }
    if (!otcPharmacyId.trim() || !otcCartItems.length) {
      setOtcPreflight({ state: "idle", blockers: [], warnings: [] });
      return;
    }
    setIsRunningOtcPreflight(true);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/otc/preflight",
        method: "POST",
        body: {
          pharmacyId: otcPharmacyId.trim(),
          items: otcCartItems.map((entry) => ({
            productId: entry.productId,
            qty: Number(entry.qty || 0),
          })),
        },
      });
      setOtcPreflight({
        state: String(data?.state || "ready").toLowerCase(),
        blockers: Array.isArray(data?.blockers) ? data.blockers : [],
        warnings: Array.isArray(data?.warnings) ? data.warnings : [],
      });
      setOtcWarnings(Array.isArray(data?.warnings) ? data.warnings : []);
      if (!Array.isArray(data?.warnings) || !data.warnings.length) {
        setAcknowledgeOtcWarnings(false);
      }
    } catch (err) {
      const blockers = Array.isArray(err?.payload?.blockers) ? err.payload.blockers : [];
      const warnings = Array.isArray(err?.payload?.warnings) ? err.payload.warnings : [];
      setOtcPreflight({
        state: "blocked",
        blockers: blockers.length ? blockers : [err.message],
        warnings,
      });
      if (warnings.length) setOtcWarnings(warnings);
    } finally {
      setIsRunningOtcPreflight(false);
    }
  };

  const submitOtcOrder = async () => {
    setIsSubmittingOtcOrder(true);
    try {
      if (isCaregiverSession) {
        setError("OTC ordering is only available in the patient account.");
        return;
      }
      if (!otcPharmacyId.trim()) {
        setError("Enter a pharmacy ID for OTC ordering.");
        return;
      }
      if (!otcCartItems.length) {
        setError("Add at least one OTC item to cart.");
        return;
      }
      const deliveryFee = 600;
      const allocations =
        otcPaymentMethod === "split"
          ? {
              nhfCredit: toMoney(otcSplit.nhfCredit || 0),
              rxCard: toMoney(otcSplit.rxCard || 0),
              card: toMoney(otcSplit.card || 0),
            }
          : null;
      const intentCreate = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/otc/payment-intents",
        method: "POST",
        body: {
          pharmacyId: otcPharmacyId.trim(),
          items: otcCartItems.map((entry) => ({
            productId: entry.productId,
            qty: Number(entry.qty || 0),
          })),
          method: otcPaymentMethod,
          deliveryFee,
          allocations,
        },
      });
      const intentId = intentCreate?.intent?.id;
      if (!intentId) throw new Error("Failed to initialize OTC payment");
      const intentAuthorize = await apiFetch({
        apiBase,
        token,
        path: `/api/patient/otc/payment-intents/${encodeURIComponent(intentId)}/authorize`,
        method: "POST",
      });
      const finalStatus = String(intentAuthorize?.intent?.status || "").toLowerCase();
      if (!["authorized", "paid"].includes(finalStatus)) {
        throw new Error("OTC payment not authorized");
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/otc/orders",
        method: "POST",
        body: {
          pharmacyId: otcPharmacyId.trim(),
          paymentIntentId: intentId,
          acknowledgeInteractionWarnings: acknowledgeOtcWarnings === true,
          items: otcCartItems.map((entry) => ({
            productId: entry.productId,
            qty: Number(entry.qty || 0),
          })),
          deliveryOption: "delivery",
          instructions: deliveryPreferenceForm.instructions,
          recipientName: deliveryPreferenceForm.recipientName,
          recipientPhone: deliveryPreferenceForm.recipientPhone,
          allowProxyReceive: deliveryPreferenceForm.allowProxyReceive === true,
          deliveryAddress: {
            addressLine: deliveryPreferenceForm.addressLine,
            city: deliveryPreferenceForm.city,
            parish: deliveryPreferenceForm.parish,
            postalCode: deliveryPreferenceForm.postalCode,
            lat: deliveryPreferenceForm.lat,
            lng: deliveryPreferenceForm.lng,
          },
        },
      });
      setStatus(`OTC order created: ${data.order.id}`);
      setOtcWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setAcknowledgeOtcWarnings(false);
      setError("");
      setOtcCartByProductId({});
      await loadPatientOrders();
      if (data.order?.id) {
        setTrackingOrderId(data.order.id);
        await loadOrderTracking(data.order.id);
      }
    } catch (err) {
      const warnings = Array.isArray(err?.payload?.warnings) ? err.payload.warnings : [];
      if (warnings.length) {
        setOtcWarnings(warnings);
      }
      setError(err.message);
    } finally {
      setIsSubmittingOtcOrder(false);
    }
  };

  const loadPatientOrders = async () => {
    if (!hasCarePermission("canRequestRefills")) {
      setPatientOrders([]);
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/orders?deliveryOnly=true&limit=80"),
      });
      const rows = data.orders || [];
      setPatientOrders(rows);
      const hasCurrentTracking = rows.some((entry) => String(entry.id || "") === String(trackingOrderId || ""));
      if ((!trackingOrderId || !hasCurrentTracking) && rows.length) {
        const preferred =
          rows.find((entry) => {
            const status = String(entry.dispatchStatus || "").toLowerCase();
            return ["assigned", "accepted", "picked_up", "arrived", "queued"].includes(status);
          }) || rows[0];
        if (preferred?.id) {
          await loadOrderTracking(preferred.id);
        }
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadOrderTracking = async (orderId = trackingOrderId) => {
    if (!orderId) {
      setTrackingData(null);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/orders/${orderId}/tracking`),
      });
      setTrackingData(data || null);
      const prefs = data?.order?.deliveryPreferences || null;
      if (prefs) {
        setDeliveryPreferenceForm({
          instructions: prefs.instructions || "",
          recipientName: prefs.recipientName || "",
          recipientPhone: prefs.recipientPhone || "",
          allowProxyReceive: prefs.allowProxyReceive === true,
          addressLine: prefs.deliveryAddress?.addressLine || data?.order?.deliveryAddressSnapshot?.addressLine || "",
          city: prefs.deliveryAddress?.city || data?.order?.deliveryAddressSnapshot?.city || "",
          parish: prefs.deliveryAddress?.parish || data?.order?.deliveryAddressSnapshot?.parish || "",
          postalCode: prefs.deliveryAddress?.postalCode || data?.order?.deliveryAddressSnapshot?.postalCode || "",
          lat:
            prefs.deliveryAddress?.lat !== undefined && prefs.deliveryAddress?.lat !== null
              ? String(prefs.deliveryAddress.lat)
              : data?.order?.deliveryAddressSnapshot?.lat !== undefined && data?.order?.deliveryAddressSnapshot?.lat !== null
                ? String(data.order.deliveryAddressSnapshot.lat)
                : "",
          lng:
            prefs.deliveryAddress?.lng !== undefined && prefs.deliveryAddress?.lng !== null
              ? String(prefs.deliveryAddress.lng)
              : data?.order?.deliveryAddressSnapshot?.lng !== undefined && data?.order?.deliveryAddressSnapshot?.lng !== null
                ? String(data.order.deliveryAddressSnapshot.lng)
                : "",
        });
      }
      setTrackingOrderId(orderId);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const saveDeliveryPreferences = async () => {
    if (!trackingOrderId) {
      setError("Select a delivery order to update preferences.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/orders/${trackingOrderId}/delivery-preferences`),
        method: "POST",
        body: deliveryPreferenceForm,
      });
      setStatus("Delivery preferences saved.");
      setError("");
      await loadOrderTracking(trackingOrderId);
      await loadPatientOrders();
    } catch (err) {
      setError(err.message);
    }
  };

  const confirmDelivery = async () => {
    if (!trackingOrderId) {
      setError("Select a delivery order first.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/orders/${trackingOrderId}/confirm-delivery`),
        method: "POST",
        body: { confirmed: true, note: deliveryConfirmNote },
      });
      setStatus("Delivery confirmation submitted.");
      setError("");
      await loadOrderTracking(trackingOrderId);
      await loadPatientOrders();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPrescriptions = async () => {
    if (isCaregiverSession && !ensureCareContext()) return;
    if (isCaregiverSession && !hasCarePermission("canRequestRefills")) {
      setPrescriptions([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/prescriptions"),
      });
      setPrescriptions(data.prescriptions || []);
      if (!prescId && data.prescriptions?.length) {
        setPrescId(data.prescriptions[0].id);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPatientReferrals = async () => {
    if (isCaregiverSession && !ensureCareContext()) return;
    if (isCaregiverSession && !hasCarePermission("canBookAppointments")) {
      setReferrals([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/referrals"),
      });
      setReferrals(Array.isArray(data?.referrals) ? data.referrals : []);
    } catch (err) {
      setError(err.message);
    }
  };

  const downloadReferralPacket = async (referralId) => {
    if (!referralId) return;
    if (isCaregiverSession && !hasCarePermission("canBookAppointments")) {
      setError("Caregiver account does not have referral access permission.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/referrals/${encodeURIComponent(referralId)}/packet`),
      });
      const text = String(data?.packetText || "").trim();
      if (!text) {
        setError("Referral packet is empty.");
        return;
      }
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const reference = String(data?.referral?.referralReference || referralId).replace(/[^A-Za-z0-9_-]+/g, "_");
      anchor.href = url;
      anchor.download = `referral-${reference}.txt`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setStatus(`Referral packet downloaded (${reference}).`);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const copyReferralReference = async (reference) => {
    const value = String(reference || "").trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`Referral reference copied: ${value}`);
      setError("");
    } catch (_err) {
      setStatus(`Referral reference: ${value}`);
    }
  };

  const revealPrescriptionCode = (prescriptionId) => {
    if (!prescriptionId) return;
    setRevealedPrescriptionId(prescriptionId);
    setRevealedPrescriptionSeconds(FALLBACK_CODE_REVEAL_SECONDS);
    setStatus("Prescription link code revealed for 20 seconds.");
    setError("");
  };

  const copyPrescriptionCode = async (entry) => {
    const value = String(entry?.linkCode || "").trim();
    if (!value) {
      setError("No link code available for this prescription.");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`Prescription link code copied for ${entry.id}.`);
      setError("");
    } catch (_err) {
      setError("Unable to copy link code. Please reveal and copy manually.");
    }
  };

  const loadMedicationReminders = async () => {
    if (isCaregiverSession) {
      setMedicationReminders([]);
      return;
    }
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/patient/medication-reminders" });
      setMedicationReminders(data.reminders || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const addMedicationReminder = async () => {
    if (isCaregiverSession) {
      setError("Medication reminder edits are only available in the patient account.");
      return;
    }
    if (!medicationReminderForm.title.trim()) {
      setError("Reminder title is required.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/patient/medication-reminders",
        method: "POST",
        body: medicationReminderForm,
      });
      setMedicationReminderForm({ title: "", dosage: "", timeOfDay: "", note: "" });
      await loadMedicationReminders();
      setStatus("Medication reminder created.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const updateMedicationReminder = async (id, action) => {
    if (isCaregiverSession) {
      setError("Medication reminder edits are only available in the patient account.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/medication-reminders/${id}/toggle`,
        method: "POST",
        body: { action },
      });
      await loadMedicationReminders();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadVisitPrep = async () => {
    if (isCaregiverSession) {
      setVisitPrepItems([]);
      return;
    }
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/patient/visit-prep" });
      setVisitPrepItems(data.items || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const addVisitPrepItem = async () => {
    if (isCaregiverSession) {
      setError("Visit prep editing is only available in the patient account.");
      return;
    }
    const isSymptom = isSymptomEntry;
    if (!visitPrepForm.text.trim() && (!isSymptom || !visitPrepForm.symptomName.trim())) {
      setError("Prep note text is required.");
      return;
    }
    if (isSymptom && !symptomFieldValidation.isValid) {
      setError("Complete all required symptom fields before saving.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/visit-prep",
        method: "POST",
        body: visitPrepForm,
      });
      if (visitPrepForm.shareForVirtualNow && data?.item?.id) {
        if (!selectedDoctor || selectedDoctorEntry?.connectionStatus !== "approved") {
          setError("Select an approved doctor to share symptom reports for virtual review.");
          return;
        }
        await apiFetch({
          apiBase,
          token,
          path: `/api/patient/visit-prep/${data.item.id}/share-to-doctor`,
          method: "POST",
          body: { doctorId: selectedDoctor, virtualReview: true },
        });
      }
      setVisitPrepForm({
        text: "",
        category: "question",
        visitDate: "",
        symptomName: "",
        symptomExplanation: "",
        symptomSeverity: "mild",
        occurredDate: "",
        occurredTime: "",
        shareForVirtualNow: false,
      });
      await loadVisitPrep();
      setStatus(
        visitPrepForm.shareForVirtualNow
          ? "Symptom prep item added and shared with doctor for virtual review."
          : "Visit prep item added."
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const shareVisitPrepWithDoctor = async (itemId) => {
    if (isCaregiverSession) {
      setError("Visit prep sharing is only available in the patient account.");
      return;
    }
    if (!selectedDoctor || selectedDoctorEntry?.connectionStatus !== "approved") {
      setError("Select an approved doctor before sharing symptom reports.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/visit-prep/${itemId}/share-to-doctor`,
        method: "POST",
        body: { doctorId: selectedDoctor, virtualReview: true },
      });
      await loadVisitPrep();
      setStatus("Symptom report shared with doctor for virtual diagnosis review.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleVisitPrepItem = async (id) => {
    if (isCaregiverSession) {
      setError("Visit prep editing is only available in the patient account.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/visit-prep/${id}/toggle`,
        method: "POST",
      });
      await loadVisitPrep();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadCareTasks = async () => {
    if (isCaregiverSession) {
      setCareTasks([]);
      return;
    }
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/patient/care-tasks" });
      setCareTasks(data.tasks || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const addCareTask = async () => {
    if (isCaregiverSession) {
      setError("Care task editing is only available in the patient account.");
      return;
    }
    if (!careTaskForm.text.trim()) {
      setError("Task text is required.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/patient/care-tasks",
        method: "POST",
        body: careTaskForm,
      });
      setCareTaskForm({ text: "", dueDate: "" });
      await loadCareTasks();
      setStatus("Care plan task added.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleCareTask = async (id) => {
    if (isCaregiverSession) {
      setError("Care task editing is only available in the patient account.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/care-tasks/${id}/toggle`,
        method: "POST",
      });
      await loadCareTasks();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadCaregiverProxies = async () => {
    if (isCaregiverSession) {
      setCaregiverProxies([]);
      return;
    }
    try {
      const data = await apiFetch({ apiBase, token, path: "/api/patient/caregiver-proxies" });
      setCaregiverProxies(data.proxies || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const addCaregiverProxy = async () => {
    if (isCaregiverSession) {
      setError("Caregiver management can only be done by the patient account owner.");
      return;
    }
    if (!caregiverForm.fullName.trim() || !caregiverForm.email.trim()) {
      setError("Caregiver full name and email are required.");
      return;
    }
    if (caregiverIdValidationError) {
      setError(caregiverIdValidationError);
      return;
    }
    const permissions = caregiverForm.permissions || {};
    if (!permissions.canViewEmergencyCard && !permissions.canRequestRefills && !permissions.canBookAppointments) {
      setError("Enable at least one caregiver permission.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/patient/caregiver-proxies",
        method: "POST",
        body: caregiverForm,
      });
      setCaregiverForm({
        fullName: "",
        email: "",
        relationship: "caregiver",
        idType: "national_id",
        idNumber: "",
        organizationName: "",
        phone: "",
        notes: "",
        permissions: {
          canViewEmergencyCard: true,
          canRequestRefills: true,
          canBookAppointments: true,
        },
      });
      setLastCaregiverCredentials(data.credentialsIssued || null);
      await loadCaregiverProxies();
      setStatus("Caregiver proxy access saved.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleCaregiverProxy = async (id, active) => {
    if (isCaregiverSession) {
      setError("Caregiver management can only be done by the patient account owner.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/caregiver-proxies/${id}/toggle`,
        method: "POST",
        body: { active },
      });
      await loadCaregiverProxies();
      setStatus(active ? "Caregiver access enabled." : "Caregiver access disabled.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const setCaregiverVerification = async (id, nextStatus) => {
    if (isCaregiverSession) {
      setError("Caregiver management can only be done by the patient account owner.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/patient/caregiver-proxies/${id}/verification`,
        method: "POST",
        body: { status: nextStatus },
      });
      await loadCaregiverProxies();
      setStatus(
        nextStatus === "verified"
          ? "Caregiver approved."
          : nextStatus === "declined"
            ? "Caregiver declined."
            : "Caregiver reset to pending."
      );
      setError("");
    } catch (err) {
      if (Number(err?.status || 0) === 404) {
        await loadCaregiverProxies();
        setError("Caregiver record changed or no longer exists. List refreshed.");
        return;
      }
      setError(err.message);
    }
  };

  const loadEmergencyCard = async () => {
    if (!hasCarePermission("canViewEmergencyCard")) {
      setEmergencyCard(null);
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/emergency-card"),
      });
      const card = data.card || null;
      setEmergencyCard(card);
      if (card) {
        setEmergencyForm({
          allergies: Array.isArray(card.allergies) ? card.allergies.join(", ") : "",
          conditions: Array.isArray(card.conditions) ? card.conditions.join(", ") : "",
          emergencyContactName: card.patient?.emergencyContactName || "",
          emergencyContactPhone: card.patient?.emergencyContactPhone || "",
          insuranceProvider: card.insurance?.provider || "",
          insurancePolicyNumber: card.insurance?.policyNumber || "",
          nhfNumber: card.insurance?.nhfNumber || "",
        });
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const saveEmergencyCard = async () => {
    if (!hasCarePermission("canViewEmergencyCard")) {
      setError("Active caregiver permissions do not allow emergency card updates.");
      return;
    }
    if (!ensureCareContext()) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/emergency-card"),
        method: "POST",
        body: emergencyForm,
      });
      await loadEmergencyCard();
      setStatus("Emergency card updated.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSmartRefillAssistant = async () => {
    if (!hasCarePermission("canRequestRefills")) {
      setSmartRefillItems([]);
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/smart-refill-assistant"),
      });
      setSmartRefillItems(data.items || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadWalletSummary = async () => {
    if (!hasCarePermission("canRequestRefills")) {
      setWalletSummary({ currency: "JMD", walletBalance: 0, nhfCreditBalance: 0 });
      return;
    }
    if (!ensureCareContext()) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/payment/wallet-summary"),
      });
      setWalletSummary({
        currency: data.currency || "JMD",
        walletBalance: Number(data.walletBalance || 0),
        nhfCreditBalance: Number(data.nhfCreditBalance || 0),
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const getRefillAmounts = (item) => {
    const refillAmount = toMoney(item?.estimatedRefillAmount || 3000);
    const deliveryFee = toMoney(item?.estimatedDeliveryFee || 600);
    const total = toMoney(refillAmount + deliveryFee);
    return { refillAmount, deliveryFee, total };
  };

  const openRefillPaymentModal = async (item) => {
    if (!item?.prescId) return;
    setPendingRefillItem(item);
    setRefillPaymentMethod("card");
    setRefillSplit({ nhfCredit: "", rxCard: "", card: "" });
    await loadWalletSummary();
    setIsRefillPaymentModalOpen(true);
  };

  const closeRefillPaymentModal = () => {
    if (isSubmittingRefillPayment) return;
    setIsRefillPaymentModalOpen(false);
    setPendingRefillItem(null);
    setRefillPaymentMethod("card");
    setRefillSplit({ nhfCredit: "", rxCard: "", card: "" });
  };

  const requestSmartRefill = async (prescriptionId, paymentIntentId) => {
    if (!hasCarePermission("canRequestRefills")) {
      setError("Active caregiver permissions do not allow refill requests.");
      return;
    }
    if (!ensureCareContext()) return;
    if (!prescriptionId) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/smart-refill-assistant/${prescriptionId}/request`),
        method: "POST",
        body: { paymentIntentId },
      });
      setStatus(
        data.existed
          ? "A refill request is already pending (existing order reused)."
          : "Smart refill request sent and pharmacy order created."
      );
      setError("");
      await loadSmartRefillAssistant();
      await loadPatientOrders();
      await loadWalletSummary();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitRefillPaymentAndRequest = async () => {
    if (!pendingRefillItem?.prescId) return;
    if (!hasCarePermission("canRequestRefills")) {
      setError("Active caregiver permissions do not allow refill requests.");
      return;
    }
    if (!ensureCareContext()) return;
    setIsSubmittingRefillPayment(true);
    try {
      const amounts = getRefillAmounts(pendingRefillItem);
      const allocations =
        refillPaymentMethod === "split"
          ? {
              nhfCredit: toMoney(refillSplit.nhfCredit || 0),
              rxCard: toMoney(refillSplit.rxCard || 0),
              card: toMoney(refillSplit.card || 0),
            }
          : null;
      const intentCreate = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath("/api/patient/payment-intents"),
        method: "POST",
        body: {
          prescId: pendingRefillItem.prescId,
          method: refillPaymentMethod,
          refillAmount: amounts.refillAmount,
          deliveryFee: amounts.deliveryFee,
          allocations,
        },
      });
      const intentId = intentCreate?.intent?.id;
      if (!intentId) throw new Error("Failed to initialize payment");
      const intentAuthorize = await apiFetch({
        apiBase,
        token,
        path: withCareContextPath(`/api/patient/payment-intents/${encodeURIComponent(intentId)}/authorize`),
        method: "POST",
      });
      const finalStatus = String(intentAuthorize?.intent?.status || "").toLowerCase();
      if (!["authorized", "paid"].includes(finalStatus)) {
        throw new Error("Payment not authorized");
      }
      await requestSmartRefill(pendingRefillItem.prescId, intentId);
      setIsRefillPaymentModalOpen(false);
      setPendingRefillItem(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsSubmittingRefillPayment(false);
    }
  };

  useEffect(
    () => () => {
      stopScan();
    },
    []
  );

  useEffect(() => {
    if (isCaregiverSession) {
      loadProxyPatients();
      return;
    }
    loadDoctors();
    loadMyAppointments();
    loadPatientReferrals();
    loadPrescriptions();
    loadChatThreads();
    loadMedicationReminders();
    loadVisitPrep();
    loadCareTasks();
    loadCaregiverProxies();
    loadEmergencyCard();
    loadSmartRefillAssistant();
    loadWalletSummary();
    loadPatientOrders();
    loadInstallmentPlans();
    loadOtcCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCaregiverSession]);

  useEffect(() => {
    if (!isCaregiverSession) return;
    if (!activePatientId) return;
    sessionStorage.setItem("refillit_active_patient_id", activePatientId);
    setSelectedDoctor("");
    setSelectedAvailability("");
    setAvailability([]);
    setAppointments([]);
    setSmartRefillItems([]);
    setEmergencyCard(null);
    setError("");
    loadDoctors();
    loadMyAppointments();
    loadPatientReferrals();
    loadPrescriptions();
    loadEmergencyCard();
    loadSmartRefillAssistant();
    loadWalletSummary();
    loadPatientOrders();
    loadInstallmentPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePatientId, isCaregiverSession]);

  useEffect(() => {
    if (activeTab !== "prescription") return undefined;
    if (isCaregiverSession && (!activePatientId || !hasCarePermission("canRequestRefills"))) {
      return undefined;
    }
    loadPrescriptions();
    loadOtcCatalog();
    const intervalId = window.setInterval(() => {
      loadPrescriptions();
      loadOtcCatalog();
    }, 15000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isCaregiverSession, activePatientId, activePatientEntry?.id]);

  useEffect(() => {
    if (!selectedDoctor) {
      setAvailability([]);
      setSelectedAvailability("");
      return;
    }
    loadAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDoctor]);

  useEffect(() => {
    if (!selectedDoctor) return;
    if (!visibleDoctors.some((doctor) => doctor.id === selectedDoctor)) {
      setSelectedDoctor("");
      setAvailability([]);
      setSelectedAvailability("");
    }
  }, [selectedDoctor, visibleDoctors]);

  useEffect(() => {
    if (activeThreadId) {
      loadThreadMessages(activeThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  useEffect(() => {
    if (activeTab !== "prescription") return undefined;
    if (!hasCarePermission("canRequestRefills")) return undefined;
    const timer = window.setInterval(() => {
      loadPatientOrders();
      if (trackingOrderId) {
        loadOrderTracking(trackingOrderId);
      }
    }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, trackingOrderId, isCaregiverSession, activePatientId]);

  useEffect(() => {
    if (activeTab !== "prescription") return undefined;
    if (isCaregiverSession) return undefined;
    const timer = window.setTimeout(() => {
      runOtcPreflight();
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, otcPharmacyId, otcCartItems, isCaregiverSession]);

  useEffect(() => {
    const otpState = trackingData?.order?.otpState || null;
    const isIssued = String(otpState?.status || "").toLowerCase() === "issued";
    const hasFallbackCode = Boolean(String(otpState?.fallbackCode || "").trim());
    if (isIssued && hasFallbackCode) return;
    setFallbackCodeVisible(false);
    setFallbackCodeRemainingSec(0);
  }, [trackingData?.order?.id, trackingData?.order?.otpState?.status, trackingData?.order?.otpState?.fallbackCode]);

  useEffect(() => {
    if (!fallbackCodeVisible || fallbackCodeRemainingSec <= 0) {
      if (fallbackCodeVisible && fallbackCodeRemainingSec <= 0) {
        setFallbackCodeVisible(false);
      }
      return undefined;
    }
    const timer = window.setInterval(() => {
      setFallbackCodeRemainingSec((current) => Math.max(0, Number(current || 0) - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [fallbackCodeVisible, fallbackCodeRemainingSec]);

  useEffect(() => {
    if (!revealedPrescriptionId || revealedPrescriptionSeconds <= 0) {
      if (revealedPrescriptionId && revealedPrescriptionSeconds <= 0) {
        setRevealedPrescriptionId("");
      }
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRevealedPrescriptionSeconds((current) => Math.max(0, Number(current || 0) - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [revealedPrescriptionId, revealedPrescriptionSeconds]);

  return (
    <section className="panel patient-shell">
      <div className="patient-layout">
        <aside className="patient-sidebar">
          <div className="patient-sidebar__header">
            <h3>Patient Portal</h3>
            <span className="patient-pill">Care Dashboard</span>
          </div>
          <nav className="patient-nav">
            {patientTabs.map((tab) => {
              const disabled = isTabDisabled(tab.key);
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`patient-nav__item ${activeTab === tab.key ? "active" : ""}`}
                  onClick={() => setActiveTab(tab.key)}
                  disabled={disabled}
                  title={disabled ? "Permission required for caregiver session." : ""}
                >
                  <span>{tab.label}</span>
                  {tab.badge ? <span className="patient-nav__badge">{tab.badge}</span> : null}
                </button>
              );
            })}
          </nav>
          <div className="patient-sidebar__hint">
            Use the tabs to focus on one workflow at a time.
          </div>
        </aside>

        <div className="patient-content">
          <header className="patient-header">
            <div>
              <div className="patient-title-row">
                <h2>Patient Portal</h2>
                <span className="patient-pill">Care Dashboard</span>
              </div>
              <p className="patient-subhead">
                Welcome, {user?.fullName || "Patient"}. Use simple step-by-step sections to connect with your doctor,
                book visits, manage prescriptions, and chat.
              </p>
            </div>
            <div className="patient-kpis">
              <article className="patient-kpi">
                <div className="patient-kpi__label">Connected Doctors</div>
                <div className="patient-kpi__value">{connectedDoctorCount}</div>
              </article>
              <article className="patient-kpi">
                <div className="patient-kpi__label">Upcoming Visits</div>
                <div className="patient-kpi__value">{upcomingAppointmentCount}</div>
              </article>
              <article className="patient-kpi">
                <div className="patient-kpi__label">Prescriptions</div>
                <div className="patient-kpi__value">{prescriptions.length}</div>
              </article>
              <article className="patient-kpi">
                <div className="patient-kpi__label">Unread Chats</div>
                <div className="patient-kpi__value">{unreadDoctorMessages}</div>
              </article>
            </div>
          </header>

      {isCaregiverSession ? (
        <section className="patient-caregiver-context">
          <div className="patient-caregiver-context__title">
            Caregiver Active Patient Context
          </div>
          <div className="patient-caregiver-context__controls">
            <label>
              Active patient
              <select
                value={activePatientId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setActivePatientId(nextId);
                  if (!nextId) {
                    sessionStorage.removeItem("refillit_active_patient_id");
                  }
                }}
              >
                <option value="">Select linked patient</option>
                {proxyPatients.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.fullName || entry.id}
                    {entry.relationship ? ` (${entry.relationship})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="ghost" type="button" onClick={loadProxyPatients}>
              Refresh linked patients
            </button>
          </div>
          <div className="patient-caregiver-context__meta">
            <span className="patient-tag">Active patient: {activePatientName}</span>
            <span className="patient-tag">
              Emergency: {hasCarePermission("canViewEmergencyCard") ? "Allowed" : "Blocked"}
            </span>
            <span className="patient-tag">
              Refill: {hasCarePermission("canRequestRefills") ? "Allowed" : "Blocked"}
            </span>
            <span className="patient-tag">
              Booking: {hasCarePermission("canBookAppointments") ? "Allowed" : "Blocked"}
            </span>
          </div>
          <div className="patient-inline-hint">
            Caregiver mode: patient-owner account controls are hidden. You can only access modules permitted for this patient.
          </div>
          {!proxyPatients.length ? (
            <div className="patient-inline-hint patient-inline-hint--error">
              No active patient links found for this caregiver account.
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="patient-meta-row">
        <div className="patient-meta-tags">
          <span className="patient-tag">Patient context: {activePatientName}</span>
          <span className="patient-tag">Selected doctor: {selectedDoctorEntry?.fullName || "None selected"}</span>
          <span className="patient-tag">
            Connection: <span className={selectedDoctorStatusClass}>{String(selectedDoctorEntry?.connectionStatus || "none").toUpperCase()}</span>
          </span>
        </div>
      </div>

      {activeTab === "overview" ? (
        <section className="patient-snapshot">
          <button type="button" className="patient-snapshot-card" onClick={() => scrollToSection("doctor")}>
            <div className="patient-snapshot-card__label">Next Appointment</div>
            <div className="patient-snapshot-card__value">
              {nextAppointment ? new Date(nextAppointment.startAt).toLocaleString() : "None booked"}
            </div>
            <div className="patient-snapshot-card__meta">
              {nextAppointment
                ? `${nextAppointment.doctorName || "Doctor"} | ${nextAppointment.status || "pending"}`
                : "Book from Doctor and Appointments"}
            </div>
          </button>
          <button type="button" className="patient-snapshot-card" onClick={() => scrollToSection("care")}>
            <div className="patient-snapshot-card__label">Medication Due Now</div>
            <div className="patient-snapshot-card__value">{dueMedicationCount}</div>
            <div className="patient-snapshot-card__meta">Based on active reminder times</div>
          </button>
          <button type="button" className="patient-snapshot-card" onClick={() => scrollToSection("care")}>
            <div className="patient-snapshot-card__label">Visit Prep Pending</div>
            <div className="patient-snapshot-card__value">{pendingVisitPrepCount}</div>
            <div className="patient-snapshot-card__meta">Questions/symptoms not checked off</div>
          </button>
          <button type="button" className="patient-snapshot-card" onClick={() => scrollToSection("care")}>
            <div className="patient-snapshot-card__label">Care Tasks Open</div>
            <div className="patient-snapshot-card__value">{openCareTaskCount}</div>
            <div className="patient-snapshot-card__meta">Post-visit items still in progress</div>
          </button>
          <button type="button" className="patient-snapshot-card" onClick={() => scrollToSection("utilities")}>
            <div className="patient-snapshot-card__label">Billing And Televisit</div>
            <div className="patient-snapshot-card__value">{openBalanceRows.length}</div>
            <div className="patient-snapshot-card__meta">Open balances and readiness tools</div>
          </button>
        </section>
      ) : null}

      {activeTab === "overview" ? (
        <section className="patient-alert-panel" aria-live="polite">
          <div className="patient-alert-panel__header">
            <h3>Today And Tomorrow Alerts</h3>
            <button type="button" className="ghost" onClick={() => scrollToSection("care")}>
              Open care tools
            </button>
          </div>
          <div className="patient-alert-list">
            {reminderNotifications.map((notice) => (
              <article key={notice.id} className={`patient-alert-item patient-alert-item--${notice.severity}`}>
                <span className={`patient-priority-badge patient-priority-badge--${notice.severity}`}>
                  {notice.severity.toUpperCase()}
                </span>
                <div>{notice.message}</div>
              </article>
            ))}
            {!reminderNotifications.length ? (
              <div className="meta">No urgent alerts for today or tomorrow.</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {activeTab === "utilities" ? (
        <section className="patient-section" ref={utilitiesSectionRef}>
          <div className="patient-section-header">
            <div className="patient-section-title">
              <span className="section-icon">UTIL</span>
              <h3>Patient Utilities</h3>
            </div>
          </div>
          <div className="patient-grid">
            <article className="patient-card patient-card--wide">
              <div className="doctor-card-header">
                <h3>Billing Clarity Center</h3>
                <button className="ghost" type="button" onClick={loadMyAppointments}>
                  Refresh billing
                </button>
              </div>
            <div className="queue">
              {billingRows.map((row) => (
                <article key={row.id} className="queue-card">
                  <div>
                    <div className="queue-title">
                      {row.doctorName} | {new Date(row.startAt).toLocaleString()}
                    </div>
                    <div className="queue-meta">
                      Consultation: {currencyFormat(row.currency, row.consultationFee)} | Additional:{" "}
                      {currencyFormat(row.currency, row.additionalCharges)} | NHF:{" "}
                      {currencyFormat(row.currency, row.nhfDeduction)}
                    </div>
                    <div className="queue-meta">
                      Gross: {currencyFormat(row.currency, row.gross)} | Paid:{" "}
                      {currencyFormat(row.currency, row.paid)} | Balance:{" "}
                      {currencyFormat(row.currency, row.balance)} | Status: {row.paymentStatus}
                    </div>
                  </div>
                </article>
              ))}
              {!billingRows.length ? <div className="meta">No billing records yet.</div> : null}
            </div>
            <div className="queue">
              <article className="queue-card">
                <div className="queue-title">Payment history timeline</div>
                {paymentHistoryTimeline.length ? (
                  paymentHistoryTimeline.map((entry) => (
                    <div className="queue-meta" key={entry.id}>
                      {entry.date ? new Date(entry.date).toLocaleString() : "No date"} |{" "}
                      {currencyFormat(entry.currency, entry.amount)} | {entry.method} | {entry.status}
                      {entry.reference ? ` | Ref: ${entry.reference}` : ""}
                    </div>
                  ))
                ) : (
                  <div className="queue-meta">No payment events recorded yet.</div>
                )}
              </article>
              <article className="queue-card">
                <div className="queue-title">Balance timeline</div>
                {openBalanceRows.length ? (
                  openBalanceRows.map((row) => (
                    <div className="queue-meta" key={`bal-${row.id}`}>
                      {new Date(row.startAt).toLocaleDateString()} | {row.doctorName} | Open balance:{" "}
                      {currencyFormat(row.currency, row.balance)}
                    </div>
                  ))
                ) : (
                  <div className="queue-meta">No open balances.</div>
                )}
              </article>
            </div>
            <div className="form">
              <div className="queue-title">Installment option</div>
              <label>
                Select open-balance appointment
                <select
                  value={billingInstallmentForm.appointmentId}
                  onChange={(e) =>
                    setBillingInstallmentForm((current) => ({ ...current, appointmentId: e.target.value }))
                  }
                >
                  <option value="">Select appointment</option>
                  {openBalanceRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {new Date(row.startAt).toLocaleDateString()} | {row.doctorName} |{" "}
                      {currencyFormat(row.currency, row.balance)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Number of installments
                <select
                  value={billingInstallmentForm.installments}
                  onChange={(e) =>
                    setBillingInstallmentForm((current) => ({
                      ...current,
                      installments: Math.max(2, Number(e.target.value || 2)),
                    }))
                  }
                >
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                  <option value={6}>6</option>
                </select>
              </label>
              <label>
                Start date
                <input
                  type="date"
                  value={billingInstallmentForm.startDate}
                  onChange={(e) =>
                    setBillingInstallmentForm((current) => ({ ...current, startDate: e.target.value }))
                  }
                />
              </label>
              {installmentQuote ? (
                <div className="patient-inline-hint">
                  Quote: {installmentQuote.installments} x{" "}
                  {currencyFormat(installmentQuote.currency, installmentQuote.each)} (total{" "}
                  {currencyFormat(installmentQuote.currency, installmentQuote.total)}).
                </div>
              ) : null}
              <button className="primary" type="button" onClick={saveInstallmentPlan}>
                Save installment proposal
              </button>
              <button className="ghost" type="button" onClick={loadInstallmentPlans}>
                Refresh proposals
              </button>
              {installmentPlans.length ? (
                <div className="queue">
                  {installmentPlans.map((plan) => (
                    <div className="queue-meta" key={plan.id}>
                      {new Date(plan.createdAt).toLocaleString()} | {plan.installments} x{" "}
                      {currencyFormat(plan.currency, plan.amountEach)} | Start {plan.startDate} | {plan.status}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </article>

          <article className="patient-card">
            <h3>Multilingual And Plain-Language Mode</h3>
            <div className="form">
              <label>
                Language mode
                <select value={languageMode} onChange={(e) => setLanguageMode(e.target.value)}>
                  <option value="en">English</option>
                  <option value="es">Spanish</option>
                </select>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={plainLanguageMode}
                  onChange={(e) => setPlainLanguageMode(e.target.checked)}
                />
                Plain-language explanations on
              </label>
              <label>
                Medical term lookup
                <input
                  value={termLookup}
                  onChange={(e) => setTermLookup(e.target.value)}
                  placeholder="Try: triage, hypertension, refill, NHF"
                />
              </label>
              {termLookupResult ? (
                <div className="notice">
                  <strong>{termLookupResult.term}</strong>
                  <br />
                  {plainLanguageMode
                    ? termLookupResult.plain
                    : languageMode === "es"
                      ? termLookupResult.es
                      : termLookupResult.plain}
                </div>
              ) : null}
              <div className="queue">
                {instructionTemplates.map((template) => (
                  <article key={template.id} className="queue-card">
                    <div className="queue-meta">
                      {languageMode === "es" ? template.es : template.en}
                    </div>
                    {plainLanguageMode ? (
                      <div className="queue-meta">Simple version: {template.en}</div>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          </article>

          <article className="patient-card">
            <h3>Televisit Readiness Test</h3>
            <div className="form">
              <button className="primary" type="button" onClick={runTelevisitReadinessCheck} disabled={televisitCheckRunning}>
                {televisitCheckRunning ? "Running check..." : "Run camera/mic/network check"}
              </button>
              {televisitReport ? (
                <div className="notice">
                  Overall: {televisitReport.overall ? "Ready" : "Needs attention"}
                  <br />
                  Network:{" "}
                  {televisitReport.networkOk
                    ? `OK (${televisitReport.networkType}, ${televisitReport.downlink || "?"} Mbps)`
                    : `Issue (${televisitReport.networkType}, ${televisitReport.downlink || "?"} Mbps)`}
                  <br />
                  Camera: {televisitReport.camera.ok ? "OK" : `Issue${televisitReport.camera.reason ? ` - ${televisitReport.camera.reason}` : ""}`}
                  <br />
                  Microphone: {televisitReport.mic.ok ? "OK" : `Issue${televisitReport.mic.reason ? ` - ${televisitReport.mic.reason}` : ""}`}
                  <br />
                  Checked: {new Date(televisitReport.checkedAt).toLocaleString()}
                </div>
              ) : (
                <div className="patient-inline-hint">Run the test before virtual appointments to avoid delays.</div>
              )}
              <label>
                Backup phone-call option
                <input
                  value={backupCallNumber}
                  onChange={(e) => setBackupCallNumber(e.target.value)}
                  placeholder="+1 876..."
                />
              </label>
              <div className="patient-inline-hint">
                If device checks fail, keep this number ready for clinic callback fallback.
              </div>
            </div>
          </article>
        </div>
      </section>
      ) : null}

      <div className="patient-sections">
        {activeTab === "doctor" ? (
        <section className="patient-section" ref={doctorSectionRef}>
          <div className="patient-section-header">
            <div className="patient-section-title">
              <span className="section-icon">DOC</span>
              <h3>Doctor And Appointments</h3>
            </div>
          </div>
          <div className="patient-grid">
            <article className="patient-card patient-card--highlight">
              <h3>Choose Doctor</h3>
              <div className="form">
                <button
                  className="primary"
                  onClick={loadDoctors}
                  disabled={isCaregiverSession && (!activePatientId || !hasCarePermission("canBookAppointments"))}
                >
                  Refresh doctor list
                </button>
                <label>
                  Choose doctor
                  <select
                    value={selectedDoctor}
                    onChange={(e) => setSelectedDoctor(e.target.value)}
                    disabled={isCaregiverSession && (!activePatientId || !hasCarePermission("canBookAppointments"))}
                  >
                    <option value="">Select</option>
                    {visibleDoctors.map((doctor) => (
                      <option value={doctor.id} key={doctor.id}>
                        {doctor.fullName}
                        {doctor.connectionStatus === "approved"
                          ? " (Approved)"
                          : doctor.connectionStatus === "pending"
                            ? " (Pending request)"
                            : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={connectedDoctorsOnly}
                    onChange={(e) => setConnectedDoctorsOnly(e.target.checked)}
                  />
                  Connected doctors only
                </label>
                <div className="meta">License: {selectedDoctorEntry?.licenseNumber || "N/A"}</div>
                <button className="primary" onClick={requestDoctor} disabled={!selectedDoctor || isCaregiverSession}>
                  Request doctor connection
                </button>
              </div>
            </article>

            <article className="patient-card">
              <h3>Book Appointment</h3>
              <div className="form">
                <button
                  className="ghost"
                  onClick={loadAvailability}
                  disabled={!selectedDoctor || !hasCarePermission("canBookAppointments")}
                >
                  Refresh appointment slots
                </button>
                <label>
                  Available slots
                  <select
                    value={selectedAvailability}
                    onChange={(e) => setSelectedAvailability(e.target.value)}
                    disabled={!hasCarePermission("canBookAppointments")}
                  >
                    <option value="">Select slot</option>
                    {availability.map((slot) => (
                      <option value={slot.id} key={slot.id}>
                        {new Date(slot.startAt).toLocaleString()} - {slot.mode} ({slot.remaining} left)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Reason for visit
                  <input value={appointmentReason} onChange={(e) => setAppointmentReason(e.target.value)} />
                </label>
                <button
                  className="primary"
                  onClick={bookAppointment}
                  disabled={!selectedAvailability || !hasCarePermission("canBookAppointments")}
                >
                  Book appointment
                </button>
              </div>
            </article>

            <article className="patient-card patient-card--wide">
              <h3>My Appointments</h3>
              <div className="form-row">
                <button className="ghost" onClick={loadMyAppointments} disabled={!hasCarePermission("canBookAppointments")}>
                  Refresh appointments
                </button>
              </div>
              <div className="queue">
                {appointments.map((booking) => (
                  <article key={booking.id} className="queue-card">
                    <div>
                      <div className="queue-title">{booking.doctorName || booking.doctorId}</div>
                      <div className="queue-meta">
                        {new Date(booking.startAt).toLocaleString()} - {new Date(booking.endAt).toLocaleString()}
                      </div>
                      <div className="queue-meta">
                        status: {booking.status} | {booking.mode} | {booking.location || "No location"}
                      </div>
                      <div className="queue-meta">
                        billing: {booking.feeCurrency || "JMD"} {Number(booking.feeAmount || 0).toFixed(2)} | payment:{" "}
                        {booking.paymentStatus || "not_required"}
                      </div>
                    </div>
                  </article>
                ))}
                {!appointments.length ? <div className="meta">No appointments yet.</div> : null}
              </div>
            </article>

            <article className="patient-card patient-card--wide">
              <h3>My Referrals</h3>
              <div className="form-row">
                <button
                  className="ghost"
                  type="button"
                  onClick={loadPatientReferrals}
                  disabled={!hasCarePermission("canBookAppointments")}
                >
                  Refresh referrals
                </button>
              </div>
              <div className="queue">
                {referrals.map((entry) => (
                  <article key={entry.id} className="queue-card">
                    <div className="queue-title">
                      {entry.referralType || "referral"} | {entry.targetName || "Target pending"}
                    </div>
                    <div className="queue-meta">
                      Reference: {entry.referralReference || entry.id} | Priority: {entry.priority || "routine"} | Status: {entry.status || "pending"}
                    </div>
                    <div className="queue-meta">
                      Doctor: {entry.doctorName || entry.doctorId || "n/a"}
                      {entry.requestedByDate ? ` | Requested by: ${entry.requestedByDate}` : ""}
                    </div>
                    {entry.reason ? <div className="queue-meta">Reason: {entry.reason}</div> : null}
                    {entry.clinicalQuestion ? <div className="queue-meta">Question: {entry.clinicalQuestion}</div> : null}
                    <div className="form-row">
                      <button className="primary" type="button" onClick={() => downloadReferralPacket(entry.id)}>
                        Download packet
                      </button>
                      <button className="ghost" type="button" onClick={() => copyReferralReference(entry.referralReference || entry.id)}>
                        Copy reference
                      </button>
                    </div>
                  </article>
                ))}
                {!referrals.length ? (
                  <div className="meta">
                    No referrals yet. Once your doctor creates one, it will appear here with a downloadable packet for lab/specialist handoff.
                  </div>
                ) : null}
              </div>
            </article>
          </div>
        </section>
        ) : null}

        {activeTab === "prescription" ? (
        <section className="patient-section" ref={prescriptionSectionRef}>
          <div className="patient-section-header">
            <div className="patient-section-title">
              <span className="section-icon">RX</span>
              <h3>Prescriptions And Orders</h3>
            </div>
          </div>
          <div className="patient-grid">
            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Link Prescription</h3>
              <div className="form">
                <label>
                  Select linked prescription
                  <select value={prescId} onChange={(e) => setPrescId(e.target.value)}>
                    <option value="">Select prescription</option>
                    {prescriptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id} | {entry.doctorName || entry.doctorId || "Doctor"}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Prescription ID
                  <input value={prescId} onChange={(e) => setPrescId(e.target.value)} />
                </label>
                <label>
                  Link code
                  <input value={linkCode} onChange={(e) => setLinkCode(e.target.value)} />
                </label>
                <button className="primary" onClick={linkPrescription}>
                  Link prescription
                </button>
              </div>
            </article>
            ) : null}

            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Scan QR Prescription</h3>
              <div className="qr-scan-panel">
                <div className="qr-scan-header">
                  <strong>Use camera scanner</strong>
                  <div className="form-row">
                    <button className="primary" type="button" onClick={startScan}>
                      Start scan
                    </button>
                    <button className="ghost" type="button" onClick={stopScan}>
                      Stop scan
                    </button>
                  </div>
                </div>
                <video ref={videoRef} className="qr-video" muted playsInline />
                {scanStatus ? <div className="meta">{scanStatus}</div> : null}
              </div>
              {scannedPrescription ? (
                <div className="notice">
                  <strong>Scanned Prescription</strong>
                  <br />
                  ID: {scannedPrescription.id}
                  <br />
                  Doctor: {scannedPrescription.doctorName || "N/A"} ({scannedPrescription.doctorId || "N/A"})
                  <br />
                  Refill amount: {Number(scannedPrescription.allowedRefills || 0)}
                  <br />
                  Expiry: {scannedPrescription.expiryDate || "N/A"}
                </div>
              ) : null}
            </article>
            ) : null}

            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Create Pharmacy Order</h3>
              <div className="form">
                <label>
                  Pharmacy profile ID
                  <input value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)} />
                </label>
                <button className="primary" onClick={createOrder}>
                  Create order
                </button>
              </div>
            </article>
            ) : null}

            {!isCaregiverSession ? (
            <article className="patient-card patient-card--wide">
              <div className="doctor-card-header">
                <h3>OTC Store</h3>
                <span className={otcPreflightBadge.className}>{otcPreflightBadge.label}</span>
              </div>
              <div className="form">
                <label>
                  Pharmacy profile ID
                  <input value={otcPharmacyId} onChange={(e) => setOtcPharmacyId(e.target.value)} />
                </label>
                <label>
                  Search OTC
                  <input
                    value={otcQuery}
                    onChange={(e) => setOtcQuery(e.target.value)}
                    placeholder="Try: paracetamol, allergy"
                  />
                </label>
                <label>
                  Category
                  <select value={otcCategory} onChange={(e) => setOtcCategory(e.target.value)}>
                    <option value="">all</option>
                    {otcCategories.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="ghost" type="button" onClick={loadOtcCatalog}>
                  Refresh OTC catalog
                </button>
                <button className="ghost" type="button" onClick={runOtcPreflight} disabled={isRunningOtcPreflight}>
                  {isRunningOtcPreflight ? "Checking..." : "Run safety pre-check"}
                </button>
              </div>
              <div className="queue">
                {otcCatalog.map((entry) => (
                  <article key={entry.inventoryId || entry.productId} className="queue-card">
                    <div>
                      <div className="queue-title">
                        {entry.name} | {entry.strength || "n/a"} | {entry.dosageForm || "form n/a"}
                      </div>
                      <div className="queue-meta">
                        {entry.sku} | {entry.category || "general"} | Stock: {Number(entry.onHand || 0)} | Max/order:{" "}
                        {Number(entry.maxPerOrder || 1)}
                      </div>
                      <div className="queue-meta">
                        Pharmacy: {entry.pharmacyName || entry.pharmacyId || "n/a"} | Price:{" "}
                        {currencyFormat("JMD", entry.unitPrice || 0)}
                      </div>
                    </div>
                    <div className="form-row">
                      <input
                        type="number"
                        min="0"
                        max={Number(entry.maxPerOrder || 1)}
                        value={Number(otcCartByProductId[entry.productId] || 0)}
                        onChange={(e) => setOtcCartQty(entry.productId, e.target.value)}
                      />
                    </div>
                  </article>
                ))}
                {!otcCatalog.length ? <div className="meta">No OTC items loaded for this filter.</div> : null}
              </div>
              <div className="notice">
                OTC cart items: {otcCartItems.length} | Subtotal: {currencyFormat("JMD", otcCartSubtotal)}
              </div>
              {otcPreflight.state === "blocked" ? (
                <div className="notice error">
                  <strong>Checkout blocked</strong>
                  <br />
                  {(otcPreflight.blockers || []).map((entry, index) => (
                    <span key={`otc-block-${index}`}>
                      {index + 1}. {entry}
                      <br />
                    </span>
                  ))}
                </div>
              ) : null}
              {otcPreflight.state === "warning" ? (
                <div className="notice">
                  <strong>Warning only</strong>
                  <br />
                  {(otcPreflight.warnings || []).map((entry, index) => (
                    <span key={`otc-warn-${index}`}>
                      {index + 1}. {entry}
                      <br />
                    </span>
                  ))}
                </div>
              ) : null}
              {otcPreflight.state === "ready" ? (
                <div className="meta">Safety pre-check: ready to proceed.</div>
              ) : null}
              <div className="form">
                <label>
                  OTC payment method
                  <select value={otcPaymentMethod} onChange={(e) => setOtcPaymentMethod(e.target.value)}>
                    <option value="card">Card (authorize)</option>
                    <option value="nhf_credit">NHF credit</option>
                    <option value="rx_card">Refillit RX card</option>
                    <option value="split">Split payment</option>
                  </select>
                </label>
                {otcPaymentMethod === "split" ? (
                  <div className="form-row">
                    <label>
                      NHF credit amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={otcSplit.nhfCredit}
                        onChange={(e) => setOtcSplit((current) => ({ ...current, nhfCredit: e.target.value }))}
                      />
                    </label>
                    <label>
                      RX card amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={otcSplit.rxCard}
                        onChange={(e) => setOtcSplit((current) => ({ ...current, rxCard: e.target.value }))}
                      />
                    </label>
                    <label>
                      Card amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={otcSplit.card}
                        onChange={(e) => setOtcSplit((current) => ({ ...current, card: e.target.value }))}
                      />
                    </label>
                  </div>
                ) : null}
                <div className="queue-meta">
                  Available RX card: {currencyFormat(walletSummary.currency, walletSummary.walletBalance)} | NHF credit:{" "}
                  {currencyFormat(walletSummary.currency, walletSummary.nhfCreditBalance)}
                </div>
                {otcWarnings.length ? (
                  <div className="notice error">
                    <strong>Interaction warnings</strong>
                    <br />
                    {otcWarnings.map((entry, index) => (
                      <span key={`${index}-${entry}`}>
                        {index + 1}. {entry}
                        <br />
                      </span>
                    ))}
                  </div>
                ) : null}
                {otcWarnings.length ? (
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={acknowledgeOtcWarnings}
                      onChange={(e) => setAcknowledgeOtcWarnings(Boolean(e.target.checked))}
                    />
                    I acknowledge interaction warnings and want to continue checkout
                  </label>
                ) : null}
                <button
                  className="primary"
                  type="button"
                  onClick={submitOtcOrder}
                  disabled={
                    isSubmittingOtcOrder
                    || isRunningOtcPreflight
                    || otcPreflight.state === "blocked"
                  }
                >
                  {isSubmittingOtcOrder ? "Processing..." : "Pay & submit OTC order"}
                </button>
              </div>
            </article>
            ) : null}

            <article className="patient-card patient-card--wide">
              <div className="doctor-card-header">
                <h3>My Deliveries</h3>
                <button className="ghost" type="button" onClick={loadPatientOrders}>
                  Refresh deliveries
                </button>
              </div>
              <div className="queue">
                {patientOrders.map((entry) => (
                  <article key={entry.id} className="queue-card">
                    <div>
                      <div className="queue-title">
                        {entry.id} | {entry.dispatchStatus || "none"} | {entry.orderStatus || "submitted"}
                      </div>
                      <div className="queue-meta">
                        Pharmacy: {entry.pharmacyName || entry.pharmacyId || "n/a"} | Courier:{" "}
                        {entry.courierName || entry.courierId || "unassigned"}
                      </div>
                      <div className="queue-meta">
                        ETA: {entry.dispatchEtaStart ? new Date(entry.dispatchEtaStart).toLocaleString() : "n/a"} -{" "}
                        {entry.dispatchEtaEnd ? new Date(entry.dispatchEtaEnd).toLocaleString() : "n/a"}
                      </div>
                      <div className="queue-meta">
                        Destination: {entry.destinationAddress || "Not provided yet"}
                      </div>
                      <div className="queue-meta">
                        Instructions: {entry.deliveryInstructions || "No special instructions"}
                      </div>
                      {entry.dispatchFailureReason ? (
                        <div className="queue-meta">Dispatch issue: {entry.dispatchFailureReason}</div>
                      ) : null}
                    </div>
                    <div className="form-row">
                      <button className="ghost" type="button" onClick={() => loadOrderTracking(entry.id)}>
                        Track
                      </button>
                    </div>
                  </article>
                ))}
                {!patientOrders.length ? <div className="meta">No delivery orders found yet.</div> : null}
              </div>
              {trackingData?.order ? (
                <div className="notice">
                  <strong>Tracking {trackingData.order.id}</strong>
                  <br />
                  Status: {trackingData.order.dispatchStatus || "none"} | Courier:{" "}
                  {trackingData.order?.courier?.fullName || trackingData.order.courierName || "unassigned"}
                  <br />
                  OTP status:{" "}
                  <span
                    className={`patient-priority-badge patient-priority-badge--${otpStatusTone(
                      trackingData.order.otpState
                    )}`}
                  >
                    {formatOtpStatusLabel(trackingData.order.otpState)}
                  </span>
                  <br />
                  <span className="meta">{formatOtpStatusHint(trackingData.order.otpState)}</span>
                  <br />
                  {trackingData.order.otpState?.status === "issued" && trackingData.order.otpState?.qrToken ? (
                    <div className="patient-otp-qr-block">
                      <strong>Show this QR to courier for secure handoff</strong>
                      <div className="meta">Courier scans and OTP is auto-verified without speaking the code.</div>
                      <LocalQrCode
                        value={trackingData.order.otpState.qrToken}
                        size={180}
                        className="patient-otp-qr-svg"
                        title="Delivery OTP QR"
                      />
                    </div>
                  ) : null}
                  {trackingData.order.otpState?.status === "issued" && trackingData.order.otpState?.fallbackCode ? (
                    <div className="patient-otp-fallback">
                      <strong>Fallback delivery code</strong>
                      <div className="meta">Use this only if QR scan is unavailable:</div>
                      {fallbackCodeVisible ? (
                        <div className="patient-otp-fallback__reveal">
                          <code>{trackingData.order.otpState.fallbackCode}</code>
                          <button
                            className="ghost"
                            type="button"
                            onClick={() => {
                              setFallbackCodeVisible(false);
                              setFallbackCodeRemainingSec(0);
                            }}
                          >
                            Hide now
                          </button>
                          <span className="meta">Auto-hide in {fallbackCodeRemainingSec}s</span>
                        </div>
                      ) : (
                        <button className="ghost" type="button" onClick={showFallbackCode}>
                          Show code ({FALLBACK_CODE_REVEAL_SECONDS}s)
                        </button>
                      )}
                    </div>
                  ) : null}
                  <br />
                  <div className="form">
                    <label>
                      Delivery instructions
                      <input
                        value={deliveryPreferenceForm.instructions}
                        onChange={(e) =>
                          setDeliveryPreferenceForm((current) => ({
                            ...current,
                            instructions: e.target.value,
                          }))
                        }
                        placeholder="Gate code, landmark, best handoff note"
                      />
                    </label>
                    <label>
                      Recipient name
                      <input
                        value={deliveryPreferenceForm.recipientName}
                        onChange={(e) =>
                          setDeliveryPreferenceForm((current) => ({
                            ...current,
                            recipientName: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Recipient phone
                      <input
                        value={deliveryPreferenceForm.recipientPhone}
                        onChange={(e) =>
                          setDeliveryPreferenceForm((current) => ({
                            ...current,
                            recipientPhone: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Delivery address
                      <input
                        value={deliveryPreferenceForm.addressLine}
                        onChange={(e) =>
                          setDeliveryPreferenceForm((current) => ({
                            ...current,
                            addressLine: e.target.value,
                          }))
                        }
                        placeholder="Street, community, landmark"
                      />
                    </label>
                    <div className="form-row">
                      <label>
                        City
                        <input
                          value={deliveryPreferenceForm.city}
                          onChange={(e) =>
                            setDeliveryPreferenceForm((current) => ({
                              ...current,
                              city: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Parish
                        <input
                          value={deliveryPreferenceForm.parish}
                          onChange={(e) =>
                            setDeliveryPreferenceForm((current) => ({
                              ...current,
                              parish: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Postal code
                        <input
                          value={deliveryPreferenceForm.postalCode}
                          onChange={(e) =>
                            setDeliveryPreferenceForm((current) => ({
                              ...current,
                              postalCode: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <label>
                        Lat
                        <input
                          value={deliveryPreferenceForm.lat}
                          onChange={(e) =>
                            setDeliveryPreferenceForm((current) => ({
                              ...current,
                              lat: e.target.value,
                            }))
                          }
                          placeholder="18.0179"
                        />
                      </label>
                      <label>
                        Lng
                        <input
                          value={deliveryPreferenceForm.lng}
                          onChange={(e) =>
                            setDeliveryPreferenceForm((current) => ({
                              ...current,
                              lng: e.target.value,
                            }))
                          }
                          placeholder="-76.8099"
                        />
                      </label>
                    </div>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={deliveryPreferenceForm.allowProxyReceive}
                        onChange={(e) =>
                          setDeliveryPreferenceForm((current) => ({
                            ...current,
                            allowProxyReceive: e.target.checked,
                          }))
                        }
                      />
                      Allow proxy/caregiver to receive
                    </label>
                    <div className="form-row">
                      <button className="ghost" type="button" onClick={saveDeliveryPreferences}>
                        Save delivery preferences
                      </button>
                    </div>
                  </div>
                  <div className="form-row">
                    <input
                      value={deliveryConfirmNote}
                      onChange={(e) => setDeliveryConfirmNote(e.target.value)}
                      placeholder="Optional delivery confirmation note"
                    />
                    <button className="primary" type="button" onClick={confirmDelivery}>
                      Confirm delivery received
                    </button>
                  </div>
                  <br />
                  Timeline:
                  <div className="queue">
                    {(trackingData.timeline || []).map((event) => (
                      <div key={event.id} className="queue-meta">
                        {new Date(event.at || Date.now()).toLocaleString()} | {event.type}
                      </div>
                    ))}
                    {!trackingData.timeline?.length ? <div className="queue-meta">No dispatch updates yet.</div> : null}
                  </div>
                </div>
              ) : null}
            </article>

            <article className="patient-card patient-card--wide">
              <h3>My Prescriptions</h3>
              <div className="form-row">
                <button
                  className="ghost"
                  onClick={loadPrescriptions}
                  disabled={isCaregiverSession && !hasCarePermission("canRequestRefills")}
                >
                  Refresh prescriptions
                </button>
              </div>
              <div className="queue">
                {prescriptions.map((entry) => (
                  <article key={entry.id} className="queue-card">
                    <div>
                      <div className="queue-title">{entry.id}</div>
                      <div className="queue-meta">
                        {(entry.meds || []).map((med) => `${med.name} ${med.strength}`).join(", ")}
                      </div>
                      <div className="queue-meta">
                        Doctor: {entry.doctorName || "N/A"} ({entry.doctorId || "N/A"})
                      </div>
                      <div className="queue-meta">
                        Link code: {maskLinkCode(entry.linkCode)}
                      </div>
                      {revealedPrescriptionId === entry.id ? (
                        <div className="patient-otp-fallback">
                          <div className="meta">Temporary reveal for manual linking:</div>
                          <div className="patient-otp-fallback__reveal">
                            <code>{entry.linkCode || "Not available"}</code>
                            <button
                              className="ghost"
                              type="button"
                              onClick={() => {
                                setRevealedPrescriptionId("");
                                setRevealedPrescriptionSeconds(0);
                              }}
                            >
                              Hide now
                            </button>
                            <span className="meta">Auto-hide in {revealedPrescriptionSeconds}s</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {entry.qrDataUrl ? (
                      <div className="qr-panel">
                        <img className="qr-image" src={entry.qrDataUrl} alt={`QR ${entry.id}`} />
                      </div>
                    ) : null}
                    <div className="form-row">
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => revealPrescriptionCode(entry.id)}
                      >
                        Reveal code
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => copyPrescriptionCode(entry)}
                      >
                        Copy code
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => {
                          setPrescId(entry.id);
                          setLinkCode(entry.linkCode || "");
                          scrollToSection("prescription");
                        }}
                      >
                        Use this prescription
                      </button>
                    </div>
                  </article>
                ))}
                {!prescriptions.length ? <div className="meta">No prescriptions linked yet.</div> : null}
              </div>
            </article>

            <article className="patient-card patient-card--wide">
              <div className="doctor-card-header">
                <h3>Smart Refill Assistant</h3>
                <button className="ghost" type="button" onClick={async () => {
                  await loadSmartRefillAssistant();
                  await loadWalletSummary();
                }}>
                  Refresh refill assistant
                </button>
              </div>
              <div className="queue-meta">
                Payment balances: RX card {currencyFormat(walletSummary.currency, walletSummary.walletBalance)} | NHF credit{" "}
                {currencyFormat(walletSummary.currency, walletSummary.nhfCreditBalance)}
              </div>
              <div className="queue">
                {smartRefillItems.map((item) => (
                  <article key={item.prescId} className="queue-card">
                    <div>
                      <div className="queue-title">
                        Prescription {item.prescId} | Doctor: {item.doctorName || item.doctorId || "N/A"}
                      </div>
                      <div className="queue-meta">
                        {(item.meds || [])
                          .map((med) => `${med.name || med.ndcCode || "Medication"} ${med.strength || ""}`.trim())
                          .join(", ")}
                      </div>
                      <div className="queue-meta">
                        Refill due in{" "}
                        <strong>{Number.isFinite(item.refillDueInDays) ? item.refillDueInDays : "n/a"} day(s)</strong>
                        {" | "}Remaining refills: {Number(item.remainingRefills || 0)}
                        {" | "}Expiry: {item.expiryDate || "N/A"}
                      </div>
                      {(item.alternatives || []).length ? (
                        <div className="queue-meta">
                          Alternatives:{" "}
                          {item.alternatives.map((alt) => (
                            <span key={alt.code} className={`patient-stock-badge patient-stock-badge--${alt.stockStatus || "in_stock"}`}>
                              {alt.name} ({alt.stockStatus || "in_stock"})
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="form-row">
                      <button
                        className="primary"
                        type="button"
                        disabled={!item.oneClickEligible || (isCaregiverSession && !hasCarePermission("canRequestRefills"))}
                        onClick={() => openRefillPaymentModal(item)}
                      >
                        {item.oneClickEligible ? "Pay & request refill" : "Not due yet"}
                      </button>
                    </div>
                  </article>
                ))}
                {!smartRefillItems.length ? (
                  <div className="meta">No refill recommendations yet.</div>
                ) : null}
              </div>
            </article>
          </div>
        </section>
        ) : null}

        {activeTab === "chat" && !isCaregiverSession ? (
        <section className="patient-section" ref={chatSectionRef}>
          <div className="patient-section-header">
            <div className="patient-section-title">
              <span className="section-icon">CHAT</span>
              <h3>Doctor Chat</h3>
            </div>
          </div>
          <div className="patient-grid">
            <article className="patient-card patient-card--wide">
              <div className="doctor-card-header">
                <h3>Messages</h3>
                <button className="primary" type="button" onClick={loadChatThreads}>
                  Refresh
                </button>
              </div>
              <div className="form-row">
                <button
                  className="primary"
                  type="button"
                  onClick={openDoctorChat}
                  disabled={!selectedDoctor || selectedDoctorEntry?.connectionStatus !== "approved"}
                >
                  Open chat with selected doctor
                </button>
              </div>
              <div className="queue">
                {chatThreads.map((thread) => (
                  <button
                    type="button"
                    key={thread.id}
                    className={`patient-record-card ${activeThreadId === thread.id ? "active" : ""}`}
                    onClick={() => setActiveThreadId(thread.id)}
                  >
                    <div className="patient-record-title">
                      {thread.counterpartName || thread.counterpartId || "Doctor"}
                    </div>
                  </button>
                ))}
              </div>
              <div className="chat-window">
                {threadMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`chat-bubble ${msg.senderId === user?.id ? "chat-patient" : "chat-office"}`}
                  >
                    <div>{msg.message}</div>
                    <div className="meta">{new Date(msg.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div className="form-row chat-form">
                <input value={chatDraft} onChange={(e) => setChatDraft(e.target.value)} placeholder="Type message..." />
                <button
                  className="primary"
                  type="button"
                  onClick={sendChatMessage}
                  disabled={!activeThreadId || !chatDraft.trim()}
                >
                  Send
                </button>
              </div>
            </article>
          </div>
        </section>
        ) : null}

        {activeTab === "care" ? (
        <section className="patient-section" ref={careSectionRef}>
          <div className="patient-section-header">
            <div className="patient-section-title">
              <span className="section-icon">CARE</span>
              <h3>My Care Tools</h3>
            </div>
          </div>
          <div className="patient-grid">
            {!isCaregiverSession ? (
            <article className="patient-card">
              <div className="doctor-card-header">
                <h3>Family/Caregiver Access</h3>
                <button className="ghost" type="button" onClick={loadCaregiverProxies}>
                  Refresh proxies
                </button>
              </div>
              <div className="form">
                <label>
                  Caregiver full name
                  <input
                    value={caregiverForm.fullName}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, fullName: e.target.value }))}
                    placeholder="e.g., Jane Doe"
                  />
                </label>
                <label>
                  Caregiver email
                  <input
                    type="email"
                    value={caregiverForm.email}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, email: e.target.value }))}
                    placeholder="caregiver@email.com"
                  />
                </label>
                <label>
                  Relationship
                  <select
                    value={caregiverForm.relationship}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, relationship: e.target.value }))}
                  >
                    <option value="caregiver">Caregiver</option>
                    <option value="parent">Parent</option>
                    <option value="spouse">Spouse/Partner</option>
                    <option value="adult_child">Adult child</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>
                  Government/Platform ID type
                  <select
                    value={caregiverForm.idType}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, idType: e.target.value }))}
                  >
                    <option value="national_id">National ID</option>
                    <option value="passport">Passport</option>
                    <option value="driver_license">Driver license</option>
                    <option value="employee_id">Employee ID</option>
                    <option value="company_registration">Company registration</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>
                  ID number
                  <input
                    value={caregiverForm.idNumber}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, idNumber: e.target.value }))}
                    placeholder="ID number used for verification"
                  />
                  {caregiverIdValidationError ? (
                    <div className="patient-inline-hint patient-inline-hint--error">
                      {caregiverIdValidationError}
                    </div>
                  ) : (
                    <div className="patient-inline-hint">ID format looks valid for selected ID type.</div>
                  )}
                </label>
                <label>
                  Company / Organization
                  <input
                    value={caregiverForm.organizationName}
                    onChange={(e) =>
                      setCaregiverForm((current) => ({ ...current, organizationName: e.target.value }))
                    }
                    placeholder="Clinic, NGO, home-care service, etc."
                  />
                </label>
                <label>
                  Phone
                  <input
                    value={caregiverForm.phone}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, phone: e.target.value }))}
                    placeholder="+1 876..."
                  />
                </label>
                <label>
                  Notes
                  <input
                    value={caregiverForm.notes}
                    onChange={(e) => setCaregiverForm((current) => ({ ...current, notes: e.target.value }))}
                    placeholder="Special access notes"
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(caregiverForm.permissions?.canViewEmergencyCard)}
                    onChange={(e) =>
                      setCaregiverForm((current) => ({
                        ...current,
                        permissions: {
                          ...current.permissions,
                          canViewEmergencyCard: e.target.checked,
                        },
                      }))
                    }
                  />
                  Allow emergency card access
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(caregiverForm.permissions?.canRequestRefills)}
                    onChange={(e) =>
                      setCaregiverForm((current) => ({
                        ...current,
                        permissions: {
                          ...current.permissions,
                          canRequestRefills: e.target.checked,
                        },
                      }))
                    }
                  />
                  Allow refill requests
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={Boolean(caregiverForm.permissions?.canBookAppointments)}
                    onChange={(e) =>
                      setCaregiverForm((current) => ({
                        ...current,
                        permissions: {
                          ...current.permissions,
                          canBookAppointments: e.target.checked,
                        },
                      }))
                    }
                  />
                  Allow appointment booking
                </label>
                <button
                  className="primary"
                  type="button"
                  onClick={addCaregiverProxy}
                  disabled={Boolean(caregiverIdValidationError)}
                >
                  Add caregiver proxy
                </button>
              </div>
              {lastCaregiverCredentials ? (
                <div className="notice">
                  Proxy credentials issued: {lastCaregiverCredentials.email}
                  <br />
                  Temporary password: {lastCaregiverCredentials.temporaryPassword}
                </div>
              ) : null}
              <div className="queue">
                {caregiverProxies.map((proxy) => (
                  <article key={proxy.id} className="queue-card">
                    <div>
                      <div className="queue-title">{proxy.fullName || proxy.email}</div>
                      <div className="queue-meta">
                        {proxy.relationship || "caregiver"} | {proxy.email || "No email"} | {proxy.phone || "No phone"}
                      </div>
                      <div className="queue-meta">
                        ID: {proxy.idType || "N/A"} {proxy.idNumberMasked ? `| ${proxy.idNumberMasked}` : ""}
                        {proxy.organizationName ? ` | Org: ${proxy.organizationName}` : ""}
                      </div>
                      <div className="queue-meta">
                        Verification:{" "}
                        <span
                          className={`verification-badge verification-badge--${
                            String(proxy.verificationStatus || "pending").toLowerCase() === "verified"
                              ? "verified"
                              : String(proxy.verificationStatus || "pending").toLowerCase() === "declined"
                                ? "declined"
                                : "pending"
                          }`}
                        >
                          {String(proxy.verificationStatus || "pending").toLowerCase() === "verified"
                            ? "Verified"
                            : String(proxy.verificationStatus || "pending").toLowerCase() === "declined"
                              ? "Declined"
                              : "Pending"}
                        </span>
                      </div>
                      {proxy.verificationNote ? (
                        <div className="queue-meta">Verification note: {proxy.verificationNote}</div>
                      ) : null}
                      <div className="queue-meta">
                        Permissions: emergency card {proxy.permissions?.canViewEmergencyCard ? "Yes" : "No"},{" "}
                        refill requests {proxy.permissions?.canRequestRefills ? "Yes" : "No"},{" "}
                        appointments {proxy.permissions?.canBookAppointments ? "Yes" : "No"}
                      </div>
                    </div>
                    <div className="form-row">
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => toggleCaregiverProxy(proxy.id, !proxy.active)}
                      >
                        {proxy.active ? "Disable access" : "Enable access"}
                      </button>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => setCaregiverVerification(proxy.id, "verified")}
                        disabled={String(proxy.verificationStatus || "pending").toLowerCase() === "verified"}
                      >
                        Approve
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => setCaregiverVerification(proxy.id, "declined")}
                        disabled={String(proxy.verificationStatus || "pending").toLowerCase() === "declined"}
                      >
                        Decline
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => setCaregiverVerification(proxy.id, "pending")}
                        disabled={String(proxy.verificationStatus || "pending").toLowerCase() === "pending"}
                      >
                        Set pending
                      </button>
                    </div>
                  </article>
                ))}
                {!caregiverProxies.length ? <div className="meta">No caregiver proxies added yet.</div> : null}
              </div>
            </article>
            ) : null}

            <article className="patient-card">
              <div className="doctor-card-header">
                <h3>Emergency Card</h3>
                <button className="ghost" type="button" onClick={loadEmergencyCard}>
                  One-tap refresh
                </button>
              </div>
              <div className="notice">
                <strong>{emergencyCard?.patient?.fullName || user?.fullName || "Patient"}</strong>
                <br />
                Allergies: {(emergencyCard?.allergies || []).join(", ") || "None recorded"}
                <br />
                Conditions: {(emergencyCard?.conditions || []).join(", ") || "None recorded"}
                <br />
                Emergency contact: {emergencyCard?.patient?.emergencyContactName || "N/A"}{" "}
                {emergencyCard?.patient?.emergencyContactPhone ? `(${emergencyCard.patient.emergencyContactPhone})` : ""}
                <br />
                NHF: {emergencyCard?.insurance?.nhfNumber || "Not provided"} | Insurance:{" "}
                {emergencyCard?.insurance?.provider || "Not provided"}
                <br />
                Doctor contacts:{" "}
                {(emergencyCard?.doctorContacts || [])
                  .map((doctor) => `${doctor.fullName || doctor.doctorId}${doctor.email ? ` (${doctor.email})` : ""}`)
                  .join(", ") || "No approved doctors"}
              </div>
              <div className="form">
                <label>
                  Allergies (comma separated)
                  <input
                    value={emergencyForm.allergies}
                    onChange={(e) => setEmergencyForm((current) => ({ ...current, allergies: e.target.value }))}
                  />
                </label>
                <label>
                  Conditions (comma separated)
                  <input
                    value={emergencyForm.conditions}
                    onChange={(e) => setEmergencyForm((current) => ({ ...current, conditions: e.target.value }))}
                  />
                </label>
                <label>
                  Emergency contact name
                  <input
                    value={emergencyForm.emergencyContactName}
                    onChange={(e) =>
                      setEmergencyForm((current) => ({ ...current, emergencyContactName: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Emergency contact phone
                  <input
                    value={emergencyForm.emergencyContactPhone}
                    onChange={(e) =>
                      setEmergencyForm((current) => ({ ...current, emergencyContactPhone: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Insurance provider
                  <input
                    value={emergencyForm.insuranceProvider}
                    onChange={(e) =>
                      setEmergencyForm((current) => ({ ...current, insuranceProvider: e.target.value }))
                    }
                  />
                </label>
                <label>
                  Insurance policy #
                  <input
                    value={emergencyForm.insurancePolicyNumber}
                    onChange={(e) =>
                      setEmergencyForm((current) => ({ ...current, insurancePolicyNumber: e.target.value }))
                    }
                  />
                </label>
                <label>
                  NHF number
                  <input
                    value={emergencyForm.nhfNumber}
                    onChange={(e) => setEmergencyForm((current) => ({ ...current, nhfNumber: e.target.value }))}
                  />
                </label>
                <button className="primary" type="button" onClick={saveEmergencyCard}>
                  Save emergency card
                </button>
              </div>
            </article>

            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Medication Reminders</h3>
              <div className="form">
                <label>
                  Medication
                  <input
                    value={medicationReminderForm.title}
                    onChange={(e) => setMedicationReminderForm((current) => ({ ...current, title: e.target.value }))}
                    placeholder="e.g., Metformin"
                  />
                </label>
                <label>
                  Dosage
                  <input
                    value={medicationReminderForm.dosage}
                    onChange={(e) => setMedicationReminderForm((current) => ({ ...current, dosage: e.target.value }))}
                    placeholder="e.g., 500mg"
                  />
                </label>
                <label>
                  Time
                  <input
                    type="time"
                    value={medicationReminderForm.timeOfDay}
                    onChange={(e) => setMedicationReminderForm((current) => ({ ...current, timeOfDay: e.target.value }))}
                  />
                </label>
                <label>
                  Note
                  <input
                    value={medicationReminderForm.note}
                    onChange={(e) => setMedicationReminderForm((current) => ({ ...current, note: e.target.value }))}
                    placeholder="With food, after breakfast..."
                  />
                </label>
                <button className="primary" type="button" onClick={addMedicationReminder}>
                  Add reminder
                </button>
              </div>
              <div className="queue">
                {medicationReminders.map((item) => {
                  const priority = reminderPriority(item);
                  return (
                  <article key={item.id} className={`queue-card queue-card--${priority}`}>
                    <div>
                      <div className="queue-title">{item.title}</div>
                      <div className="queue-meta">
                        {item.dosage || "No dosage"} | {item.timeOfDay || "No time"} | {item.active ? "Active" : "Inactive"}
                      </div>
                      <div className="queue-meta">{item.note || "No note"}</div>
                      <div className="queue-meta">Last action: {item.lastAction || "none"}</div>
                      <div className="queue-meta">
                        <span className={`patient-priority-badge patient-priority-badge--${priority}`}>
                          {priority === "red" ? "Overdue" : priority === "amber" ? "Due Soon" : "On Track"}
                        </span>
                      </div>
                    </div>
                    <div className="form-row">
                      <button className="ghost" type="button" onClick={() => updateMedicationReminder(item.id, "taken")}>
                        Mark taken
                      </button>
                      <button className="ghost" type="button" onClick={() => updateMedicationReminder(item.id, item.active ? "inactive" : "active")}>
                        {item.active ? "Pause" : "Resume"}
                      </button>
                    </div>
                  </article>
                );})}
                {!medicationReminders.length ? <div className="meta">No reminders yet.</div> : null}
              </div>
            </article>
            ) : null}

            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Visit Prep Checklist</h3>
              <div className="form">
                <label>
                  Prep item
                  <input
                    value={visitPrepForm.text}
                    onChange={(e) => setVisitPrepForm((current) => ({ ...current, text: e.target.value }))}
                    placeholder="Question, symptom, or note to discuss"
                  />
                </label>
                <label>
                  Category
                  <select
                    value={visitPrepForm.category}
                    onChange={(e) => setVisitPrepForm((current) => ({ ...current, category: e.target.value }))}
                  >
                    <option value="question">Question</option>
                    <option value="symptom">Symptom</option>
                    <option value="history">History update</option>
                  </select>
                </label>
                {visitPrepForm.category === "symptom" ? (
                  <>
                    <label>
                      Symptom name
                      <input
                        value={visitPrepForm.symptomName}
                        onChange={(e) => setVisitPrepForm((current) => ({ ...current, symptomName: e.target.value }))}
                        placeholder="e.g., headache, chest pain, fever"
                      />
                      {!symptomFieldValidation.symptomNameValid ? (
                        <div className="patient-inline-hint patient-inline-hint--error">
                          Required: enter the symptom name.
                        </div>
                      ) : null}
                    </label>
                    <label>
                      Symptom severity
                      <select
                        value={visitPrepForm.symptomSeverity}
                        onChange={(e) =>
                          setVisitPrepForm((current) => ({ ...current, symptomSeverity: e.target.value }))
                        }
                      >
                        <option value="mild">Mild</option>
                        <option value="moderate">Moderate</option>
                        <option value="severe">Severe</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </label>
                    <label>
                      Symptom date
                      <input
                        type="date"
                        value={visitPrepForm.occurredDate}
                        onChange={(e) => setVisitPrepForm((current) => ({ ...current, occurredDate: e.target.value }))}
                      />
                      {!symptomFieldValidation.occurredDateValid ? (
                        <div className="patient-inline-hint patient-inline-hint--error">
                          Required: select when the symptom occurred.
                        </div>
                      ) : null}
                    </label>
                    <label>
                      Symptom time
                      <input
                        type="time"
                        value={visitPrepForm.occurredTime}
                        onChange={(e) => setVisitPrepForm((current) => ({ ...current, occurredTime: e.target.value }))}
                      />
                      {!symptomFieldValidation.occurredTimeValid ? (
                        <div className="patient-inline-hint patient-inline-hint--error">
                          Required: select symptom time.
                        </div>
                      ) : null}
                    </label>
                    <label>
                      Symptom explanation
                      <textarea
                        value={visitPrepForm.symptomExplanation}
                        onChange={(e) =>
                          setVisitPrepForm((current) => ({ ...current, symptomExplanation: e.target.value }))
                        }
                        placeholder="Describe how it started, pattern, triggers, and what makes it better or worse."
                      />
                      {!symptomFieldValidation.explanationValid ? (
                        <div className="patient-inline-hint patient-inline-hint--error">
                          Required: add a brief explanation (at least 8 characters).
                        </div>
                      ) : null}
                    </label>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={visitPrepForm.shareForVirtualNow}
                        onChange={(e) =>
                          setVisitPrepForm((current) => ({ ...current, shareForVirtualNow: e.target.checked }))
                        }
                      />
                      Share to selected approved doctor now for virtual diagnosis review
                    </label>
                  </>
                ) : null}
                <label>
                  Visit date
                  <input
                    type="date"
                    value={visitPrepForm.visitDate}
                    onChange={(e) => setVisitPrepForm((current) => ({ ...current, visitDate: e.target.value }))}
                  />
                </label>
                <button
                  className="primary"
                  type="button"
                  onClick={addVisitPrepItem}
                  disabled={isSymptomEntry && !symptomFieldValidation.isValid}
                >
                  Add checklist item
                </button>
                {isSymptomEntry && !symptomFieldValidation.isValid ? (
                  <div className="patient-inline-hint patient-inline-hint--error">
                    Symptom report is incomplete. Fill all required symptom fields to continue.
                  </div>
                ) : null}
              </div>
              <div className="queue">
                {visitPrepItems.map((item) => {
                  const priority = datedTaskPriority(item, "visitDate");
                  return (
                  <article key={item.id} className={`queue-card queue-card--${priority}`}>
                    <div>
                      <div className="queue-title">{item.text}</div>
                      <div className="queue-meta">
                        {item.category} | Visit: {item.visitDate || "n/a"} | {item.completed ? "Completed" : "Pending"}
                      </div>
                      {item.category === "symptom" ? (
                        <div className="queue-meta">
                          Symptom: {item.symptomName || item.text}
                          {item.symptomSeverity ? ` | severity: ${item.symptomSeverity}` : ""}
                          {item.occurredAt ? ` | occurred: ${new Date(item.occurredAt).toLocaleString()}` : ""}
                        </div>
                      ) : null}
                      {item.category === "symptom" && item.symptomExplanation ? (
                        <div className="queue-meta">Details: {item.symptomExplanation}</div>
                      ) : null}
                      {item.category === "symptom" ? (
                        <div className="queue-meta">
                          Doctor share:{" "}
                          {item.sharedWithDoctor
                            ? `Shared ${item.sharedAt ? new Date(item.sharedAt).toLocaleString() : ""} with ${
                              item.sharedDoctorName || "doctor"
                            }${item.reviewedByDoctorAt ? " | Reviewed by doctor" : " | Pending doctor review"}`
                            : "Not shared"}
                        </div>
                      ) : null}
                      <div className="queue-meta">
                        <span className={`patient-priority-badge patient-priority-badge--${priority}`}>
                          {priority === "red" ? "Overdue" : priority === "amber" ? "Due Soon" : "On Track"}
                        </span>
                      </div>
                    </div>
                    <button className="ghost" type="button" onClick={() => toggleVisitPrepItem(item.id)}>
                      {item.completed ? "Uncheck" : "Mark done"}
                    </button>
                    {item.category === "symptom" && !item.sharedWithDoctor ? (
                      <button className="ghost" type="button" onClick={() => shareVisitPrepWithDoctor(item.id)}>
                        Share with doctor
                      </button>
                    ) : null}
                  </article>
                );})}
                {!visitPrepItems.length ? <div className="meta">No prep checklist items yet.</div> : null}
              </div>
            </article>
            ) : null}

            {!isCaregiverSession ? (
            <article className="patient-card">
              <h3>Post-Visit Care Plan</h3>
              <div className="form">
                <label>
                  Task
                  <input
                    value={careTaskForm.text}
                    onChange={(e) => setCareTaskForm((current) => ({ ...current, text: e.target.value }))}
                    placeholder="e.g., Take BP daily for 7 days"
                  />
                </label>
                <label>
                  Due date
                  <input
                    type="date"
                    value={careTaskForm.dueDate}
                    onChange={(e) => setCareTaskForm((current) => ({ ...current, dueDate: e.target.value }))}
                  />
                </label>
                <button className="primary" type="button" onClick={addCareTask}>
                  Add care task
                </button>
              </div>
              <div className="queue">
                {careTasks.map((item) => {
                  const priority = datedTaskPriority(item, "dueDate");
                  return (
                  <article key={item.id} className={`queue-card queue-card--${priority}`}>
                    <div>
                      <div className="queue-title">{item.text}</div>
                      <div className="queue-meta">
                        Due: {item.dueDate || "n/a"} | {item.completed ? "Completed" : "Open"}
                      </div>
                      <div className="queue-meta">
                        <span className={`patient-priority-badge patient-priority-badge--${priority}`}>
                          {priority === "red" ? "Overdue" : priority === "amber" ? "Due Soon" : "On Track"}
                        </span>
                      </div>
                    </div>
                    <button className="ghost" type="button" onClick={() => toggleCareTask(item.id)}>
                      {item.completed ? "Reopen" : "Complete"}
                    </button>
                  </article>
                );})}
                {!careTasks.length ? <div className="meta">No care tasks yet.</div> : null}
              </div>
            </article>
            ) : null}
          </div>
        </section>
        ) : null}
      </div>
          {isRefillPaymentModalOpen && pendingRefillItem ? (
            <div className="modal-backdrop" role="presentation" onClick={closeRefillPaymentModal}>
              <article className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                <h3>Confirm Refill Payment</h3>
                <div className="queue-meta">
                  Prescription: {pendingRefillItem.prescId} | Doctor: {pendingRefillItem.doctorName || pendingRefillItem.doctorId || "N/A"}
                </div>
                <div className="queue-meta">
                  Refill: {currencyFormat(walletSummary.currency, getRefillAmounts(pendingRefillItem).refillAmount)} | Delivery:{" "}
                  {currencyFormat(walletSummary.currency, getRefillAmounts(pendingRefillItem).deliveryFee)}
                </div>
                <div className="queue-meta">
                  Total: <strong>{currencyFormat(walletSummary.currency, getRefillAmounts(pendingRefillItem).total)}</strong>
                </div>
                <label>
                  Payment method
                  <select value={refillPaymentMethod} onChange={(e) => setRefillPaymentMethod(e.target.value)}>
                    <option value="card">Card (authorize)</option>
                    <option value="nhf_credit">NHF credit</option>
                    <option value="rx_card">Refillit RX card</option>
                    <option value="split">Split payment</option>
                  </select>
                </label>
                {refillPaymentMethod === "split" ? (
                  <div className="form-row">
                    <label>
                      NHF credit amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={refillSplit.nhfCredit}
                        onChange={(e) => setRefillSplit((s) => ({ ...s, nhfCredit: e.target.value }))}
                      />
                    </label>
                    <label>
                      RX card amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={refillSplit.rxCard}
                        onChange={(e) => setRefillSplit((s) => ({ ...s, rxCard: e.target.value }))}
                      />
                    </label>
                    <label>
                      Card amount
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={refillSplit.card}
                        onChange={(e) => setRefillSplit((s) => ({ ...s, card: e.target.value }))}
                      />
                    </label>
                  </div>
                ) : null}
                <div className="queue-meta">
                  Available RX card: {currencyFormat(walletSummary.currency, walletSummary.walletBalance)} | NHF credit:{" "}
                  {currencyFormat(walletSummary.currency, walletSummary.nhfCreditBalance)}
                </div>
                <div className="form-row">
                  <button
                    className="primary"
                    type="button"
                    onClick={submitRefillPaymentAndRequest}
                    disabled={isSubmittingRefillPayment}
                  >
                    {isSubmittingRefillPayment ? "Processing..." : "Pay now & submit refill"}
                  </button>
                  <button className="ghost" type="button" onClick={closeRefillPaymentModal} disabled={isSubmittingRefillPayment}>
                    Cancel
                  </button>
                </div>
              </article>
            </div>
          ) : null}
          <GlobalFeedbackOverlay
            successMessage={status}
            errorMessage={error}
            onClose={() => {
              setStatus("");
              setError("");
            }}
          />
        </div>
      </div>
    </section>
  );
}

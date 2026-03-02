import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { apiFetch } from "../utils/api.js";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CLINICAL_CATEGORY_MAP = {
  asthma_exacerbation: "Respiratory",
  cardiac_chest_pain: "Cardiac",
  infectious_syndrome: "Infectious",
  gi_syndrome: "GI",
  neuro_syndrome: "Neurologic",
  msk_trauma_syndrome: "Trauma",
  preventive_visit_syndrome: "Preventive",
  respiratory_issue: "Respiratory",
  cardiac_issue: "Cardiac",
  infectious_issue: "Infectious",
  neurologic_issue: "Neurologic",
  gi_issue: "GI",
  msk_trauma_issue: "Trauma",
  preventive_issue: "Preventive",
};
const DOCTOR_MODULES = [
  { id: "dashboard", label: "Dashboard" },
  { id: "coordination", label: "Coordination" },
  { id: "soap", label: "Clinical Notes" },
  { id: "patient-comms", label: "Communication" },
  { id: "patients", label: "Patients" },
  { id: "prescriptions", label: "Prescriptions" },
  { id: "appointments", label: "Appointments" },
  { id: "chat", label: "Direct Chat" },
];
const PATIENT_CONTEXT_KEY = "doctor.currentPatientId";
const PATIENT_REQUIRED_MODULES = new Set([
  "coordination",
  "soap",
  "patient-comms",
  "prescriptions",
]);
const SOAP_STEP_ORDER = [
  { id: "subjective", label: "Subjective Intake" },
  { id: "objective", label: "Objective Generation" },
  { id: "assessment", label: "Assessment" },
  { id: "plan", label: "Plan" },
  { id: "coding", label: "Coding" },
  { id: "sign", label: "Sign + Lock" },
];

const toDateKey = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toDateTimeLocal = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const parseDateKey = (key) => {
  if (!key) return null;
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
};

const formatMonthTitle = (monthDate) =>
  monthDate.toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });

const toDateTimeInputValue = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return toDateTimeLocal(date);
};

export default function DoctorPortal() {
  const { module: routeModule } = useParams();
  const navigate = useNavigate();
  const { apiBase, token, user } = useAuth();
  const visitChargeInputRefs = useRef({});
  const clearingInvalidPatientRef = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [hasRestoredPatientContext, setHasRestoredPatientContext] = useState(false);
  const [record, setRecord] = useState(null);
  const [createdPatient, setCreatedPatient] = useState(null);
  const [requests, setRequests] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [nhfClaimDraft, setNhfClaimDraft] = useState({
    appointmentId: "",
    patientNhfId: "",
    baseAmount: 0,
    coveragePercent: 70,
    coverageCap: 0,
    deductible: 0,
    alreadyPaid: 0,
  });
  const [doctorQrContent, setDoctorQrContent] = useState("");
  const [doctorScanStatus, setDoctorScanStatus] = useState("");
  const [verifiedScannedPrescription, setVerifiedScannedPrescription] = useState(null);
  const [drugQuery, setDrugQuery] = useState("");
  const [drugResults, setDrugResults] = useState([]);
  const [selectedDrug, setSelectedDrug] = useState(null);
  const [diagnosisSuggestions, setDiagnosisSuggestions] = useState([]);
  const [diagnosisMappings, setDiagnosisMappings] = useState([]);
  const [selectedDiagnosisSuggestion, setSelectedDiagnosisSuggestion] = useState(null);
  const [availability, setAvailability] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [reminderDrafts, setReminderDrafts] = useState({});
  const [visitChargeDrafts, setVisitChargeDrafts] = useState({});
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const base = new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [selectedDateKey, setSelectedDateKey] = useState(() => toDateKey(new Date()));
  const [isDateModalOpen, setIsDateModalOpen] = useState(false);
  const [isChatModalOpen, setIsChatModalOpen] = useState(false);
  const [isSymptomReportModalOpen, setIsSymptomReportModalOpen] = useState(false);
  const [isPatientRecordModalOpen, setIsPatientRecordModalOpen] = useState(false);
  const [loadingPatientRecordId, setLoadingPatientRecordId] = useState("");
  const [loadingSymptomReportId, setLoadingSymptomReportId] = useState("");
  const [activeSymptomReport, setActiveSymptomReport] = useState(null);
  const [availabilityForm, setAvailabilityForm] = useState({
    startAt: "",
    endAt: "",
    mode: "in-person",
    location: "",
    maxBookings: 1,
    feeRequired: true,
    feeAmount: 0,
    feeCurrency: "JMD",
  });

  const [patientForm, setPatientForm] = useState({
    fullName: "",
    email: "",
    password: "",
    dob: "",
    phone: "",
    address: "",
    idNumber: "",
    trn: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    allergies: "",
    weightKg: "",
    weightLbs: "",
  });

  const [prescriptionForm, setPrescriptionForm] = useState({
    diagnosis: "",
    patientWeightKg: "",
    strength: "",
    qty: 30,
    allowedRefills: 2,
    expiryDate: "",
    controlledSubstanceJustification: "",
  });
  const [prescriptionTemplates, setPrescriptionTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [templateNotesDraft, setTemplateNotesDraft] = useState("");
  const [favoriteMeds, setFavoriteMeds] = useState([]);
  const [followUpPlan, setFollowUpPlan] = useState(null);
  const [pharmacies, setPharmacies] = useState([]);
  const [chatTargetType, setChatTargetType] = useState("patient");
  const [chatTargetPatientId, setChatTargetPatientId] = useState("");
  const [chatTargetPharmacyId, setChatTargetPharmacyId] = useState("");
  const [chatThreads, setChatThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState("");
  const [threadMessages, setThreadMessages] = useState([]);
  const [chatMessageDraft, setChatMessageDraft] = useState("");
  const [privateNotes, setPrivateNotes] = useState([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [notesPatientId, setNotesPatientId] = useState("");
  const [patientEditForm, setPatientEditForm] = useState({
    fullName: "",
    email: "",
    dob: "",
    phone: "",
    address: "",
    allergies: "",
    idNumber: "",
    trn: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
    weightKg: "",
    weightLbs: "",
  });
  const [safetyWarnings, setSafetyWarnings] = useState([]);
  const [taskInbox, setTaskInbox] = useState({
    counts: {
      pendingConnections: 0,
      pendingAppointments: 0,
      dueReminders: 0,
      todayAppointments: 0,
      completedToday: 0,
      pendingSymptomReports: 0,
    },
    items: [],
  });
  const [installmentProposals, setInstallmentProposals] = useState([]);
  const [decidingInstallmentIds, setDecidingInstallmentIds] = useState({});
  const [markingReceptionAlertIds, setMarkingReceptionAlertIds] = useState({});
  const [reviewingSymptomReportIds, setReviewingSymptomReportIds] = useState({});
  const [patientTimeline, setPatientTimeline] = useState([]);
  const [patientIndicators, setPatientIndicators] = useState({
    lastSeenAt: null,
    nextDueAt: null,
  });
  const [patientRiskFlags, setPatientRiskFlags] = useState([]);
  const [patientSymptomReports, setPatientSymptomReports] = useState([]);
  const [patientSymptomReportFilter, setPatientSymptomReportFilter] = useState("all");
  const [appointmentIntel, setAppointmentIntel] = useState({
    predictions: [],
    overbookSuggestions: [],
    waitlistCount: 0,
  });
  const [waitlistAutoFillResult, setWaitlistAutoFillResult] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [referralForm, setReferralForm] = useState({
    referralType: "specialist",
    targetName: "",
    reason: "",
    priority: "routine",
    targetSpecialty: "",
    targetContact: "",
    requestedByDate: "",
    clinicalQuestion: "",
    attachmentUrlsText: "",
  });
  const [referralStatusFilter, setReferralStatusFilter] = useState("");
  const [referralStatusNoteById, setReferralStatusNoteById] = useState({});
  const referralStats = useMemo(() => {
    const stats = { total: referrals.length, pending: 0, sent: 0, accepted: 0, scheduled: 0, completed: 0, cancelled: 0 };
    for (const entry of referrals) {
      const key = String(entry?.status || "").toLowerCase();
      if (stats[key] !== undefined) stats[key] += 1;
    }
    return stats;
  }, [referrals]);
  const [interventions, setInterventions] = useState([]);
  const [sharedNotes, setSharedNotes] = useState([]);
  const [sharedNoteDraft, setSharedNoteDraft] = useState("");
  const [soapNotes, setSoapNotes] = useState([]);
  const [soapDraft, setSoapDraft] = useState({
    subjective: "",
    objective: "",
    assessment: "",
    plan: "",
    diagnosisCodes: "",
    procedureCodes: "",
  });
  const [soapPreviewMode, setSoapPreviewMode] = useState("draft");
  const [selectedSignedSoapNoteId, setSelectedSignedSoapNoteId] = useState("");
  const [dictationText, setDictationText] = useState("");
  const [dictationInterimText, setDictationInterimText] = useState("");
  const [dictationLanguage, setDictationLanguage] = useState("en-US");
  const [isDictating, setIsDictating] = useState(false);
  const [assessmentDictationText, setAssessmentDictationText] = useState("");
  const [assessmentInterimText, setAssessmentInterimText] = useState("");
  const [isAssessmentDictating, setIsAssessmentDictating] = useState(false);
  const [planDictationText, setPlanDictationText] = useState("");
  const [planInterimText, setPlanInterimText] = useState("");
  const [isPlanDictating, setIsPlanDictating] = useState(false);
  const [codingSearch, setCodingSearch] = useState("");
  const [icd10Items, setIcd10Items] = useState([]);
  const [cptItems, setCptItems] = useState([]);
  const [icdCodeSuggestions, setIcdCodeSuggestions] = useState([]);
  const [cptCodeSuggestions, setCptCodeSuggestions] = useState([]);
  const [isSigningSoap, setIsSigningSoap] = useState(false);
  const [soapActionStatus, setSoapActionStatus] = useState("");
  const [objectiveAssistMeta, setObjectiveAssistMeta] = useState(null);
  const [assessmentAssistMeta, setAssessmentAssistMeta] = useState(null);
  const [planAssistMeta, setPlanAssistMeta] = useState(null);
  const [activeSoapStep, setActiveSoapStep] = useState("subjective");
  const [instructionTemplates, setInstructionTemplates] = useState([]);
  const [broadcastForm, setBroadcastForm] = useState({
    cohort: "all",
    language: "en",
    text: "",
  });
  const [broadcasts, setBroadcasts] = useState([]);
  const [consents, setConsents] = useState([]);
  const [consentForm, setConsentForm] = useState({
    consentType: "",
    expiresAt: "",
    notes: "",
  });
  const [receptionists, setReceptionists] = useState([]);
  const [receptionistSearchQuery, setReceptionistSearchQuery] = useState("");
  const [receptionAccess, setReceptionAccess] = useState([]);
  const [createdReceptionist, setCreatedReceptionist] = useState(null);
  const [isEnrollingReceptionist, setIsEnrollingReceptionist] = useState(false);
  const [enrollReceptionistInlineMessage, setEnrollReceptionistInlineMessage] = useState({
    type: "",
    text: "",
  });
  const [isAssigningReceptionistOwner, setIsAssigningReceptionistOwner] = useState(false);
  const [assignReceptionistInlineMessage, setAssignReceptionistInlineMessage] = useState({
    type: "",
    text: "",
  });
  const [receptionistForm, setReceptionistForm] = useState({
    fullName: "",
    email: "",
    password: "",
  });
  const [receptionGrantDraft, setReceptionGrantDraft] = useState({
    receptionistId: "",
    canViewDemographics: true,
    canViewAppointments: true,
    canViewPrivateNotes: false,
    canViewPrescriptions: false,
  });
  const [dailyAgenda, setDailyAgenda] = useState([]);
  const [agendaDate, setAgendaDate] = useState(() => toDateKey(new Date()));
  const [kpi, setKpi] = useState(null);
  const [refillRequests, setRefillRequests] = useState([]);
  const [patientAudit, setPatientAudit] = useState([]);
  const scannerRef = useRef(null);
  const scannerControlsRef = useRef(null);
  const doctorScannerVideoRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const dictationTextRef = useRef("");
  const pendingAutoExtractRef = useRef(false);
  const assessmentSpeechRecognitionRef = useRef(null);
  const assessmentDictationTextRef = useRef("");
  const pendingAssessmentAssistRef = useRef(false);
  const planSpeechRecognitionRef = useRef(null);
  const planDictationTextRef = useRef("");
  const pendingPlanAssistRef = useRef(false);

  const sanitizePhoneForWhatsApp = (value) =>
    String(value || "").replace(/[^\d]/g, "");

  const openWhatsAppShare = () => {
    if (!result?.patientShare?.text) return;
    const phone = sanitizePhoneForWhatsApp(result?.patientShare?.contact);
    const qrPayloadText = result?.qrPayload ? `\nQR Payload:\n${JSON.stringify(result.qrPayload)}` : "";
    const message = `${result.patientShare.text}${qrPayloadText}`;
    const base = phone ? `https://wa.me/${phone}` : "https://wa.me/";
    const url = `${base}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const openEmailShare = () => {
    if (!result?.patientShare?.text) return;
    const to = encodeURIComponent(result?.patientShare?.contact || "");
    const subject = encodeURIComponent(`Refillit Prescription ${result?.prescription?.id || ""}`);
    const qrPayloadText = result?.qrPayload ? `\n\nQR Payload:\n${JSON.stringify(result.qrPayload)}` : "";
    const body = encodeURIComponent(`${result.patientShare.text}${qrPayloadText}`);
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  };

  const copyQrPayload = async () => {
    try {
      if (!result?.qrPayload) return;
      await navigator.clipboard.writeText(JSON.stringify(result.qrPayload));
      setStatus("QR payload copied to clipboard.");
    } catch (_err) {
      setError("Unable to copy QR payload. Please copy manually.");
    }
  };

  const stopDoctorScan = () => {
    if (scannerControlsRef.current) {
      scannerControlsRef.current.stop();
      scannerControlsRef.current = null;
    }
    setDoctorScanStatus("Scanner stopped");
  };

  const startDoctorScan = async () => {
    setError("");
    setDoctorScanStatus("Starting camera...");
    try {
      if (!scannerRef.current) {
        scannerRef.current = new BrowserMultiFormatReader();
      }
      const controls = await scannerRef.current.decodeFromVideoDevice(
        undefined,
        doctorScannerVideoRef.current,
        (scanResult, decodeError, localControls) => {
          scannerControlsRef.current = localControls;
          if (scanResult) {
            const raw = scanResult.getText();
            setDoctorQrContent(raw);
            setDoctorScanStatus("QR captured");
            localControls.stop();
            scannerControlsRef.current = null;
          } else if (decodeError) {
            setDoctorScanStatus("Scanning...");
          }
        }
      );
      scannerControlsRef.current = controls;
      setDoctorScanStatus("Scanning...");
    } catch (err) {
      setError(err.message);
      setDoctorScanStatus("");
    }
  };

  const verifyDoctorScannedPrescription = async () => {
    const payload = doctorQrContent.trim()
      ? { qrContent: doctorQrContent.trim() }
      : result?.prescription?.id
        ? { prescId: result.prescription.id }
        : null;
    if (!payload) {
      setError("Scan a QR code or create/select a prescription first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/verify-prescription",
        method: "POST",
        body: payload,
      });
      setVerifiedScannedPrescription(data.prescription || null);
      setStatus(`Prescription verified: ${data.prescription?.id || "unknown"}`);
      setError("");
    } catch (err) {
      if (err?.status === 404) {
        setError("Objective Assist endpoint not found. Restart backend and try again.");
      } else {
        setError(err.message);
      }
    }
  };

  const searchMohDrugs = async (query) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/moh/drugs?query=${encodeURIComponent(query)}`,
      });
      setDrugResults(data.drugs || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const searchDiagnosisCatalog = async (query) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/diagnosis-catalog/suggestions?query=${encodeURIComponent(query)}`,
      });
      setDiagnosisSuggestions(data.suggestions || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const applyDiagnosisMedicationMapping = (mapping) => {
    const medication = mapping?.medication || null;
    if (!medication?.name) return;
    pickDrug({
      code: medication.code || "",
      name: medication.name,
      strengths: Array.isArray(medication.strengths) ? medication.strengths : [],
      medicationType: medication.medicationType || "",
      usedFor: medication.usedFor || "",
      controlledSubstance: Boolean(medication.controlledSubstance),
    });
    const defaultStrength =
      medication.defaultStrength ||
      (Array.isArray(medication.strengths) && medication.strengths.length
        ? medication.strengths[0]
        : "");
    setPrescriptionForm((current) => ({
      ...current,
      strength: defaultStrength || current.strength,
    }));
  };

  const loadDiagnosisMappings = async ({
    diagnosisLabel = "",
    diagnosisCode = "",
    autoApply = true,
  } = {}) => {
    try {
      const params = new URLSearchParams();
      if (diagnosisLabel) params.set("diagnosis", diagnosisLabel);
      if (diagnosisCode) params.set("diagnosisCode", diagnosisCode);
      if (!params.toString()) return;
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/diagnosis-catalog/mappings?${params.toString()}`,
      });
      const mappings = data.mappings || [];
      setDiagnosisMappings(mappings);
      if (autoApply && mappings.length) {
        applyDiagnosisMedicationMapping(mappings[0]);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const onDrugInput = async (value) => {
    setDrugQuery(value);
    setSelectedDrug(null);
    setSafetyWarnings([]);
    setPrescriptionForm((s) => ({ ...s, strength: "" }));
    if (value.trim().length >= 1) {
      await searchMohDrugs(value);
    } else {
      setDrugResults([]);
    }
  };

  const onDiagnosisInput = async (value) => {
    setPrescriptionForm((current) => ({ ...current, diagnosis: value }));
    setSelectedDiagnosisSuggestion(null);
    setDiagnosisMappings([]);
    if (value.trim().length >= 2) {
      await searchDiagnosisCatalog(value);
    } else {
      setDiagnosisSuggestions([]);
    }
  };

  const pickDiagnosisSuggestion = async (suggestion) => {
    const label = suggestion?.diagnosisLabel || "";
    if (!label) return;
    setSelectedDiagnosisSuggestion(suggestion);
    setPrescriptionForm((current) => ({ ...current, diagnosis: label }));
    setDiagnosisSuggestions([]);
    await loadDiagnosisMappings({
      diagnosisLabel: label,
      diagnosisCode: suggestion?.diagnosisCode || "",
      autoApply: true,
    });
  };

  const pickDrug = (drug) => {
    setSelectedDrug(drug);
    setDrugQuery(drug.name);
    setDrugResults([]);
    setSafetyWarnings([]);
    setPrescriptionForm((s) => ({
      ...s,
      strength: drug.strengths?.[0] || "",
    }));
  };

  const searchPatients = async (query = searchQuery) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients?query=${encodeURIComponent(query)}`,
      });
      setPatients(data.patients || []);
      setStatus(`Loaded ${data.patients?.length || 0} patient(s)`);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    searchPatients("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hasRestoredPatientContext) return;
    const storedPatientId = window.sessionStorage.getItem(PATIENT_CONTEXT_KEY);
    setHasRestoredPatientContext(true);
    if (!storedPatientId) return;
    selectCurrentPatientById(storedPatientId).catch(() => {
      window.sessionStorage.removeItem(PATIENT_CONTEXT_KEY);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRestoredPatientContext]);

  const onPatientInput = async (value) => {
    setSearchQuery(value);
    setError("");
    await searchPatients(value);
  };

  const loadRecord = async (patient) => {
    setError("");
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patient.id}/record`,
      });
      setSelectedPatient(patient);
      setRecord(data);
      if (patient?.id) {
        window.sessionStorage.setItem(PATIENT_CONTEXT_KEY, patient.id);
      }
      await loadPatientTimeline(patient.id);
      await loadPatientSymptomReports(patient.id);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patient?.id,
          "Selected patient record is not accessible on server. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const openPatientRecordModal = async (patient) => {
    if (!patient?.id) return;
    setLoadingPatientRecordId(String(patient.id));
    await loadRecord(patient);
    setIsPatientRecordModalOpen(true);
    setLoadingPatientRecordId("");
  };

  const clearCurrentPatientContext = ({ silent = false } = {}) => {
    setSelectedPatient(null);
    setRecord(null);
    setPatientTimeline([]);
    setPatientSymptomReports([]);
    setPatientSymptomReportFilter("all");
    setPatientIndicators({ lastSeenAt: null, nextDueAt: null });
    setPatientRiskFlags([]);
    window.sessionStorage.removeItem(PATIENT_CONTEXT_KEY);
    if (!silent) setStatus("Current patient cleared.");
  };

  const recoverFromInvalidPatientContext = async (err, patientId, message) => {
    if (![403, 404].includes(Number(err?.status || 0))) return false;
    const targetId = String(patientId || "").trim();
    const selectedId = String(selectedPatient?.id || "").trim();
    if (!targetId || !selectedId || targetId !== selectedId) return false;
    if (clearingInvalidPatientRef.current) return true;
    clearingInvalidPatientRef.current = true;
    try {
      clearCurrentPatientContext({ silent: true });
      await searchPatients(searchQuery);
      setError(message || "Selected patient is no longer accessible. Please select a patient again.");
      return true;
    } finally {
      clearingInvalidPatientRef.current = false;
    }
  };

  const selectCurrentPatientById = async (patientId) => {
    const id = String(patientId || "").trim();
    if (!id) {
      clearCurrentPatientContext();
      return;
    }
    const patient = patients.find((entry) => entry.id === id) || {
      id,
      fullName: "Selected patient",
    };
    await loadRecord(patient);
  };

  const savePatientDetails = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient first.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${selectedPatient.id}`,
        method: "PUT",
        body: {
          ...patientEditForm,
          allergies: patientEditForm.allergies,
        },
      });
      await loadRecord(selectedPatient);
      await searchPatients(searchQuery);
      setStatus("Patient details updated.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const createPatient = async (event) => {
    event.preventDefault();
    setError("");
    setStatus("");
    setCreatedPatient(null);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/patients",
        method: "POST",
        body: patientForm,
      });
      setCreatedPatient(data);
      setStatus("Patient created and doctor connection auto-approved.");
      setPatientForm({
        fullName: "",
        email: "",
        password: "",
        dob: "",
        phone: "",
        address: "",
        idNumber: "",
        trn: "",
        emergencyContactName: "",
        emergencyContactPhone: "",
        allergies: "",
        weightKg: "",
        weightLbs: "",
      });
      setSearchQuery(data.patient.fullName || "");
      await searchPatients(data.patient.fullName || "");
    } catch (err) {
      setError(err.message);
    }
  };

  const submitPrescription = async ({ overrideSafety = false } = {}) => {
    setError("");
    setStatus("");
    if (!selectedPatient?.id) {
      setError("Select a patient from search results before creating a prescription.");
      return;
    }
    if (!selectedDrug) {
      setError("Select an MOH-approved medication from the list.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/prescription",
        method: "POST",
        body: {
          patientId: selectedPatient?.id || null,
          patientDob: record?.patient?.dob || "",
          patientWeightKg: prescriptionForm.patientWeightKg || null,
          patientContact: record?.patient?.phone || record?.patient?.email || "",
          diagnosis: prescriptionForm.diagnosis || null,
          diagnosisCode: selectedDiagnosisSuggestion?.diagnosisCode || null,
          meds: [
            {
              ndcCode: selectedDrug.code,
              name: selectedDrug.name,
              strength: prescriptionForm.strength,
              qty: Number(prescriptionForm.qty),
              medicationType: selectedDrug.medicationType,
              usedFor: selectedDrug.usedFor,
            },
          ],
          allowedRefills: Number(prescriptionForm.allowedRefills),
          expiryDate: prescriptionForm.expiryDate || null,
          allowSubstitution: false,
          controlledSubstance: Boolean(selectedDrug?.controlledSubstance),
          controlledSubstanceJustification: prescriptionForm.controlledSubstanceJustification || "",
          overrideSafety,
        },
      });
      setResult(data);
      setSafetyWarnings(data?.safety?.warnings || []);
      setFollowUpPlan(null);
      setStatus("Prescription created.");
      if (selectedPatient?.id) {
        await loadRecord(selectedPatient);
      }
      setError("");
    } catch (err) {
      if (err.status === 422 && Array.isArray(err.payload?.warnings)) {
        setSafetyWarnings(err.payload.warnings);
        setError(err.message);
        return;
      }
      if (err.status === 409 && Array.isArray(err.payload?.warnings)) {
        setSafetyWarnings(err.payload.warnings);
        setError(err.message);
        return;
      }
      if (err.status === 404) {
        clearCurrentPatientContext();
        await searchPatients(searchQuery);
        setError("Patient not found. Reloaded patient list, please select a patient again.");
        return;
      }
      setError(err.message);
    }
  };

  const createPrescription = async (event) => {
    event.preventDefault();
    await submitPrescription({ overrideSafety: false });
  };

  const loadPending = async () => {
    setError("");
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/connection-requests?status=pending",
      });
      setRequests(data.connections || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadAvailability = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/appointments/availability",
      });
      setAvailability(data.availability || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const createAvailability = async (event) => {
    event.preventDefault();
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/appointments/availability",
        method: "POST",
        body: availabilityForm,
      });
      setAvailabilityForm({
        startAt: "",
        endAt: "",
        mode: "in-person",
        location: "",
        maxBookings: 1,
        feeRequired: true,
        feeAmount: 0,
        feeCurrency: "JMD",
      });
      await loadAvailability();
      setStatus("Availability slot created.");
    } catch (err) {
      setError(err.message);
    }
  };

  const deactivateAvailability = async (id) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/availability/${id}/deactivate`,
        method: "POST",
      });
      await loadAvailability();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadBookings = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/appointments/bookings",
      });
      setBookings(data.bookings || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadTaskInbox = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/task-inbox",
      });
      setTaskInbox(data);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadInstallmentProposals = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/installment-proposals",
      });
      setInstallmentProposals(data.proposals || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const decideInstallmentProposal = async (proposalId, decision) => {
    if (!proposalId) return;
    setDecidingInstallmentIds((current) => ({ ...current, [proposalId]: decision }));
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/installment-proposals/${proposalId}/decision`,
        method: "POST",
        body: { decision },
      });
      await loadInstallmentProposals();
      setStatus(`Installment proposal ${decision}.`);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setDecidingInstallmentIds((current) => ({ ...current, [proposalId]: "" }));
    }
  };

  const loadPatientTimeline = async (patientId) => {
    if (!patientId) {
      setPatientTimeline([]);
      setPatientIndicators({ lastSeenAt: null, nextDueAt: null });
      setPatientRiskFlags([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/timeline`,
      });
      setPatientTimeline(data.timeline || []);
      setPatientIndicators(data.indicators || { lastSeenAt: null, nextDueAt: null });
      setPatientRiskFlags(data.riskFlags || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient timeline is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const loadPatientSymptomReports = async (patientId) => {
    if (!patientId) {
      setPatientSymptomReports([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/symptom-reports`,
      });
      setPatientSymptomReports(data.reports || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient symptom reports are no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const loadAppointmentIntelligence = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/appointments/intelligence",
      });
      setAppointmentIntel({
        predictions: data.predictions || [],
        overbookSuggestions: data.overbookSuggestions || [],
        waitlistCount: Number(data.waitlistCount || 0),
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const autoFillWaitlist = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/appointments/waitlist/auto-fill",
        method: "POST",
      });
      setWaitlistAutoFillResult(data);
      await loadBookings();
      await loadAppointmentIntelligence();
      setStatus(`Waitlist autofill completed: ${data.filledCount || 0} booking(s) created.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadReferrals = async (patientId = selectedPatient?.id || "") => {
    try {
      const query = [];
      if (patientId) query.push(`patientId=${encodeURIComponent(patientId)}`);
      if (referralStatusFilter) query.push(`status=${encodeURIComponent(referralStatusFilter)}`);
      const path = query.length ? `/api/doctor/referrals?${query.join("&")}` : "/api/doctor/referrals";
      const data = await apiFetch({ apiBase, token, path });
      setReferrals(data.referrals || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient referral context is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const createReferral = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient before creating referral.");
      return;
    }
    const targetName = String(referralForm.targetName || "").trim();
    const reason = String(referralForm.reason || "").trim();
    if (targetName.length < 3) {
      setError("Target name must be at least 3 characters.");
      return;
    }
    if (reason.length < 10) {
      setError("Referral reason must be at least 10 characters.");
      return;
    }
    try {
      const attachmentUrls = String(referralForm.attachmentUrlsText || "")
        .split(/[\n,]/g)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(0, 10);
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/referrals",
        method: "POST",
        body: {
          patientId: selectedPatient.id,
          referralType: referralForm.referralType,
          targetName,
          reason,
          priority: referralForm.priority,
          targetSpecialty: String(referralForm.targetSpecialty || "").trim(),
          targetContact: String(referralForm.targetContact || "").trim(),
          requestedByDate: referralForm.requestedByDate || "",
          clinicalQuestion: String(referralForm.clinicalQuestion || "").trim(),
          attachmentUrls,
        },
      });
      await loadReferrals(selectedPatient.id);
      setReferralForm({
        referralType: "specialist",
        targetName: "",
        reason: "",
        priority: "routine",
        targetSpecialty: "",
        targetContact: "",
        requestedByDate: "",
        clinicalQuestion: "",
        attachmentUrlsText: "",
      });
      setStatus("Referral created.");
    } catch (err) {
      setError(err.message);
    }
  };

  const updateReferralStatus = async (referralId, nextStatus) => {
    if (!referralId || !nextStatus) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/referrals/${encodeURIComponent(referralId)}/status`,
        method: "POST",
        body: {
          status: nextStatus,
          note: referralStatusNoteById[referralId] || "",
        },
      });
      await loadReferrals(selectedPatient?.id || "");
      setStatus(`Referral updated to ${nextStatus}.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadInterventions = async (patientId = selectedPatient?.id || "") => {
    try {
      const path = patientId
        ? `/api/doctor/pharmacy-interventions?patientId=${encodeURIComponent(patientId)}`
        : "/api/doctor/pharmacy-interventions";
      const data = await apiFetch({ apiBase, token, path });
      setInterventions(data.interventions || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient intervention context is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const decideIntervention = async (id, decision) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/pharmacy-interventions/${id}/decision`,
        method: "POST",
        body: { decision },
      });
      await loadInterventions(selectedPatient?.id || "");
      setStatus(`Intervention ${decision}.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSharedCareNotes = async (patientId = selectedPatient?.id || "") => {
    if (!patientId) {
      setSharedNotes([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/shared-care-notes?patientId=${encodeURIComponent(patientId)}`,
      });
      setSharedNotes(data.notes || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient shared care notes are no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const createSharedCareNote = async () => {
    if (!selectedPatient?.id || !sharedNoteDraft.trim()) {
      setError("Select patient and enter shared note text.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/shared-care-notes",
        method: "POST",
        body: {
          patientId: selectedPatient.id,
          text: sharedNoteDraft,
          visibilityRoles: ["doctor", "pharmacy", "receptionist"],
        },
      });
      setSharedNoteDraft("");
      await loadSharedCareNotes(selectedPatient.id);
      setStatus("Shared care note saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadSoapNotes = async (patientId = selectedPatient?.id || "") => {
    try {
      const path = patientId
        ? `/api/doctor/soap-notes?patientId=${encodeURIComponent(patientId)}`
        : "/api/doctor/soap-notes";
      const data = await apiFetch({ apiBase, token, path });
      const notes = data.notes || [];
      setSoapNotes(notes);

      if (!notes.length) {
        setSelectedSignedSoapNoteId("");
        if (soapPreviewMode === "signed") {
          setSoapPreviewMode("draft");
        }
        return;
      }

      const hasSelected = notes.some((note) => note.id === selectedSignedSoapNoteId);
      if (!hasSelected) {
        const firstSigned = notes.find((note) => Boolean(note.signedAt));
        setSelectedSignedSoapNoteId(firstSigned?.id || notes[0]?.id || "");
        if (soapPreviewMode === "signed" && !firstSigned) {
          setSoapPreviewMode("draft");
        }
      }
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient SOAP notes are no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const extractDictationToSoap = async (sourceText = dictationText) => {
    const inputText = String(sourceText || "").trim();
    if (!inputText) return;
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/soap-notes/extract",
        method: "POST",
        body: { text: inputText },
      });
      setSoapDraft((current) => ({
        ...current,
        subjective: data.extracted?.subjective || current.subjective,
        objective: data.extracted?.objective || current.objective,
        assessment: data.extracted?.assessment || current.assessment,
        plan: data.extracted?.plan || current.plan,
      }));
      setStatus("Dictation extracted into SOAP fields.");
    } catch (err) {
      setError(err.message);
    }
  };

  const runObjectiveAssist = async () => {
    if (!String(soapDraft.subjective || "").trim()) {
      setError("Enter Subjective notes first for Objective Assist.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/soap-notes/objective-assist",
        method: "POST",
        body: {
          subjective: soapDraft.subjective,
          diagnosis: prescriptionForm?.diagnosis || soapDraft.assessment || "",
        },
      });
      const assist = data?.objectiveAssist || {};
      setSoapDraft((current) => ({
        ...current,
        objective: assist.objectiveText || current.objective,
      }));
      setObjectiveAssistMeta({
        detectedKeywords: assist.detectedKeywords || [],
        recommendedVitals: assist.recommendedVitals || [],
        confirmedSymptoms: assist.confirmedSymptoms || [],
        deniedSymptoms: assist.deniedSymptoms || [],
        confidence: Number(assist.confidence || 0),
      });
      setStatus("AI Objective Assist generated a clinical objective draft. Review and edit before saving.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const runAssessmentAssist = async (assessmentSource = "") => {
    const subjective = String(soapDraft.subjective || "").trim();
    const objective = String(soapDraft.objective || "").trim();
    const dictatedAssessment = String(assessmentSource || assessmentDictationText || "").trim();
    if (!subjective && !objective) {
      setError("Enter Subjective or Objective notes first for Assessment Assist.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/soap-notes/assessment-assist",
        method: "POST",
        body: {
          subjective,
          objective,
          diagnosis: prescriptionForm?.diagnosis || "",
        },
      });
      const assist = data?.assessmentAssist || {};
      setSoapDraft((current) => ({
        ...current,
        assessment: [assist.assessmentText || "", dictatedAssessment]
          .filter(Boolean)
          .join(" ")
          .trim() || current.assessment,
      }));
      setAssessmentAssistMeta({
        matchedKeywords: assist.matchedKeywords || [],
        differentials: assist.differentials || [],
        safetyFlags: assist.safetyFlags || [],
        likelyDiagnoses: assist.likelyDiagnoses || [],
        detectedObjectiveIssues: assist.detectedObjectiveIssues || [],
        riskLevel: assist.riskLevel || "low",
        objectiveMeasures: assist.objectiveMeasures || {},
        confidence: Number(assist.confidence || 0),
      });
      setStatus("AI Assessment Assist generated a clinical assessment draft. Review and edit before saving.");
      setError("");
    } catch (err) {
      if (err?.status === 404) {
        setError("Assessment Assist endpoint not found. Restart backend and try again.");
      } else {
        setError(err.message);
      }
    }
  };

  const runPlanAssist = async (planSource = "") => {
    const subjective = String(soapDraft.subjective || "").trim();
    const objective = String(soapDraft.objective || "").trim();
    const assessment = String(soapDraft.assessment || "").trim();
    const dictatedPlan = String(planSource || planDictationText || "").trim();
    if (!assessment && !objective && !subjective) {
      setError("Enter assessment/objective/subjective first for Plan Assist.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/soap-notes/plan-assist",
        method: "POST",
        body: {
          subjective,
          objective,
          assessment,
          diagnosis: prescriptionForm?.diagnosis || "",
        },
      });
      const assist = data?.planAssist || {};
      setSoapDraft((current) => ({
        ...current,
        plan: [assist.planText || "", dictatedPlan].filter(Boolean).join(" ").trim() || current.plan,
      }));
      setPlanAssistMeta({
        actions: assist.actions || [],
        followUp: assist.followUp || "",
        redFlags: assist.redFlags || [],
        riskLevel: assist.riskLevel || "low",
        escalationNotes: assist.escalationNotes || [],
        objectiveMeasures: assist.objectiveMeasures || {},
        confidence: Number(assist.confidence || 0),
      });
      setStatus("AI Plan Assist generated a treatment/follow-up plan. Review and edit before saving.");
      setError("");
    } catch (err) {
      if (err?.status === 404) {
        setError("Plan Assist endpoint not found. Restart backend and try again.");
      } else {
        setError(err.message);
      }
    }
  };

  const isSpeechRecognitionAvailable =
    typeof window !== "undefined" &&
    (typeof window.SpeechRecognition !== "undefined" ||
      typeof window.webkitSpeechRecognition !== "undefined");

  const stopDictation = (autoExtract = false) => {
    pendingAutoExtractRef.current = Boolean(autoExtract);
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop();
      return;
    }
    if (autoExtract) {
      extractDictationToSoap(dictationTextRef.current);
    }
  };

  const startDictation = () => {
    if (isSoapPreviewLocked) return;
    if (!isSpeechRecognitionAvailable) {
      setError("Microphone dictation is not supported in this browser.");
      return;
    }
    try {
      const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionApi) {
        setError("Speech recognition API is unavailable.");
        return;
      }

      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop();
      }

      const baseText = String(dictationTextRef.current || "").trim();
      let finalizedText = "";

      const recognition = new SpeechRecognitionApi();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = dictationLanguage || "en-US";

      recognition.onstart = () => {
        setIsDictating(true);
        setDictationInterimText("");
        setStatus("Voice dictation started.");
        setError("");
      };

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const piece = event.results[i]?.[0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalizedText += `${piece} `;
          } else {
            interim += piece;
          }
        }
        const merged = [baseText, finalizedText.trim()].filter(Boolean).join(" ").trim();
        setDictationText(merged);
        dictationTextRef.current = merged;
        setDictationInterimText(interim.trim());
      };

      recognition.onerror = (event) => {
        setError(`Dictation error: ${event.error || "unknown error"}`);
      };

      recognition.onend = async () => {
        setIsDictating(false);
        setDictationInterimText("");
        speechRecognitionRef.current = null;
        if (pendingAutoExtractRef.current) {
          pendingAutoExtractRef.current = false;
          await extractDictationToSoap(dictationTextRef.current);
        }
      };

      speechRecognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      setIsDictating(false);
      setError(err?.message || "Unable to start microphone dictation.");
    }
  };

  const stopAssessmentDictation = (autoAssist = false) => {
    pendingAssessmentAssistRef.current = Boolean(autoAssist);
    if (assessmentSpeechRecognitionRef.current) {
      assessmentSpeechRecognitionRef.current.stop();
      return;
    }
    if (autoAssist) {
      runAssessmentAssist(assessmentDictationTextRef.current);
    }
  };

  const startAssessmentDictation = () => {
    if (isSoapPreviewLocked) return;
    if (!isSpeechRecognitionAvailable) {
      setError("Microphone dictation is not supported in this browser.");
      return;
    }
    try {
      const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionApi) {
        setError("Speech recognition API is unavailable.");
        return;
      }
      if (assessmentSpeechRecognitionRef.current) {
        assessmentSpeechRecognitionRef.current.stop();
      }

      const baseText = String(assessmentDictationTextRef.current || "").trim();
      let finalizedText = "";
      const recognition = new SpeechRecognitionApi();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = dictationLanguage || "en-US";

      recognition.onstart = () => {
        setIsAssessmentDictating(true);
        setAssessmentInterimText("");
        setStatus("Assessment dictation started.");
        setError("");
      };

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const piece = event.results[i]?.[0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalizedText += `${piece} `;
          } else {
            interim += piece;
          }
        }
        const merged = [baseText, finalizedText.trim()].filter(Boolean).join(" ").trim();
        setAssessmentDictationText(merged);
        assessmentDictationTextRef.current = merged;
        setAssessmentInterimText(interim.trim());
      };

      recognition.onerror = (event) => {
        setError(`Assessment dictation error: ${event.error || "unknown error"}`);
      };

      recognition.onend = async () => {
        setIsAssessmentDictating(false);
        setAssessmentInterimText("");
        assessmentSpeechRecognitionRef.current = null;
        if (pendingAssessmentAssistRef.current) {
          pendingAssessmentAssistRef.current = false;
          await runAssessmentAssist(assessmentDictationTextRef.current);
        }
      };

      assessmentSpeechRecognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      setIsAssessmentDictating(false);
      setError(err?.message || "Unable to start assessment dictation.");
    }
  };

  const stopPlanDictation = (autoAssist = false) => {
    pendingPlanAssistRef.current = Boolean(autoAssist);
    if (planSpeechRecognitionRef.current) {
      planSpeechRecognitionRef.current.stop();
      return;
    }
    if (autoAssist) {
      runPlanAssist(planDictationTextRef.current);
    }
  };

  const startPlanDictation = () => {
    if (isSoapPreviewLocked) return;
    if (!isSpeechRecognitionAvailable) {
      setError("Microphone dictation is not supported in this browser.");
      return;
    }
    try {
      const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionApi) {
        setError("Speech recognition API is unavailable.");
        return;
      }
      if (planSpeechRecognitionRef.current) {
        planSpeechRecognitionRef.current.stop();
      }

      const baseText = String(planDictationTextRef.current || "").trim();
      let finalizedText = "";
      const recognition = new SpeechRecognitionApi();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = dictationLanguage || "en-US";

      recognition.onstart = () => {
        setIsPlanDictating(true);
        setPlanInterimText("");
        setStatus("Plan dictation started.");
        setError("");
      };

      recognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const piece = event.results[i]?.[0]?.transcript || "";
          if (event.results[i].isFinal) {
            finalizedText += `${piece} `;
          } else {
            interim += piece;
          }
        }
        const merged = [baseText, finalizedText.trim()].filter(Boolean).join(" ").trim();
        setPlanDictationText(merged);
        planDictationTextRef.current = merged;
        setPlanInterimText(interim.trim());
      };

      recognition.onerror = (event) => {
        setError(`Plan dictation error: ${event.error || "unknown error"}`);
      };

      recognition.onend = async () => {
        setIsPlanDictating(false);
        setPlanInterimText("");
        planSpeechRecognitionRef.current = null;
        if (pendingPlanAssistRef.current) {
          pendingPlanAssistRef.current = false;
          await runPlanAssist(planDictationTextRef.current);
        }
      };

      planSpeechRecognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      setIsPlanDictating(false);
      setError(err?.message || "Unable to start plan dictation.");
    }
  };

  const saveSoapNote = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient first.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/soap-notes",
        method: "POST",
        body: {
          patientId: selectedPatient.id,
          subjective: soapDraft.subjective,
          objective: soapDraft.objective,
          assessment: soapDraft.assessment,
          plan: soapDraft.plan,
          diagnosisCodes: soapDraft.diagnosisCodes
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          procedureCodes: soapDraft.procedureCodes
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
      });
      await loadSoapNotes(selectedPatient.id);
      setStatus("SOAP note saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const signSoapNote = async (noteId) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/soap-notes/${noteId}/sign`,
        method: "POST",
        body: { signature: user?.fullName || "Doctor Signature" },
      });
      await loadSoapNotes(selectedPatient?.id || "");
      setSelectedSignedSoapNoteId(noteId);
      setSoapPreviewMode("signed");
      setStatus("SOAP note signed and locked.");
      setError("");
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const signLatestSoapNote = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient first.");
      setSoapActionStatus("Select a patient first.");
      return;
    }
    setIsSigningSoap(true);
    setError("");
    setSoapActionStatus("Signing SOAP note...");
    try {
      let noteToSign = latestUnsignedSoapNote;
      if (!noteToSign) {
        const hasDraftContent = [
          soapDraft.subjective,
          soapDraft.objective,
          soapDraft.assessment,
          soapDraft.plan,
          soapDraft.diagnosisCodes,
          soapDraft.procedureCodes,
        ].some((entry) => String(entry || "").trim());

        if (!hasDraftContent) {
          setError("No unsigned SOAP note found. Enter SOAP details and save first.");
          setSoapActionStatus("No unsigned note found. Add SOAP content first.");
          return;
        }

        const created = await apiFetch({
          apiBase,
          token,
          path: "/api/doctor/soap-notes",
          method: "POST",
          body: {
            patientId: selectedPatient.id,
            subjective: soapDraft.subjective,
            objective: soapDraft.objective,
            assessment: soapDraft.assessment,
            plan: soapDraft.plan,
            diagnosisCodes: soapDraft.diagnosisCodes
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
            procedureCodes: soapDraft.procedureCodes
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          },
        });
        noteToSign = created?.note || null;
        setStatus("SOAP note auto-saved. Signing now...");
        setSoapActionStatus("SOAP auto-saved. Finalizing signature...");
      }

      if (!noteToSign?.id) {
        setError("Unable to determine which SOAP note to sign.");
        setSoapActionStatus("Unable to determine note to sign.");
        return;
      }

      const signed = await signSoapNote(noteToSign.id);
      if (signed) {
        setSoapActionStatus("Signed and locked successfully.");
      }
    } catch (err) {
      setError(err.message);
      setSoapActionStatus(`Sign failed: ${err.message}`);
    } finally {
      setIsSigningSoap(false);
    }
  };

  const loadCodingAssist = async (query = codingSearch) => {
    try {
      const [icdData, cptData] = await Promise.all([
        apiFetch({
          apiBase,
          token,
          path: `/api/doctor/coding/icd10?query=${encodeURIComponent(query || "")}`,
        }),
        apiFetch({
          apiBase,
          token,
          path: `/api/doctor/coding/cpt?query=${encodeURIComponent(query || "")}`,
        }),
      ]);
      setIcd10Items(icdData.items || []);
      setCptItems(cptData.items || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const extractLastCodeToken = (value) => {
    const tokens = String(value || "").split(",");
    return String(tokens[tokens.length - 1] || "").trim();
  };

  const buildCodeFieldWithSelection = (currentValue, selectedCode) => {
    const source = String(currentValue || "");
    const endsWithComma = /,\s*$/.test(source);
    const tokens = source.split(",").map((entry) => entry.trim());
    const base = endsWithComma
      ? tokens.filter(Boolean)
      : tokens.slice(0, -1).filter(Boolean);
    if (!base.includes(selectedCode)) {
      base.push(selectedCode);
    }
    return `${base.join(", ")}${base.length ? ", " : ""}`;
  };

  const loadIcdCodeSuggestions = async (queryText) => {
    const query = String(queryText || "").trim();
    if (!query) {
      setIcdCodeSuggestions([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/coding/icd10?query=${encodeURIComponent(query)}`,
      });
      setIcdCodeSuggestions((data.items || []).slice(0, 8));
    } catch (_err) {
      setIcdCodeSuggestions([]);
    }
  };

  const loadCptCodeSuggestions = async (queryText) => {
    const query = String(queryText || "").trim();
    if (!query) {
      setCptCodeSuggestions([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/coding/cpt?query=${encodeURIComponent(query)}`,
      });
      setCptCodeSuggestions((data.items || []).slice(0, 8));
    } catch (_err) {
      setCptCodeSuggestions([]);
    }
  };

  const onDiagnosisCodesInput = async (value) => {
    setSoapDraft((s) => ({ ...s, diagnosisCodes: value }));
    const tokenQuery = extractLastCodeToken(value);
    await loadIcdCodeSuggestions(tokenQuery);
  };

  const onProcedureCodesInput = async (value) => {
    setSoapDraft((s) => ({ ...s, procedureCodes: value }));
    const tokenQuery = extractLastCodeToken(value);
    await loadCptCodeSuggestions(tokenQuery);
  };

  const selectDiagnosisCode = (code) => {
    setSoapDraft((s) => ({
      ...s,
      diagnosisCodes: buildCodeFieldWithSelection(s.diagnosisCodes, code),
    }));
    setIcdCodeSuggestions([]);
  };

  const selectProcedureCode = (code) => {
    setSoapDraft((s) => ({
      ...s,
      procedureCodes: buildCodeFieldWithSelection(s.procedureCodes, code),
    }));
    setCptCodeSuggestions([]);
  };

  const loadInstructionTemplates = async (language = broadcastForm.language) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/instruction-templates?language=${encodeURIComponent(language)}`,
      });
      setInstructionTemplates(data.templates || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadBroadcasts = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/instructions/broadcasts",
      });
      setBroadcasts(data.broadcasts || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const sendBroadcastInstruction = async () => {
    if (!broadcastForm.text.trim()) {
      setError("Enter instruction text.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/instructions/broadcast",
        method: "POST",
        body: {
          cohort: broadcastForm.cohort,
          language: broadcastForm.language,
          text: broadcastForm.text,
        },
      });
      setStatus(`Broadcast sent to ${data.sent || 0} patient(s).`);
      await loadBroadcasts();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadConsents = async (patientId = selectedPatient?.id || "") => {
    if (!patientId) {
      setConsents([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/consents`,
      });
      setConsents(data.consents || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient consent records are no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const createConsent = async () => {
    if (!selectedPatient?.id || !consentForm.consentType.trim()) {
      setError("Select patient and enter consent type.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${selectedPatient.id}/consents`,
        method: "POST",
        body: {
          consentType: consentForm.consentType,
          expiresAt: consentForm.expiresAt || null,
          notes: consentForm.notes || null,
        },
      });
      setConsentForm({ consentType: "", expiresAt: "", notes: "" });
      await loadConsents(selectedPatient.id);
      setStatus("Consent recorded.");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadReceptionists = async (
    patientId = selectedPatient?.id || "",
    queryValue = receptionistSearchQuery
  ) => {
    try {
      const params = new URLSearchParams();
      if (patientId) params.set("patientId", patientId);
      const receptionistQuery = String(queryValue || "").trim();
      if (receptionistQuery) params.set("query", receptionistQuery);
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/receptionists${query}`,
      });
      setReceptionists(data.receptionists || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient receptionist scope is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const enrollReceptionist = async (event) => {
    event.preventDefault();
    if (isEnrollingReceptionist) return;
    const fullName = String(receptionistForm.fullName || "").trim();
    const email = String(receptionistForm.email || "").trim();
    const password = String(receptionistForm.password || "").trim();
    setError("");
    setStatus("");
    setEnrollReceptionistInlineMessage({ type: "", text: "" });
    if (!fullName || !email) {
      setError("Receptionist full name and email are required.");
      setEnrollReceptionistInlineMessage({
        type: "error",
        text: "Receptionist full name and email are required.",
      });
      return;
    }
    const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailLooksValid) {
      setError("Enter a valid receptionist email address.");
      setEnrollReceptionistInlineMessage({
        type: "error",
        text: "Enter a valid receptionist email address.",
      });
      return;
    }
    setIsEnrollingReceptionist(true);
    setStatus("Enrolling receptionist...");
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/receptionists",
        method: "POST",
        body: {
          fullName,
          email,
          password: password || undefined,
        },
      });
      setCreatedReceptionist(data);
      setReceptionistForm({ fullName: "", email: "", password: "" });
      setStatus("Receptionist enrolled under your account.");
      setEnrollReceptionistInlineMessage({
        type: "success",
        text: `Enrolled ${data?.receptionist?.fullName || "receptionist"} (${data?.receptionist?.platformStaffId || "ID pending"}).`,
      });
      try {
        await loadReceptionists(selectedPatient?.id || "", receptionistSearchQuery);
      } catch (_refreshErr) {
        await loadReceptionists("", receptionistSearchQuery);
      }
      if (data?.receptionist?.id) {
        setReceptionGrantDraft((s) => ({
          ...s,
          receptionistId: data.receptionist.id,
        }));
      }
    } catch (err) {
      setError(err.message);
      setStatus("");
      setEnrollReceptionistInlineMessage({
        type: "error",
        text: err.message || "Unable to enroll receptionist.",
      });
    } finally {
      setIsEnrollingReceptionist(false);
    }
  };

  const loadReceptionAccess = async (patientId = selectedPatient?.id || "") => {
    if (!patientId) {
      setReceptionAccess([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/receptionist-access`,
      });
      setReceptionAccess(data.access || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient receptionist access is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const assignReceptionistOwner = async (receptionistId = receptionGrantDraft.receptionistId) => {
    const id = String(receptionistId || "").trim();
    if (!id) {
      setAssignReceptionistInlineMessage({ type: "error", text: "Select a receptionist first." });
      setError("Select a receptionist first.");
      return false;
    }
    if (isAssigningReceptionistOwner) return false;

    const selectedEntry = receptionists.find((entry) => entry.id === id) || null;
    if (selectedEntry?.ownedByCurrentDoctor) {
      setAssignReceptionistInlineMessage({
        type: "success",
        text: "Receptionist is already assigned to your account.",
      });
      return true;
    }

    setIsAssigningReceptionistOwner(true);
    setAssignReceptionistInlineMessage({ type: "", text: "" });
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/receptionists/${id}/assign-owner`,
        method: "POST",
        body: { forceTransfer: false },
      });
      await loadReceptionists(selectedPatient?.id || "", receptionistSearchQuery);
      setAssignReceptionistInlineMessage({
        type: "success",
        text: "Receptionist ownership assigned to your doctor account.",
      });
      setStatus("Receptionist ownership updated.");
      setError("");
      return true;
    } catch (err) {
      setAssignReceptionistInlineMessage({
        type: "error",
        text: err.message || "Unable to assign receptionist ownership.",
      });
      setError(err.message);
      return false;
    } finally {
      setIsAssigningReceptionistOwner(false);
    }
  };

  const saveReceptionAccess = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient before granting receptionist access.");
      return;
    }
    if (!receptionGrantDraft.receptionistId) {
      setError("Select a receptionist.");
      return;
    }
    try {
      const ownershipReady = await assignReceptionistOwner(receptionGrantDraft.receptionistId);
      if (!ownershipReady) return;
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${selectedPatient.id}/receptionist-access`,
        method: "POST",
        body: {
          receptionistId: receptionGrantDraft.receptionistId,
          canViewDemographics: receptionGrantDraft.canViewDemographics,
          canViewAppointments: receptionGrantDraft.canViewAppointments,
          canViewPrivateNotes: receptionGrantDraft.canViewPrivateNotes,
          canViewPrescriptions: receptionGrantDraft.canViewPrescriptions,
        },
      });
      setStatus("Receptionist access updated.");
      await loadReceptionAccess(selectedPatient.id);
      await loadReceptionists(selectedPatient.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const revokeReceptionAccess = async (receptionistId) => {
    if (!selectedPatient?.id || !receptionistId) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${selectedPatient.id}/receptionist-access/${receptionistId}`,
        method: "DELETE",
      });
      setStatus("Receptionist access revoked.");
      await loadReceptionAccess(selectedPatient.id);
      await loadReceptionists(selectedPatient.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPatientAudit = async (patientId = selectedPatient?.id || "") => {
    if (!patientId) {
      setPatientAudit([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/audit`,
      });
      setPatientAudit(data.audit || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient audit trail is no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const loadDailyAgenda = async (date = agendaDate) => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/daily-agenda?date=${encodeURIComponent(date)}`,
      });
      setDailyAgenda(data.agenda || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadKpi = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/kpi",
      });
      setKpi(data.kpi || null);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadRefillRequests = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/refill-requests",
      });
      setRefillRequests(data.requests || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const decideRefillRequest = async (requestId, decision) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/refill-requests/${requestId}/decision`,
        method: "POST",
        body: { decision },
      });
      await loadRefillRequests();
      setStatus(`Refill request ${decision}.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPrescriptionTemplates = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/prescription-templates",
      });
      setPrescriptionTemplates(data.templates || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadFavoriteMeds = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/favorite-meds",
      });
      setFavoriteMeds(data.favorites || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const applyTemplate = () => {
    const template = prescriptionTemplates.find((entry) => entry.id === selectedTemplateId);
    if (!template || !Array.isArray(template.meds) || !template.meds.length) {
      setError("Select a valid template with medication.");
      return;
    }
    const med = template.meds[0];
    pickDrug({
      code: med.ndcCode,
      name: med.name,
      strengths: [med.strength].filter(Boolean),
      medicationType: med.medicationType || "",
      usedFor: med.usedFor || "",
      controlledSubstance: Boolean(med.controlledSubstance),
    });
    setPrescriptionForm((current) => ({
      ...current,
      diagnosis: template.diagnosis || current.diagnosis,
      strength: med.strength || current.strength,
      qty: Number(med.qty || current.qty || 30),
      allowedRefills: Number(template.allowedRefills ?? current.allowedRefills ?? 0),
    }));
    setStatus(`Template applied: ${template.name}`);
    setError("");
  };

  const saveCurrentAsTemplate = async () => {
    if (!selectedDrug) {
      setError("Select a medication before saving template.");
      return;
    }
    const templateName = templateNameDraft.trim();
    if (!templateName) {
      setError("Enter template name.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/prescription-templates",
        method: "POST",
        body: {
          name: templateName,
          diagnosis: prescriptionForm.diagnosis || "General",
          meds: [
            {
              ndcCode: selectedDrug.code,
              name: selectedDrug.name,
              strength: prescriptionForm.strength,
              qty: Number(prescriptionForm.qty),
              medicationType: selectedDrug.medicationType,
              usedFor: selectedDrug.usedFor,
              controlledSubstance: Boolean(selectedDrug.controlledSubstance),
            },
          ],
          allowedRefills: Number(prescriptionForm.allowedRefills),
          notes: templateNotesDraft,
        },
      });
      await loadPrescriptionTemplates();
      setTemplateNameDraft("");
      setTemplateNotesDraft("");
      setStatus("Prescription template saved.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const saveCurrentAsFavorite = async () => {
    if (!selectedDrug || !prescriptionForm.strength) {
      setError("Select medication and strength first.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/favorite-meds",
        method: "POST",
        body: {
          med: {
            ndcCode: selectedDrug.code,
            name: selectedDrug.name,
            strength: prescriptionForm.strength,
            qty: Number(prescriptionForm.qty),
            allowedRefills: Number(prescriptionForm.allowedRefills),
          },
        },
      });
      await loadFavoriteMeds();
      setStatus("Medication saved to favorites.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const applyFavoriteMed = (favorite) => {
    pickDrug({
      code: favorite.ndcCode,
      name: favorite.name,
      strengths: [favorite.strength].filter(Boolean),
      medicationType: favorite.medicationType || "",
      usedFor: favorite.usedFor || "",
      controlledSubstance: Boolean(favorite.controlledSubstance),
    });
    setPrescriptionForm((current) => ({
      ...current,
      strength: favorite.strength || current.strength,
      qty: Number(favorite.qty || current.qty || 30),
      allowedRefills: Number(favorite.allowedRefills ?? current.allowedRefills ?? 0),
    }));
  };

  const generateFollowUpPlan = async () => {
    if (!selectedPatient?.id) {
      setError("Select a patient first.");
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/follow-up-plan/generate",
        method: "POST",
        body: {
          diagnosis: prescriptionForm.diagnosis || "General follow-up",
          patientName: selectedPatient.fullName,
          meds: selectedDrug
            ? [
                {
                  ndcCode: selectedDrug.code,
                  name: selectedDrug.name,
                  strength: prescriptionForm.strength,
                },
              ]
            : [],
          nextVisitDays: 14,
        },
      });
      setFollowUpPlan(data.plan || null);
      setStatus("Follow-up plan generated.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPharmacies = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/doctor/pharmacies",
      });
      setPharmacies(data.pharmacies || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const loadChatThreads = async () => {
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/chat/threads",
      });
      setChatThreads(data.threads || []);
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
      await loadChatThreads();
    } catch (err) {
      setError(err.message);
    }
  };

  const startOrOpenChat = async () => {
    const doctorId = user?.id;
    if (!doctorId) {
      setError("Doctor session not found. Please log in again.");
      return;
    }

    if (chatTargetType === "patient" && !(chatTargetPatientId || selectedPatient?.id)) {
      setError("Select a patient before opening chat.");
      return;
    }
    if (chatTargetType === "pharmacy" && !chatTargetPharmacyId) {
      setError("Select a pharmacy before opening chat.");
      return;
    }

    try {
      const body =
        chatTargetType === "patient"
          ? { doctorId, patientId: chatTargetPatientId || selectedPatient?.id }
          : { doctorId, pharmacyId: chatTargetPharmacyId };
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/chat/threads",
        method: "POST",
        body,
      });
      const threadId = data.thread?.id;
      if (threadId) {
        setActiveThreadId(threadId);
        await loadChatThreads();
        await loadThreadMessages(threadId);
        const counterpart =
          chatTargetType === "patient"
            ? patients.find((entry) => entry.id === (chatTargetPatientId || selectedPatient?.id))
                ?.fullName || "patient"
            : pharmacies.find((entry) => entry.id === chatTargetPharmacyId)?.fullName || "pharmacy";
        setStatus(`Chat opened with ${counterpart}.`);
        setError("");
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const sendChatMessage = async () => {
    const content = chatMessageDraft.trim();
    if (!activeThreadId || !content) return;
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/chat/threads/${activeThreadId}/messages`,
        method: "POST",
        body: { message: content },
      });
      setChatMessageDraft("");
      await loadThreadMessages(activeThreadId);
      await loadChatThreads();
    } catch (err) {
      setError(err.message);
    }
  };

  const loadPrivateNotes = async (patientId) => {
    if (!patientId) {
      setPrivateNotes([]);
      return;
    }
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${patientId}/private-notes`,
      });
      setPrivateNotes(data.notes || []);
    } catch (err) {
      if (
        await recoverFromInvalidPatientContext(
          err,
          patientId,
          "Selected patient private notes are no longer accessible. Please select a patient again."
        )
      ) {
        return;
      }
      setError(err.message);
    }
  };

  const savePrivateNote = async () => {
    const text = noteDraft.trim();
    const targetPatientId = notesPatientId || selectedPatient?.id || "";
    if (!targetPatientId || !text) {
      setError("Select a patient and enter note text.");
      return;
    }
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patients/${targetPatientId}/private-notes`,
        method: "POST",
        body: { text },
      });
      setNoteDraft("");
      await loadPrivateNotes(targetPatientId);
      setStatus("Private note saved.");
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  const decideBooking = async (id, decision) => {
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/bookings/${id}/decision`,
        method: "POST",
        body: { decision },
      });
      await loadBookings();
      await loadTaskInbox();
      await loadAppointmentIntelligence();
      setStatus(`Appointment ${decision}.`);
    } catch (err) {
      setError(err.message);
    }
  };

  const getVisitChargeDraft = (booking) => {
    const existing = visitChargeDrafts[booking.id] || {};
    return {
      consultationFee: Number(existing.consultationFee ?? booking.consultationFee ?? booking.feeAmount ?? 0),
      additionalCharges: Number(existing.additionalCharges ?? booking.additionalCharges ?? 0),
      nhfDeductionAmount: Number(existing.nhfDeductionAmount ?? booking.nhfDeductionAmount ?? 0),
      feeCurrency: String(existing.feeCurrency ?? booking.feeCurrency ?? "JMD"),
      chargeNotes: String(existing.chargeNotes ?? booking.chargeNotes ?? ""),
    };
  };

  const updateVisitChargeDraft = (bookingId, patch) => {
    setVisitChargeDrafts((current) => ({
      ...current,
      [bookingId]: {
        ...(current[bookingId] || {}),
        ...patch,
      },
    }));
  };

  const saveVisitCharge = async (booking, { completeAfterSave = false } = {}) => {
    const draft = getVisitChargeDraft(booking);
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/bookings/${booking.id}/visit-charge`,
        method: "POST",
        body: {
          consultationFee: Number(draft.consultationFee || 0),
          additionalCharges: Number(draft.additionalCharges || 0),
          nhfDeductionAmount: Number(draft.nhfDeductionAmount || 0),
          feeCurrency: draft.feeCurrency || "JMD",
          chargeNotes: draft.chargeNotes || null,
          markReadyForCollection: true,
        },
      });

      if (completeAfterSave && booking.status === "approved") {
        await apiFetch({
          apiBase,
          token,
          path: `/api/doctor/appointments/bookings/${booking.id}/decision`,
          method: "POST",
          body: { decision: "completed" },
        });
      }

      await loadBookings();
      await loadTaskInbox();
      await loadAppointmentIntelligence();
      setStatus(
        completeAfterSave
          ? "Visit completed and billing sent to receptionist."
          : "Visit charges saved and billing sent to receptionist."
      );
    } catch (err) {
      // Backward-compatible fallback for servers that do not yet expose visit-charge route.
      if (err?.status === 404) {
        try {
          await apiFetch({
            apiBase,
            token,
            path: `/api/doctor/appointments/bookings/${booking.id}/send-to-reception`,
            method: "POST",
            body: {
              handoffNote: draft.chargeNotes || null,
            },
          });
          if (completeAfterSave && booking.status === "approved") {
            await apiFetch({
              apiBase,
              token,
              path: `/api/doctor/appointments/bookings/${booking.id}/decision`,
              method: "POST",
              body: { decision: "completed" },
            });
          }
          await loadBookings();
          await loadTaskInbox();
          await loadAppointmentIntelligence();
          setStatus(
            "Billing handoff sent. Visit-charge endpoint unavailable on current backend, so charges were not persisted."
          );
          setError("");
          return;
        } catch (fallbackErr) {
          setError(fallbackErr.message);
          return;
        }
      }
      setError(err.message);
    }
  };

  const sendBookingToReception = async (booking) => {
    if (!booking?.id) return;
    const draft = getVisitChargeDraft(booking);
    try {
      // Persist billing draft first so receptionist queue receives full billing info.
      try {
        await apiFetch({
          apiBase,
          token,
          path: `/api/doctor/appointments/bookings/${booking.id}/visit-charge`,
          method: "POST",
          body: {
            consultationFee: Number(draft.consultationFee || 0),
            additionalCharges: Number(draft.additionalCharges || 0),
            nhfDeductionAmount: Number(draft.nhfDeductionAmount || 0),
            feeCurrency: draft.feeCurrency || "JMD",
            chargeNotes: draft.chargeNotes || null,
            markReadyForCollection: true,
          },
        });
      } catch (chargeErr) {
        // Older backend may not expose this route; still send handoff as fallback.
        if (chargeErr?.status !== 404) throw chargeErr;
      }

      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/bookings/${booking.id}/send-to-reception`,
        method: "POST",
        body: {
          handoffNote: draft.chargeNotes || null,
        },
      });
      await loadBookings();
      await loadTaskInbox();
      await loadAppointmentIntelligence();
      setStatus("Appointment billing sent to receptionist.");
    } catch (err) {
      setError(err.message);
    }
  };

  const focusVisitCharge = (bookingId) => {
    const target = visitChargeInputRefs.current[bookingId];
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus();
  };

  const getReminderDraft = (booking) => {
    const existing = reminderDrafts[booking.id] || {};
    return {
      channel: String(existing.channel ?? booking.reminder?.channel ?? "email"),
      default24h: existing.default24h ?? booking.reminder?.default24h !== false,
      customAlertAt: String(existing.customAlertAt ?? toDateTimeInputValue(booking.reminder?.customAlertAt)),
    };
  };

  const updateReminderDraft = (bookingId, patch) => {
    setReminderDrafts((current) => ({
      ...current,
      [bookingId]: {
        ...(current[bookingId] || {}),
        ...patch,
      },
    }));
  };

  const saveReminderConfig = async (booking) => {
    const draft = getReminderDraft(booking);
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/bookings/${booking.id}/reminder-config`,
        method: "POST",
        body: {
          channel: draft.channel,
          default24h: Boolean(draft.default24h),
          customAlertAt: draft.customAlertAt || null,
        },
      });
      await loadBookings();
      await loadTaskInbox();
      setStatus("Reminder schedule saved.");
    } catch (err) {
      setError(err.message);
    }
  };

  const sendReminderNow = async (booking) => {
    const draft = getReminderDraft(booking);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/bookings/${booking.id}/reminder-send`,
        method: "POST",
        body: {
          kind: "manual",
          channel: draft.channel,
        },
      });
      setStatus(
        `Reminder sent via ${data.reminder?.channel || draft.channel} to ${data.reminder?.contact || "patient"}.`
      );
      await loadBookings();
      await loadTaskInbox();
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    loadAvailability();
    loadBookings();
    loadPending();
    loadPharmacies();
    loadChatThreads();
    loadTaskInbox();
    loadPrescriptionTemplates();
    loadFavoriteMeds();
    loadAppointmentIntelligence();
    loadReferrals();
    loadInterventions();
    loadSoapNotes();
    loadCodingAssist("");
    loadInstructionTemplates("en");
    loadBroadcasts();
    loadReceptionists();
    loadDailyAgenda(agendaDate);
    loadKpi();
    loadRefillRequests();
    loadInstallmentProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadPending();
    }, 15000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      stopDoctorScan();
    },
    []
  );

  useEffect(() => {
    if (!activeThreadId) return;
    loadThreadMessages(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  useEffect(() => {
    if (!isChatModalOpen) return undefined;
    if (activeThreadId) {
      loadThreadMessages(activeThreadId);
    } else {
      loadChatThreads();
    }
    const intervalId = window.setInterval(() => {
      if (activeThreadId) {
        loadThreadMessages(activeThreadId);
        return;
      }
      loadChatThreads();
    }, 5000);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isChatModalOpen, activeThreadId]);

  useEffect(() => {
    if (selectedPatient?.id) {
      setChatTargetPatientId(selectedPatient.id);
      setNotesPatientId(selectedPatient.id);
      loadReferrals(selectedPatient.id);
      loadInterventions(selectedPatient.id);
      loadSharedCareNotes(selectedPatient.id);
      loadSoapNotes(selectedPatient.id);
      loadConsents(selectedPatient.id);
      loadReceptionists(selectedPatient.id);
      loadReceptionAccess(selectedPatient.id);
      loadPatientAudit(selectedPatient.id);
    } else {
      setReceptionAccess([]);
    }
    setReceptionGrantDraft({
      receptionistId: "",
      canViewDemographics: true,
      canViewAppointments: true,
      canViewPrivateNotes: false,
      canViewPrescriptions: false,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPatient?.id]);

  useEffect(() => {
    loadReferrals(selectedPatient?.id || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referralStatusFilter]);

  useEffect(() => {
    if (!record?.patient) return;
    setPatientEditForm({
      fullName: record.patient.fullName || "",
      email: record.patient.email || "",
      dob: record.patient.dob || "",
      phone: record.patient.phone || "",
      address: record.patient.address || "",
      allergies: Array.isArray(record.patient.allergies)
        ? record.patient.allergies.join(", ")
        : "",
      idNumber: record.patient.idNumber || "",
      trn: record.patient.trn || "",
      emergencyContactName: record.patient.emergencyContactName || "",
      emergencyContactPhone: record.patient.emergencyContactPhone || "",
      weightKg: record.patient.weightKg || "",
      weightLbs: record.patient.weightLbs || "",
    });
  }, [record]);

  useEffect(() => {
    if (!selectedPatient?.id || !record?.patient) return;
    const patientWeightKg = Number(record.patient.weightKg);
    const patientWeightLbs = Number(record.patient.weightLbs);
    const hasKg = Number.isFinite(patientWeightKg) && patientWeightKg > 0;
    const hasLbs = Number.isFinite(patientWeightLbs) && patientWeightLbs > 0;
    const derivedKg = hasKg
      ? patientWeightKg
      : hasLbs
        ? Number((patientWeightLbs / 2.2046226218).toFixed(2))
        : null;
    if (!derivedKg) return;
    setPrescriptionForm((current) => ({
      ...current,
      patientWeightKg: String(derivedKg),
    }));
  }, [selectedPatient?.id, record?.patient?.weightKg, record?.patient?.weightLbs]);

  useEffect(() => {
    setSoapPreviewMode("draft");
    setSelectedSignedSoapNoteId("");
  }, [selectedPatient?.id]);

  useEffect(() => {
    dictationTextRef.current = dictationText;
  }, [dictationText]);

  useEffect(() => {
    assessmentDictationTextRef.current = assessmentDictationText;
  }, [assessmentDictationText]);

  useEffect(() => {
    planDictationTextRef.current = planDictationText;
  }, [planDictationText]);

  useEffect(
    () => () => {
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop();
      }
      if (assessmentSpeechRecognitionRef.current) {
        assessmentSpeechRecognitionRef.current.stop();
      }
      if (planSpeechRecognitionRef.current) {
        planSpeechRecognitionRef.current.stop();
      }
    },
    []
  );

  useEffect(() => {
    if (notesPatientId) {
      loadPrivateNotes(notesPatientId);
    } else {
      setPrivateNotes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesPatientId]);

  const approve = async (id) => {
    await apiFetch({
      apiBase,
      token,
      path: `/api/doctor/connection-requests/${id}/approve`,
      method: "POST",
    });
    await loadPending();
    await searchPatients(searchQuery);
    await loadTaskInbox();
  };

  const selectCalendarDate = (key) => {
    setSelectedDateKey(key);
    const parsed = parseDateKey(key);
    if (!parsed) return;

    const { year, month, day } = parsed;
    setAvailabilityForm((current) => {
      const startDate = current.startAt ? new Date(current.startAt) : new Date(year, month - 1, day, 9, 0);
      const endDate = current.endAt ? new Date(current.endAt) : new Date(year, month - 1, day, 9, 30);

      startDate.setFullYear(year, month - 1, day);
      endDate.setFullYear(year, month - 1, day);

      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return current;
      }

      return {
        ...current,
        startAt: toDateTimeLocal(startDate),
        endAt: toDateTimeLocal(endDate),
      };
    });
  };

  const shiftCalendarMonth = (offset) => {
    setCalendarMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + offset, 1)
    );
  };

  const navigateCalendarByDays = (sourceKey, dayOffset) => {
    const parsed = parseDateKey(sourceKey || selectedDateKey);
    if (!parsed) return;
    const targetDate = new Date(parsed.year, parsed.month - 1, parsed.day + dayOffset);
    const targetKey = toDateKey(targetDate);
    setCalendarMonth(new Date(targetDate.getFullYear(), targetDate.getMonth(), 1));
    selectCalendarDate(targetKey);
  };

  const navigateCalendarWithinWeek = (sourceKey, toWeekEdge) => {
    const parsed = parseDateKey(sourceKey || selectedDateKey);
    if (!parsed) return;
    const date = new Date(parsed.year, parsed.month - 1, parsed.day);
    const weekday = date.getDay();
    const offset = toWeekEdge === "start" ? -weekday : 6 - weekday;
    navigateCalendarByDays(sourceKey, offset);
  };

  const openDateInformation = (key) => {
    selectCalendarDate(key);
    setIsDateModalOpen(true);
  };

  const getModuleBadgeCount = (moduleId) => {
    if (moduleId === "appointments") {
      return Number(taskInbox.counts?.pendingAppointments || 0);
    }
    return 0;
  };

  const openSymptomReportModal = async (item) => {
    const reportId = String(item?.reportId || "").trim();
    if (!reportId) {
      setError("Unable to open symptom report. Missing report id.");
      return;
    }
    setLoadingSymptomReportId(reportId);
    try {
      const data = await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patient-symptom-reports/${reportId}`,
      });
      setActiveSymptomReport({
        report: data.report || null,
        patient: data.patient || null,
      });
      setIsSymptomReportModalOpen(true);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingSymptomReportId("");
    }
  };

  const openPatientRecordFromSymptomReport = async () => {
    const patientId = String(activeSymptomReport?.patient?.id || "").trim();
    if (!patientId) {
      setError("Unable to open patient record. Missing patient id.");
      return;
    }
    await selectCurrentPatientById(patientId);
    navigate("/doctor/patients");
    setIsSymptomReportModalOpen(false);
    setStatus("Patient context loaded from symptom report.");
    setError("");
  };

  const startVirtualDiagnosisFromSymptomReport = async () => {
    const patientId = String(activeSymptomReport?.patient?.id || "").trim();
    if (!patientId) {
      setError("Unable to start virtual diagnosis. Missing patient id.");
      return;
    }
    setChatTargetType("patient");
    setChatTargetPatientId(patientId);
    await selectCurrentPatientById(patientId);
    await startOrOpenChat();
    setIsChatModalOpen(true);
  };

  const openTaskItem = async (item) => {
    if (!item) return;
    if (item.type === "appointment_pending" || item.type === "reminder_due") {
      const key = toDateKey(item.startAt || item.reminderDueAt || new Date().toISOString());
      await loadBookings();
      navigate("/doctor/appointments");
      if (key) {
        openDateInformation(key);
      }
      return;
    }
    if (item.type === "reception_alert") {
      const key = toDateKey(item.startAt || new Date().toISOString());
      await loadBookings();
      navigate("/doctor/appointments");
      if (key) {
        openDateInformation(key);
      }
      setStatus(
        `${item.alertType === "reception_handoff" ? "Reception handoff" : "Reception alert"}: ${
          item.alertMessage || "Receptionist update"
        }`
      );
      return;
    }
    if (item.type === "unsigned_soap_note") {
      navigate("/doctor/soap");
      return;
    }
    if (item.type === "pending_refill_request") {
      navigate("/doctor/coordination");
      return;
    }
    if (item.type === "symptom_report_shared") {
      await openSymptomReportModal(item);
    }
  };

  const markReceptionAlertRead = async (item) => {
    if (!item?.bookingId || !item?.alertId) {
      setError("Unable to mark alert as read. Missing alert details.");
      return;
    }
    setMarkingReceptionAlertIds((current) => ({ ...current, [item.alertId]: true }));
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/appointments/${item.bookingId}/reception-alerts/${item.alertId}/read`,
        method: "POST",
      });
      await loadTaskInbox();
      setStatus("Reception alert marked as read.");
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setMarkingReceptionAlertIds((current) => ({ ...current, [item.alertId]: false }));
    }
  };

  const markSymptomReportReviewed = async (item) => {
    if (!item?.reportId) {
      setError("Unable to review symptom report. Missing report id.");
      return;
    }
    setReviewingSymptomReportIds((current) => ({ ...current, [item.reportId]: true }));
    try {
      await apiFetch({
        apiBase,
        token,
        path: `/api/doctor/patient-symptom-reports/${item.reportId}/review`,
        method: "POST",
      });
      await loadTaskInbox();
      setStatus("Symptom report marked as reviewed.");
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewingSymptomReportIds((current) => ({ ...current, [item.reportId]: false }));
    }
  };

  const dayStats = useMemo(() => {
    const stats = new Map();

    const ensure = (key) => {
      if (!stats.has(key)) {
        stats.set(key, { available: 0, booked: 0, completed: 0, pending: 0, approved: 0 });
      }
      return stats.get(key);
    };

    (availability || []).forEach((slot) => {
      const key = toDateKey(slot.startAt);
      if (!key) return;
      const day = ensure(key);
      if (slot.isActive !== false) {
        day.available += 1;
      }
    });

    (bookings || []).forEach((booking) => {
      const key = toDateKey(booking.startAt);
      if (!key) return;
      const day = ensure(key);
      if (booking.status === "completed") {
        day.completed += 1;
      } else {
        day.booked += 1;
      }
      if (booking.status === "pending") {
        day.pending += 1;
      }
      if (booking.status === "approved") {
        day.approved += 1;
      }
    });

    return stats;
  }, [availability, bookings]);

  const calendarCells = useMemo(() => {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < firstWeekday; i += 1) {
      cells.push({ empty: true, key: `empty-${i}` });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = toDateKey(new Date(year, month, day));
      cells.push({
        empty: false,
        key,
        dayNumber: day,
        stats: dayStats.get(key) || { available: 0, booked: 0, completed: 0, pending: 0, approved: 0 },
      });
    }

    return cells;
  }, [calendarMonth, dayStats]);
  const todayDateKey = useMemo(() => toDateKey(new Date()), []);

  const selectedDayAvailability = useMemo(
    () => (availability || []).filter((slot) => toDateKey(slot.startAt) === selectedDateKey),
    [availability, selectedDateKey]
  );

  const selectedDayBookings = useMemo(
    () => (bookings || []).filter((booking) => toDateKey(booking.startAt) === selectedDateKey),
    [bookings, selectedDateKey]
  );

  const selectedDayStats = dayStats.get(selectedDateKey) || {
    available: 0,
    booked: 0,
    completed: 0,
    pending: 0,
    approved: 0,
  };

  const activeThread = chatThreads.find((thread) => thread.id === activeThreadId) || null;
  const signedSoapNotes = useMemo(
    () => (soapNotes || []).filter((note) => Boolean(note.signedAt)),
    [soapNotes]
  );
  const selectedSignedSoapNote = useMemo(
    () =>
      signedSoapNotes.find((note) => note.id === selectedSignedSoapNoteId) ||
      signedSoapNotes[0] ||
      null,
    [signedSoapNotes, selectedSignedSoapNoteId]
  );
  const demoSignedSoapNote = useMemo(
    () => ({
      id: "demo-signed-soap",
      subjective:
        "Patient reports intermittent chest tightness for 3 days, worse at night, with mild shortness of breath.",
      objective:
        "BP 128/82, HR 88, SpO2 97%, mild expiratory wheeze. No acute respiratory distress.",
      assessment: "Mild asthma exacerbation; stable for outpatient management.",
      plan:
        "Salbutamol inhaler PRN, trigger avoidance counseling, inhaler technique reinforcement, follow-up in 7 days.",
      diagnosisCodes: ["J45.901"],
      procedureCodes: ["99213"],
      signedAt: new Date().toISOString(),
      signedBy: user?.id || "DOC-11",
      signature: user?.fullName || "Doctor Signature",
    }),
    [user?.fullName, user?.id]
  );
  const signedPreviewNote = selectedSignedSoapNote || demoSignedSoapNote;
  const latestUnsignedSoapNote = useMemo(() => {
    const unsigned = (soapNotes || []).filter((note) => !note.signedAt);
    if (!unsigned.length) return null;
    return unsigned.reduce((latest, note) =>
      new Date(note.createdAt).getTime() > new Date(latest.createdAt).getTime() ? note : latest
    );
  }, [soapNotes]);
  const isSoapPreviewLocked = soapPreviewMode === "signed";
  const previewDiagnosisCodes = isSoapPreviewLocked
    ? (signedPreviewNote?.diagnosisCodes || []).join(", ")
    : soapDraft.diagnosisCodes;
  const previewProcedureCodes = isSoapPreviewLocked
    ? (signedPreviewNote?.procedureCodes || []).join(", ")
    : soapDraft.procedureCodes;
  const totalUnreadMessages = useMemo(
    () =>
      (chatThreads || []).reduce(
        (sum, thread) => sum + Number(thread.unreadCount || 0),
        0
      ),
    [chatThreads]
  );
  const objectiveSummaryPreview = useMemo(() => {
    const text = String(soapDraft.objective || "").trim();
    const firstSentence = text ? text.split(/(?<=[.!?])\s+/)[0] : "";
    return {
      confidencePct: Math.round(Number(objectiveAssistMeta?.confidence || 0) * 100),
      keywords: objectiveAssistMeta?.detectedKeywords || [],
      confirmed: objectiveAssistMeta?.confirmedSymptoms || [],
      denied: objectiveAssistMeta?.deniedSymptoms || [],
      vitals: objectiveAssistMeta?.recommendedVitals || [],
      headline:
        firstSentence ||
        "Run AI Objective Assist to generate a uniform clinical objective summary.",
    };
  }, [soapDraft.objective, objectiveAssistMeta]);
  const clinicalCategoryBadges = useMemo(() => {
    const categorySet = new Set();
    for (const entry of assessmentAssistMeta?.likelyDiagnoses || []) {
      const mapped = CLINICAL_CATEGORY_MAP[String(entry?.id || "").trim()];
      if (mapped) categorySet.add(mapped);
    }
    for (const entry of assessmentAssistMeta?.detectedObjectiveIssues || []) {
      const mapped = CLINICAL_CATEGORY_MAP[String(entry?.id || "").trim()];
      if (mapped) categorySet.add(mapped);
    }
    if (!categorySet.size && assessmentAssistMeta?.riskLevel) {
      categorySet.add("General");
    }
    return Array.from(categorySet).slice(0, 5);
  }, [assessmentAssistMeta]);
  const activeSoapStepIndex = Math.max(
    0,
    SOAP_STEP_ORDER.findIndex((entry) => entry.id === activeSoapStep)
  );
  const allowedModules = useMemo(() => DOCTOR_MODULES.map((entry) => entry.id), []);
  const activeModule = allowedModules.includes(routeModule) ? routeModule : "dashboard";
  const isPatientContextRequired = PATIENT_REQUIRED_MODULES.has(activeModule);
  const isPatientContextMissing = isPatientContextRequired && !selectedPatient?.id;

  useEffect(() => {
    if (!routeModule) {
      navigate("/doctor/dashboard", { replace: true });
      return;
    }
    if (!allowedModules.includes(routeModule)) {
      navigate("/doctor/dashboard", { replace: true });
    }
  }, [allowedModules, navigate, routeModule]);

  const submitNhfClaimFromDoctor = async () => {
    try {
      if (!nhfClaimDraft.appointmentId) {
        setError("Appointment ID is required for NHF claim submission.");
        return;
      }
      const data = await apiFetch({
        apiBase,
        token,
        path: "/api/nhf/claims/doctor-submit",
        method: "POST",
        body: {
          appointmentId: nhfClaimDraft.appointmentId,
          patientNhfId: nhfClaimDraft.patientNhfId || null,
          baseAmount: Number(nhfClaimDraft.baseAmount || 0),
          coveragePercent: Number(nhfClaimDraft.coveragePercent || 0),
          coverageCap: Number(nhfClaimDraft.coverageCap || 0),
          deductible: Number(nhfClaimDraft.deductible || 0),
          alreadyPaid: Number(nhfClaimDraft.alreadyPaid || 0),
        },
      });
      setStatus(
        `NHF claim submitted${data.idempotent ? " (already existed)" : ""}: ${data.claim.id} | Covered: JMD ${Number(
          data.claim.amountCovered || 0
        ).toFixed(2)}`
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="panel doctor-shell">
      <h2>Doctor Portal</h2>
      <div className="doctor-identity">
        <span className="doctor-identity__label">Doctor Identity</span>
        <div className="doctor-identity__value">
          {user?.fullName || "Doctor"} ({user?.id || "N/A"})
        </div>
      </div>

      <section className="form">
        <h3>NHF Claim Submission</h3>
        <div className="doctor-reminder-grid">
          <label>
            Appointment ID
            <input
              value={nhfClaimDraft.appointmentId}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({ ...current, appointmentId: e.target.value }))
              }
              placeholder="Required"
            />
          </label>
          <label>
            Patient NHF ID
            <input
              value={nhfClaimDraft.patientNhfId}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({ ...current, patientNhfId: e.target.value }))
              }
            />
          </label>
          <label>
            Base amount
            <input
              type="number"
              value={nhfClaimDraft.baseAmount}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({ ...current, baseAmount: Number(e.target.value || 0) }))
              }
            />
          </label>
          <label>
            Coverage %
            <input
              type="number"
              value={nhfClaimDraft.coveragePercent}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({
                  ...current,
                  coveragePercent: Number(e.target.value || 0),
                }))
              }
            />
          </label>
          <label>
            Coverage cap
            <input
              type="number"
              value={nhfClaimDraft.coverageCap}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({ ...current, coverageCap: Number(e.target.value || 0) }))
              }
            />
          </label>
          <label>
            Deductible
            <input
              type="number"
              value={nhfClaimDraft.deductible}
              onChange={(e) =>
                setNhfClaimDraft((current) => ({ ...current, deductible: Number(e.target.value || 0) }))
              }
            />
          </label>
        </div>
        <div className="form-row">
          <button className="primary" type="button" onClick={submitNhfClaimFromDoctor}>
            Submit doctor NHF claim
          </button>
        </div>
      </section>

      <div className="doctor-patient-context-bar">
        <div className="doctor-patient-context-meta">
          <span className="doctor-identity__label">Current Patient Context</span>
          <strong>
            {selectedPatient?.fullName || selectedPatient?.name || "No patient selected"}
          </strong>
          <span className="meta">
            {selectedPatient?.id ? `ID: ${selectedPatient.id}` : "Select a patient to unlock patient-bound workflows."}
          </span>
        </div>
        <div className="doctor-patient-context-actions">
          <label>
            Switch patient
            <select
              value={selectedPatient?.id || ""}
              onChange={(e) => selectCurrentPatientById(e.target.value)}
            >
              <option value="">No patient selected</option>
              {patients.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.fullName}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" type="button" onClick={() => navigate("/doctor/patients")}>
            Find patient
          </button>
          <button className="ghost" type="button" onClick={clearCurrentPatientContext}>
            Clear context
          </button>
        </div>
      </div>

      <div className="doctor-workspace">
        <aside className="doctor-sidebar">
          <div className="doctor-sidebar-title">Portal Sections</div>
          <nav className="doctor-sidebar-nav" aria-label="Doctor sections">
            {DOCTOR_MODULES.map((module) => (
              <NavLink
                key={module.id}
                className={({ isActive }) =>
                  `doctor-sidebar-link${isActive ? " active" : ""}${
                    PATIENT_REQUIRED_MODULES.has(module.id) ? " doctor-sidebar-link--needs-patient" : ""
                  }`
                }
                to={`/doctor/${module.id}`}
              >
                <span>{module.label}</span>
                {getModuleBadgeCount(module.id) > 0 ? (
                  <span className="doctor-module-badge">
                    {getModuleBadgeCount(module.id) > 99 ? "99+" : getModuleBadgeCount(module.id)}
                  </span>
                ) : null}
                {PATIENT_REQUIRED_MODULES.has(module.id) ? (
                  <span className="module-lock-icon" aria-hidden="true">
                    🔒
                  </span>
                ) : null}
              </NavLink>
            ))}
          </nav>
        </aside>
        <div
          className="doctor-main"
          data-active-module={activeModule}
          data-patient-context={isPatientContextMissing ? "missing" : "ready"}
        >

      {isPatientContextMissing ? (
        <article className="doctor-card doctor-patient-guard">
          <div className="doctor-card-header">
            <h3>Patient Selection Required</h3>
          </div>
          <div className="meta">
            The <strong>{activeModule}</strong> section is locked until a current patient is selected.
          </div>
          <div className="form-row">
            <button className="primary" type="button" onClick={() => navigate("/doctor/patients")}>
              Go to Patient Search
            </button>
            <button className="ghost" type="button" onClick={() => searchPatients("")}>
              Refresh patient list
            </button>
          </div>
        </article>
      ) : null}

      <div id="dashboard" className="doctor-summary" data-module="dashboard">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Task Inbox</h3>
            <button className="primary" type="button" onClick={loadTaskInbox}>
              Refresh inbox
            </button>
          </div>
          <div className="info-grid">
            <div>
              <div className="meta">Pending connections</div>
              <strong>{taskInbox.counts?.pendingConnections || 0}</strong>
            </div>
            <div>
              <div className="meta">Pending appointments</div>
              <strong>{taskInbox.counts?.pendingAppointments || 0}</strong>
            </div>
            <div>
              <div className="meta">Due reminders</div>
              <strong>{taskInbox.counts?.dueReminders || 0}</strong>
            </div>
            <div>
              <div className="meta">Today appointments</div>
              <strong>{taskInbox.counts?.todayAppointments || 0}</strong>
            </div>
            <div>
              <div className="meta">Completed today</div>
              <strong>{taskInbox.counts?.completedToday || 0}</strong>
            </div>
            <div>
              <div className="meta">Unsigned SOAP notes</div>
              <strong>{taskInbox.counts?.unsignedSoapNotes || 0}</strong>
            </div>
            <div>
              <div className="meta">Pending refill requests</div>
              <strong>{taskInbox.counts?.pendingRefillRequests || 0}</strong>
            </div>
            <div>
              <div className="meta">Reception alerts</div>
              <strong>{taskInbox.counts?.receptionistAlerts || 0}</strong>
            </div>
            <div>
              <div className="meta">Shared symptom reports</div>
              <strong>{taskInbox.counts?.pendingSymptomReports || 0}</strong>
            </div>
          </div>
          <div className="note-list">
            {(taskInbox.items || []).map((item) => (
              <article
                key={`${item.type}-${item.bookingId || item.noteId || item.refillRequestId || item.reportId || item.startAt}`}
                className="note-item note-item-task"
              >
                <div className="queue-title">
                  {item.type === "appointment_pending"
                    ? "Pending appointment"
                    : item.type === "reminder_due"
                      ? "Reminder due"
                      : item.type === "reception_alert"
                        ? "Reception alert"
                      : item.type === "unsigned_soap_note"
                        ? "Unsigned SOAP note"
                        : item.type === "pending_refill_request"
                          ? "Pending refill request"
                          : item.type === "symptom_report_shared"
                            ? "Shared symptom report"
                          : "Task"}{" "}
                  - {item.patientName || item.patientId || "Unknown patient"}
                </div>
                <div className="meta">
                  {item.startAt ? new Date(item.startAt).toLocaleString() : "No date"} | status:{" "}
                  {item.status || "n/a"}
                </div>
                {item.type === "reception_alert" ? (
                  <div className="meta">
                    {String(item.alertPriority || "normal").toUpperCase()} | {item.alertMessage || "Receptionist update"}
                  </div>
                ) : null}
                {item.type === "symptom_report_shared" ? (
                  <div className="meta">
                    {item.symptomName || "Symptom report"}
                    {item.symptomSeverity ? ` | severity: ${item.symptomSeverity}` : ""}
                    {item.sharedForVirtualDiagnosis ? " | virtual diagnosis requested" : ""}
                  </div>
                ) : null}
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => openTaskItem(item)}
                    disabled={
                      item.type === "symptom_report_shared" &&
                      loadingSymptomReportId === String(item.reportId || "")
                    }
                  >
                    {item.type === "symptom_report_shared" &&
                    loadingSymptomReportId === String(item.reportId || "")
                      ? "Opening..."
                      : "Open"}
                  </button>
                  {item.type === "reception_alert" ? (
                    <button
                      className="ghost"
                      type="button"
                      disabled={Boolean(markingReceptionAlertIds[item.alertId])}
                      onClick={() => markReceptionAlertRead(item)}
                    >
                      {markingReceptionAlertIds[item.alertId] ? "Marking..." : "Mark as read"}
                    </button>
                  ) : null}
                  {item.type === "symptom_report_shared" ? (
                    <button
                      className="ghost"
                      type="button"
                      disabled={Boolean(reviewingSymptomReportIds[item.reportId])}
                      onClick={() => markSymptomReportReviewed(item)}
                    >
                      {reviewingSymptomReportIds[item.reportId] ? "Reviewing..." : "Mark reviewed"}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            {(taskInbox.items || []).length === 0 ? (
              <div className="meta">No priority tasks right now.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div className="doctor-summary" data-module="dashboard">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Installment Proposals</h3>
            <button className="ghost" type="button" onClick={loadInstallmentProposals}>
              Refresh
            </button>
          </div>
          <div className="note-list">
            {(installmentProposals || []).slice(0, 20).map((proposal) => (
              <article key={proposal.id} className="note-item note-item-task">
                <div className="queue-title">
                  {proposal.patientName || proposal.patientId || "Patient"} | {proposal.installments} x{" "}
                  {Number(proposal.amountEach || 0).toFixed(2)} {proposal.currency || "JMD"}
                </div>
                <div className="meta">
                  Total: {Number(proposal.totalAmount || 0).toFixed(2)} {proposal.currency || "JMD"} | Start:{" "}
                  {proposal.startDate || "n/a"} | Status: {proposal.status || "pending"}
                </div>
                {proposal.reviewedAt ? (
                  <div className="meta">
                    Reviewed: {new Date(proposal.reviewedAt).toLocaleString()} by{" "}
                    {proposal.reviewedByRole || "staff"}
                  </div>
                ) : null}
                {proposal.reviewNote ? <div className="meta">Note: {proposal.reviewNote}</div> : null}
                {String(proposal.status || "").toLowerCase() === "pending" ? (
                  <div className="form-row">
                    <button
                      className="primary"
                      type="button"
                      disabled={Boolean(decidingInstallmentIds[proposal.id])}
                      onClick={() => decideInstallmentProposal(proposal.id, "approved")}
                    >
                      {decidingInstallmentIds[proposal.id] === "approved" ? "Approving..." : "Approve"}
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      disabled={Boolean(decidingInstallmentIds[proposal.id])}
                      onClick={() => decideInstallmentProposal(proposal.id, "rejected")}
                    >
                      {decidingInstallmentIds[proposal.id] === "rejected" ? "Rejecting..." : "Reject"}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
            {!installmentProposals.length ? (
              <div className="meta">No installment proposals submitted yet.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div className="doctor-summary" data-module="dashboard">
        <article className="doctor-card receptionist-access-card">
          <div className="doctor-card-header">
            <h3>Daily Agenda</h3>
            <button className="ghost" type="button" onClick={() => loadDailyAgenda(agendaDate)}>
              Refresh
            </button>
          </div>
          <div className="form-row">
            <label>
              Date
              <input
                type="date"
                value={agendaDate}
                onChange={(e) => {
                  setAgendaDate(e.target.value);
                  loadDailyAgenda(e.target.value);
                }}
              />
            </label>
          </div>
          <div className="note-list">
            {(dailyAgenda || []).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">
                  {new Date(entry.startAt).toLocaleTimeString()} - {entry.patientName}
                </div>
                <div className="meta">
                  {entry.status} | {(entry.triageTags || []).join(", ") || "routine"}
                </div>
              </div>
            ))}
            {!dailyAgenda.length ? <div className="meta">No agenda items.</div> : null}
          </div>
        </article>

        <article className="doctor-card receptionist-access-card">
          <div className="doctor-card-header">
            <h3>KPI Panel</h3>
            <button className="ghost" type="button" onClick={loadKpi}>
              Refresh KPIs
            </button>
          </div>
          <div className="info-grid">
            <div>
              <div className="meta">Avg turnaround (hrs)</div>
              <strong>{kpi?.avgTurnaroundHours ?? 0}</strong>
            </div>
            <div>
              <div className="meta">No-show rate</div>
              <strong>{Math.round(Number(kpi?.noShowRate || 0) * 100)}%</strong>
            </div>
            <div>
              <div className="meta">Refill success</div>
              <strong>{Math.round(Number(kpi?.refillSuccessRate || 0) * 100)}%</strong>
            </div>
            <div>
              <div className="meta">Payments collected today</div>
              <strong>JMD {Number(kpi?.paymentsCollectedToday || 0).toFixed(2)}</strong>
            </div>
            <div>
              <div className="meta">Payment transactions today</div>
              <strong>{Number(kpi?.paymentTransactionsToday || 0)}</strong>
            </div>
          </div>
        </article>
      </div>

      <div id="coordination" className="doctor-summary" data-module="coordination">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Structured Referrals</h3>
            <div className="form-row">
              <label>
                Status
                <select value={referralStatusFilter} onChange={(e) => setReferralStatusFilter(e.target.value)}>
                  <option value="">all</option>
                  <option value="pending">pending</option>
                  <option value="sent">sent</option>
                  <option value="accepted">accepted</option>
                  <option value="scheduled">scheduled</option>
                  <option value="completed">completed</option>
                  <option value="cancelled">cancelled</option>
                </select>
              </label>
              <button className="ghost" type="button" onClick={() => loadReferrals(selectedPatient?.id || "")}>
                Refresh
              </button>
            </div>
          </div>
          <div className="form-row">
            <span className="doctor-date-chip doctor-date-chip--available">Total {referralStats.total}</span>
            <span className="doctor-date-chip doctor-date-chip--pending">Pending {referralStats.pending}</span>
            <span className="doctor-date-chip doctor-date-chip--approved">Completed {referralStats.completed}</span>
            <span className="doctor-date-chip doctor-date-chip--rejected">Cancelled {referralStats.cancelled}</span>
          </div>
          <div className="form">
            <div className="form-row">
              <label>
                Type
                <select
                  value={referralForm.referralType}
                  onChange={(e) =>
                    setReferralForm((s) => ({ ...s, referralType: e.target.value }))
                  }
                >
                  <option value="specialist">Specialist</option>
                  <option value="lab">Lab</option>
                  <option value="imaging">Imaging</option>
                </select>
              </label>
              <label>
                Priority
                <select
                  value={referralForm.priority}
                  onChange={(e) => setReferralForm((s) => ({ ...s, priority: e.target.value }))}
                >
                  <option value="routine">Routine</option>
                  <option value="urgent">Urgent</option>
                  <option value="stat">STAT</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                Specialty / service
                <input
                  value={referralForm.targetSpecialty}
                  onChange={(e) => setReferralForm((s) => ({ ...s, targetSpecialty: e.target.value }))}
                  placeholder="e.g. Cardiology / CBC + LFT"
                />
              </label>
              <label>
                Requested by
                <input
                  type="date"
                  value={referralForm.requestedByDate}
                  onChange={(e) => setReferralForm((s) => ({ ...s, requestedByDate: e.target.value }))}
                />
              </label>
            </div>
            <label>
              Target name
              <input
                value={referralForm.targetName}
                onChange={(e) => setReferralForm((s) => ({ ...s, targetName: e.target.value }))}
                placeholder="Clinic, lab, specialist, or department"
              />
            </label>
            <label>
              Target contact
              <input
                value={referralForm.targetContact}
                onChange={(e) => setReferralForm((s) => ({ ...s, targetContact: e.target.value }))}
                placeholder="Email, phone, or fax"
              />
            </label>
            <label>
              Reason
              <input
                value={referralForm.reason}
                onChange={(e) => setReferralForm((s) => ({ ...s, reason: e.target.value }))}
                placeholder="Minimum 10 characters clinical reason"
              />
            </label>
            <label>
              Clinical question for receiving team
              <textarea
                value={referralForm.clinicalQuestion}
                onChange={(e) => setReferralForm((s) => ({ ...s, clinicalQuestion: e.target.value }))}
                placeholder="What exactly should the specialist/lab answer?"
              />
            </label>
            <label>
              Attachment URLs (comma or new line)
              <textarea
                value={referralForm.attachmentUrlsText}
                onChange={(e) => setReferralForm((s) => ({ ...s, attachmentUrlsText: e.target.value }))}
                placeholder="https://...report.pdf, https://...scan.jpg"
              />
            </label>
            <button className="primary" type="button" onClick={createReferral} disabled={!selectedPatient?.id}>
              Create referral
            </button>
          </div>
          <div className="note-list">
            {referrals.slice(0, 12).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">
                  {entry.referralType} {"->"} {entry.targetName}
                </div>
                <div className="meta">
                  {entry.priority} | {entry.status}
                  {entry.targetSpecialty ? ` | ${entry.targetSpecialty}` : ""}
                  {entry.requestedByDate ? ` | Due ${entry.requestedByDate}` : ""}
                </div>
                {entry.reason ? <div className="meta">{entry.reason}</div> : null}
                {entry.clinicalQuestion ? <div className="meta">Question: {entry.clinicalQuestion}</div> : null}
                {entry.targetContact ? <div className="meta">Contact: {entry.targetContact}</div> : null}
                <div className="form-row">
                  <input
                    value={referralStatusNoteById[entry.id] || ""}
                    onChange={(e) =>
                      setReferralStatusNoteById((current) => ({ ...current, [entry.id]: e.target.value }))
                    }
                    placeholder="Optional status note"
                  />
                  {entry.status !== "sent" ? (
                    <button className="ghost" type="button" onClick={() => updateReferralStatus(entry.id, "sent")}>
                      Mark sent
                    </button>
                  ) : null}
                  {entry.status !== "scheduled" ? (
                    <button className="ghost" type="button" onClick={() => updateReferralStatus(entry.id, "scheduled")}>
                      Mark scheduled
                    </button>
                  ) : null}
                  {entry.status !== "completed" ? (
                    <button className="primary" type="button" onClick={() => updateReferralStatus(entry.id, "completed")}>
                      Mark completed
                    </button>
                  ) : null}
                  {entry.status !== "cancelled" ? (
                    <button className="ghost" type="button" onClick={() => updateReferralStatus(entry.id, "cancelled")}>
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {!referrals.length ? <div className="meta">No referrals in this filter.</div> : null}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Pharmacy Intervention Queue</h3>
            <button className="ghost" type="button" onClick={() => loadInterventions(selectedPatient?.id || "")}>
              Refresh
            </button>
          </div>
          <div className="note-list">
            {interventions.slice(0, 12).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">{entry.interventionType}</div>
                <div className="meta">{entry.details || "No details"} | {entry.status}</div>
                {entry.status === "pending" ? (
                  <div className="form-row">
                    <button className="primary" type="button" onClick={() => decideIntervention(entry.id, "approved")}>
                      Approve
                    </button>
                    <button className="ghost" type="button" onClick={() => decideIntervention(entry.id, "rejected")}>
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {!interventions.length ? <div className="meta">No interventions queued.</div> : null}
          </div>
        </article>
      </div>

      <div id="soap" className="doctor-summary" data-module="soap">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Shared Care Notes</h3>
          </div>
          <label>
            Note (doctor/pharmacy/reception)
            <textarea value={sharedNoteDraft} onChange={(e) => setSharedNoteDraft(e.target.value)} />
          </label>
          <button className="primary" type="button" onClick={createSharedCareNote} disabled={!selectedPatient?.id}>
            Save shared note
          </button>
          <div className="note-list">
            {sharedNotes.slice(0, 8).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="note-text">{entry.text}</div>
                <div className="meta">{(entry.visibilityRoles || []).join(", ")}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>SOAP Builder + Coding Assist</h3>
          </div>
          <section className="soap-flow" aria-label="Clinical notes workflow">
            {SOAP_STEP_ORDER.map((step, index) => (
              <span
                key={step.id}
                className={`soap-flow-step${
                  step.id === activeSoapStep
                    ? " active"
                    : index < activeSoapStepIndex
                      ? " done"
                      : ""
                }`}
              >
                {index + 1}. {step.label}
              </span>
            ))}
          </section>
          <div className="soap-flow-compact" role="status" aria-live="polite">
            <span className="meta">Current step</span>
            <strong>
              {activeSoapStepIndex + 1}/{SOAP_STEP_ORDER.length}{" "}
              {SOAP_STEP_ORDER[activeSoapStepIndex]?.label || "Subjective Intake"}
            </strong>
          </div>
          <section
            className={`soap-preview soap-step soap-step-preview ${isSoapPreviewLocked ? "soap-preview--locked" : ""}`}
            aria-label="SOAP mockup preview"
            onFocusCapture={() => setActiveSoapStep("sign")}
          >
            <div className="soap-preview-header">
              <div>
                <h4>Clinical SOAP Mockup Preview</h4>
                <div className="meta">Live preview format for draft and signed documentation</div>
              </div>
              <div className="soap-preview-actions">
                <div className="soap-toggle">
                  <button
                    type="button"
                    className={soapPreviewMode === "draft" ? "primary" : "ghost"}
                    onClick={() => setSoapPreviewMode("draft")}
                  >
                    Draft
                  </button>
                  <button
                    type="button"
                    className={soapPreviewMode === "signed" ? "primary" : "ghost"}
                    onClick={() => setSoapPreviewMode("signed")}
                  >
                    Signed
                  </button>
                </div>
                <span className={isSoapPreviewLocked ? "doctor-badge" : "doctor-pill"}>
                  {isSoapPreviewLocked ? "Signed - Locked" : "Draft"}
                </span>
              </div>
            </div>
            {soapPreviewMode === "signed" ? (
              signedSoapNotes.length ? (
                <label className="soap-preview-note-select">
                  Signed note
                  <select
                    value={selectedSignedSoapNote?.id || ""}
                    onChange={(e) => setSelectedSignedSoapNoteId(e.target.value)}
                  >
                    {signedSoapNotes.map((note) => (
                      <option key={note.id} value={note.id}>
                        {new Date(note.signedAt || note.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="meta">Showing demo signed note preview (no real signed SOAP notes yet).</div>
              )
            ) : null}
            {isSoapPreviewLocked ? (
              <div className="soap-lock-banner">
                This SOAP note is signed and locked. Editing is disabled for medico-legal integrity.
              </div>
            ) : null}
            <div className="soap-preview-meta">
              <div><strong>Patient:</strong> {selectedPatient?.fullName || selectedPatient?.name || "Jane Brown"}</div>
              <div><strong>Patient ID:</strong> {selectedPatient?.id || "PAT-1021"}</div>
              <div><strong>Doctor:</strong> {user?.name || "Doctor User"}</div>
              <div><strong>Doctor ID:</strong> {user?.id || "DOC-11"}</div>
            </div>
            <div className="soap-preview-grid">
              <article className="soap-preview-block">
                <h5>S - Subjective</h5>
                <p>{(isSoapPreviewLocked ? signedPreviewNote?.subjective : soapDraft.subjective) || "Patient reports chest tightness for 3 days, worse at night, mild shortness of breath."}</p>
              </article>
              <article className="soap-preview-block">
                <h5>O - Objective</h5>
                <p>{(isSoapPreviewLocked ? signedPreviewNote?.objective : soapDraft.objective) || "BP 128/82, HR 88, SpO2 97%, mild expiratory wheeze on auscultation."}</p>
              </article>
              <article className="soap-preview-block">
                <h5>A - Assessment</h5>
                <p>{(isSoapPreviewLocked ? signedPreviewNote?.assessment : soapDraft.assessment) || "Likely mild asthma exacerbation without acute distress."}</p>
              </article>
              <article className="soap-preview-block">
                <h5>P - Plan</h5>
                <p>{(isSoapPreviewLocked ? signedPreviewNote?.plan : soapDraft.plan) || "Start inhaler PRN, reinforce trigger avoidance, follow-up in 7 days with emergency precautions."}</p>
              </article>
            </div>
            <div className="soap-preview-footer">
              <div>
                <strong>ICD-10:</strong> {previewDiagnosisCodes || "J45.901"}
              </div>
              <div>
                <strong>CPT:</strong> {previewProcedureCodes || "99213"}
              </div>
            </div>
          </section>
          <div className="form-row soap-step soap-step-subjective" onFocusCapture={() => setActiveSoapStep("subjective")}>
            <label>
              Voice dictation text
              <textarea value={dictationText} onChange={(e) => setDictationText(e.target.value)} disabled={isSoapPreviewLocked} />
            </label>
            <div className="dictation-controls">
              <label>
                Dictation language
                <select
                  value={dictationLanguage}
                  onChange={(e) => setDictationLanguage(e.target.value)}
                  disabled={isSoapPreviewLocked || isDictating}
                >
                  <option value="en-US">English (US)</option>
                  <option value="en-GB">English (UK)</option>
                  <option value="es-ES">Spanish</option>
                </select>
              </label>
              <div className="form-row">
                <button
                  className="primary"
                  type="button"
                  onClick={startDictation}
                  disabled={isSoapPreviewLocked || isDictating || !isSpeechRecognitionAvailable}
                >
                  Start Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopDictation(false)}
                  disabled={!isDictating}
                >
                  Stop Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopDictation(true)}
                  disabled={isSoapPreviewLocked || (!isDictating && !dictationText.trim())}
                >
                  Stop + Summarize SOAP
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => extractDictationToSoap()}
                  disabled={isSoapPreviewLocked || !dictationText.trim()}
                >
                  Summarize SOAP
                </button>
              </div>
              <div className="meta">
                {isSpeechRecognitionAvailable
                  ? (isDictating ? "Listening to patient..." : "Microphone ready.")
                  : "Speech recognition not supported in this browser."}
              </div>
              {dictationInterimText ? (
                <div className="meta">Live transcript: {dictationInterimText}</div>
              ) : null}
            </div>
          </div>
          <div className="form-row soap-step soap-step-objective-input" onFocusCapture={() => setActiveSoapStep("objective")}>
            <label>
              Subjective
              <textarea
                value={soapDraft.subjective}
                onChange={(e) => {
                  setSoapDraft((s) => ({ ...s, subjective: e.target.value }));
                  setObjectiveAssistMeta(null);
                  setAssessmentAssistMeta(null);
                }}
                disabled={isSoapPreviewLocked}
              />
            </label>
            <label>
              Objective
              <textarea
                value={soapDraft.objective}
                onChange={(e) => {
                  setSoapDraft((s) => ({ ...s, objective: e.target.value }));
                  setAssessmentAssistMeta(null);
                }}
                disabled={isSoapPreviewLocked}
              />
            </label>
          </div>
          <div className="form-row soap-step soap-step-objective-ai" onFocusCapture={() => setActiveSoapStep("objective")}>
            <button
              className="ghost"
              type="button"
              onClick={runObjectiveAssist}
              disabled={isSoapPreviewLocked || !String(soapDraft.subjective || "").trim()}
            >
              AI Objective Assist
            </button>
            {objectiveAssistMeta ? (
              <div className="meta">
                Confidence: {Math.round(Number(objectiveAssistMeta.confidence || 0) * 100)}% | Keywords:{" "}
                {(objectiveAssistMeta.detectedKeywords || []).join(", ") || "none"} | Confirmed symptoms:{" "}
                {(objectiveAssistMeta.confirmedSymptoms || []).join(", ") || "none"} | Denied symptoms:{" "}
                {(objectiveAssistMeta.deniedSymptoms || []).join(", ") || "none"} | Recommended vitals:{" "}
                {(objectiveAssistMeta.recommendedVitals || []).join(", ") || "none"}
              </div>
            ) : (
              <div className="meta">
                Objective Assist uses Subjective keywords to draft measurable objective findings.
              </div>
            )}
          </div>
          <section
            className="objective-mini-summary soap-step soap-step-objective-summary"
            aria-label="Objective mini summary"
            onFocusCapture={() => setActiveSoapStep("objective")}
          >
            <div className="objective-mini-summary__header">
              <h4>Objective Summary</h4>
              <span className="doctor-pill">
                Confidence {Number.isFinite(objectiveSummaryPreview.confidencePct) ? objectiveSummaryPreview.confidencePct : 0}%
              </span>
            </div>
            <p className="objective-mini-summary__headline">{objectiveSummaryPreview.headline}</p>
            <div className="objective-mini-summary__grid">
              <div>
                <div className="meta">Confirmed</div>
                <strong>{objectiveSummaryPreview.confirmed.join(", ") || "None detected"}</strong>
              </div>
              <div>
                <div className="meta">Denied</div>
                <strong>{objectiveSummaryPreview.denied.join(", ") || "None detected"}</strong>
              </div>
              <div>
                <div className="meta">Recommended Vitals</div>
                <strong>{objectiveSummaryPreview.vitals.join(", ") || "Standard vitals"}</strong>
              </div>
              <div>
                <div className="meta">Detected Keywords</div>
                <strong>{objectiveSummaryPreview.keywords.join(", ") || "None detected"}</strong>
              </div>
            </div>
          </section>
          <div className="form-row soap-step soap-step-assessment-input" onFocusCapture={() => setActiveSoapStep("assessment")}>
            <label>
              Assessment
              <textarea value={soapDraft.assessment} onChange={(e) => setSoapDraft((s) => ({ ...s, assessment: e.target.value }))} disabled={isSoapPreviewLocked} />
            </label>
          </div>
          <div className="form-row soap-step soap-step-plan-input" onFocusCapture={() => setActiveSoapStep("plan")}>
            <label>
              Plan
              <textarea
                value={soapDraft.plan}
                onChange={(e) => {
                  setSoapDraft((s) => ({ ...s, plan: e.target.value }));
                  setPlanAssistMeta(null);
                }}
                disabled={isSoapPreviewLocked}
              />
            </label>
          </div>
          <div className="form-row soap-step soap-step-plan-ai" onFocusCapture={() => setActiveSoapStep("plan")}>
            <div className="dictation-controls">
              <label>
                Plan voice notes
                <textarea
                  value={planDictationText}
                  onChange={(e) => setPlanDictationText(e.target.value)}
                  disabled={isSoapPreviewLocked}
                />
              </label>
              <div className="form-row">
                <button
                  className="primary"
                  type="button"
                  onClick={startPlanDictation}
                  disabled={isSoapPreviewLocked || isPlanDictating || !isSpeechRecognitionAvailable}
                >
                  Start Plan Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopPlanDictation(false)}
                  disabled={!isPlanDictating}
                >
                  Stop Plan Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopPlanDictation(true)}
                  disabled={isSoapPreviewLocked || (!isPlanDictating && !planDictationText.trim())}
                >
                  Stop + AI Plan
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => runPlanAssist()}
                  disabled={isSoapPreviewLocked || (!soapDraft.assessment.trim() && !soapDraft.objective.trim() && !soapDraft.subjective.trim())}
                >
                  AI Plan Assist
                </button>
              </div>
              <div className="meta">
                {isSpeechRecognitionAvailable
                  ? (isPlanDictating ? "Listening for plan dictation..." : "Plan microphone ready.")
                  : "Speech recognition not supported in this browser."}
              </div>
              {planInterimText ? <div className="meta">Plan live transcript: {planInterimText}</div> : null}
            </div>
            <section className="objective-mini-summary" aria-label="Plan mini summary">
              <div className="objective-mini-summary__header">
                <h4>Plan Summary</h4>
                <span className="doctor-pill">
                  Confidence {Math.round(Number(planAssistMeta?.confidence || 0) * 100)}%
                </span>
              </div>
              <p className="objective-mini-summary__headline">
                {(planAssistMeta?.escalationNotes || []).join(" ") ||
                  "Run AI Plan Assist to generate treatment actions and follow-up summary."}
              </p>
              <div className="objective-mini-summary__grid">
                <div>
                  <div className="meta">Risk level</div>
                  <strong>{String(planAssistMeta?.riskLevel || "low").toUpperCase()}</strong>
                </div>
                <div>
                  <div className="meta">Actions</div>
                  <strong>{(planAssistMeta?.actions || []).join(" ") || "No actions generated"}</strong>
                </div>
                <div>
                  <div className="meta">Follow-up</div>
                  <strong>{planAssistMeta?.followUp || "No follow-up generated"}</strong>
                </div>
                <div>
                  <div className="meta">Red flags</div>
                  <strong>{(planAssistMeta?.redFlags || []).join("; ") || "No red flags generated"}</strong>
                </div>
              </div>
            </section>
          </div>
          <div className="form-row soap-step soap-step-assessment-ai" onFocusCapture={() => setActiveSoapStep("assessment")}>
            <div className="dictation-controls">
              <label>
                Assessment voice notes
                <textarea
                  value={assessmentDictationText}
                  onChange={(e) => setAssessmentDictationText(e.target.value)}
                  disabled={isSoapPreviewLocked}
                />
              </label>
              <div className="form-row">
                <button
                  className="primary"
                  type="button"
                  onClick={startAssessmentDictation}
                  disabled={isSoapPreviewLocked || isAssessmentDictating || !isSpeechRecognitionAvailable}
                >
                  Start Assessment Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopAssessmentDictation(false)}
                  disabled={!isAssessmentDictating}
                >
                  Stop Assessment Mic
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => stopAssessmentDictation(true)}
                  disabled={isSoapPreviewLocked || (!isAssessmentDictating && !assessmentDictationText.trim())}
                >
                  Stop + AI Assessment
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => runAssessmentAssist()}
                  disabled={isSoapPreviewLocked || (!soapDraft.subjective.trim() && !soapDraft.objective.trim())}
                >
                  AI Assessment Assist
                </button>
              </div>
              <div className="meta">
                {isSpeechRecognitionAvailable
                  ? (isAssessmentDictating ? "Listening for assessment dictation..." : "Assessment microphone ready.")
                  : "Speech recognition not supported in this browser."}
              </div>
              {assessmentInterimText ? <div className="meta">Assessment live transcript: {assessmentInterimText}</div> : null}
            </div>
            <section className="objective-mini-summary" aria-label="Assessment mini summary">
              <div className="objective-mini-summary__header">
                <h4>Assessment Summary</h4>
                <span className="doctor-pill">
                  Confidence {Math.round(Number(assessmentAssistMeta?.confidence || 0) * 100)}%
                </span>
              </div>
              <div className="clinical-category-row">
                {(clinicalCategoryBadges.length ? clinicalCategoryBadges : ["Unclassified"]).map((category) => (
                  <span key={category} className="clinical-category-badge">
                    {category}
                  </span>
                ))}
              </div>
              <p className="objective-mini-summary__headline">
                {(assessmentAssistMeta?.safetyFlags || []).join(" ") ||
                  "Run AI Assessment Assist to generate differential and safety-focused summary."}
              </p>
              <div className="objective-mini-summary__grid">
                <div>
                  <div className="meta">Risk level</div>
                  <strong>{String(assessmentAssistMeta?.riskLevel || "low").toUpperCase()}</strong>
                </div>
                <div>
                  <div className="meta">Matched keywords</div>
                  <strong>{(assessmentAssistMeta?.matchedKeywords || []).join(", ") || "None detected"}</strong>
                </div>
                <div>
                  <div className="meta">Differentials</div>
                  <strong>{(assessmentAssistMeta?.differentials || []).join("; ") || "No differential generated"}</strong>
                </div>
                <div>
                  <div className="meta">Objective-detected issues</div>
                  <strong>
                    {(assessmentAssistMeta?.detectedObjectiveIssues || [])
                      .map((entry) => entry.label)
                      .join("; ") || "No issue tags from objective"}
                  </strong>
                </div>
                <div>
                  <div className="meta">Likely diagnoses</div>
                  <strong>
                    {(assessmentAssistMeta?.likelyDiagnoses || [])
                      .map((entry) => `${entry.label} (${entry.score})`)
                      .join(" | ") || "No weighted candidates"}
                  </strong>
                </div>
                <div>
                  <div className="meta">Parsed objective measures</div>
                  <strong>
                    {Object.entries(assessmentAssistMeta?.objectiveMeasures || {})
                      .filter(([, value]) => value !== null && value !== undefined && value !== "")
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(", ") || "No measurable values parsed"}
                  </strong>
                </div>
                <div>
                  <div className="meta">Safety flags</div>
                  <strong>{(assessmentAssistMeta?.safetyFlags || []).join(" ") || "No flags"}</strong>
                </div>
              </div>
            </section>
          </div>
          <div className="form-row soap-step soap-step-coding" onFocusCapture={() => setActiveSoapStep("coding")}>
            <label>
              <span className="field-label-with-tip">
                ICD-10 codes (comma separated)
                <span
                  className="inline-tooltip"
                  role="button"
                  tabIndex={0}
                  aria-label="ICD-10 help"
                  data-tip="ICD-10 codes identify the diagnosis/condition being treated. Example: J45.901 for asthma exacerbation."
                >
                  ?
                </span>
              </span>
              <div className="code-input-wrap">
                <input
                  value={soapDraft.diagnosisCodes}
                  onChange={(e) => onDiagnosisCodesInput(e.target.value)}
                  onBlur={() => window.setTimeout(() => setIcdCodeSuggestions([]), 120)}
                  disabled={isSoapPreviewLocked}
                />
                {icdCodeSuggestions.length && !isSoapPreviewLocked ? (
                  <div className="code-suggestion-list">
                    {icdCodeSuggestions.map((entry) => (
                      <button
                        key={`icd-${entry.code}`}
                        type="button"
                        className="code-suggestion-item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectDiagnosisCode(entry.code)}
                      >
                        <span className="code-suggestion-code">{entry.code}</span>
                        <span className="code-suggestion-label">{entry.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
            <label>
              <span className="field-label-with-tip">
                CPT codes (comma separated)
                <span
                  className="inline-tooltip"
                  role="button"
                  tabIndex={0}
                  aria-label="CPT help"
                  data-tip="CPT codes identify the clinical service/procedure performed. Example: 99213 for an established outpatient visit."
                >
                  ?
                </span>
              </span>
              <div className="code-input-wrap">
                <input
                  value={soapDraft.procedureCodes}
                  onChange={(e) => onProcedureCodesInput(e.target.value)}
                  onBlur={() => window.setTimeout(() => setCptCodeSuggestions([]), 120)}
                  disabled={isSoapPreviewLocked}
                />
                {cptCodeSuggestions.length && !isSoapPreviewLocked ? (
                  <div className="code-suggestion-list">
                    {cptCodeSuggestions.map((entry) => (
                      <button
                        key={`cpt-${entry.code}`}
                        type="button"
                        className="code-suggestion-item"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectProcedureCode(entry.code)}
                      >
                        <span className="code-suggestion-code">{entry.code}</span>
                        <span className="code-suggestion-label">{entry.label}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </label>
          </div>
          <div className="form-row soap-step soap-step-sign" onFocusCapture={() => setActiveSoapStep("sign")}>
            <button className="primary" type="button" onClick={saveSoapNote} disabled={!selectedPatient?.id || isSoapPreviewLocked}>
              Save SOAP
            </button>
            <button
              className="ghost"
              type="button"
              onClick={signLatestSoapNote}
              disabled={!selectedPatient?.id || isSigningSoap}
            >
              {isSigningSoap ? "Signing..." : "Sign & Lock Latest SOAP"}
            </button>
          </div>
          {soapActionStatus ? <div className="meta">{soapActionStatus}</div> : null}
          {!selectedPatient?.id ? (
            <div className="meta">Select a patient to enable SOAP signing.</div>
          ) : !latestUnsignedSoapNote ? (
            <div className="meta">No unsigned SOAP note found. Clicking Sign will auto-save current draft first.</div>
          ) : (
            <div className="meta">
              Ready to sign: {new Date(latestUnsignedSoapNote.createdAt).toLocaleString()}
            </div>
          )}
          <div className="form-row soap-step soap-step-coding-search" onFocusCapture={() => setActiveSoapStep("coding")}>
            <label>
              Coding search
              <input
                value={codingSearch}
                onChange={(e) => {
                  setCodingSearch(e.target.value);
                  loadCodingAssist(e.target.value);
                }}
              />
            </label>
          </div>
          <div className="note-list soap-step soap-step-coding-results" onFocusCapture={() => setActiveSoapStep("coding")}>
            {(icd10Items || []).slice(0, 4).map((entry) => (
              <div key={entry.code} className="note-item">
                <div className="queue-title">ICD-10 {entry.code}</div>
                <div className="meta">{entry.label}</div>
              </div>
            ))}
            {(cptItems || []).slice(0, 4).map((entry) => (
              <div key={entry.code} className="note-item">
                <div className="queue-title">CPT {entry.code}</div>
                <div className="meta">{entry.label}</div>
              </div>
            ))}
          </div>
          <div className="note-list soap-step soap-step-sign-history" onFocusCapture={() => setActiveSoapStep("sign")}>
            {(soapNotes || []).slice(0, 6).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">SOAP Note</div>
                <div className="meta">{entry.signedAt ? "Signed" : "Unsigned"} | {new Date(entry.createdAt).toLocaleString()}</div>
                {!entry.signedAt ? (
                  <button className="ghost" type="button" onClick={() => signSoapNote(entry.id)}>
                    Sign note
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </article>
      </div>

      <div id="patient-comms" className="doctor-summary" data-module="patient-comms">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Patient Communication</h3>
          </div>
          <div className="form-row">
            <label>
              Cohort
              <select
                value={broadcastForm.cohort}
                onChange={(e) => setBroadcastForm((s) => ({ ...s, cohort: e.target.value }))}
              >
                <option value="all">All</option>
                <option value="high_risk">High risk</option>
                <option value="non_adherence">Non-adherence</option>
                <option value="no_show">No-show risk</option>
              </select>
            </label>
            <label>
              Language
              <select
                value={broadcastForm.language}
                onChange={(e) => {
                  setBroadcastForm((s) => ({ ...s, language: e.target.value }));
                  loadInstructionTemplates(e.target.value);
                }}
              >
                <option value="en">English</option>
                <option value="es">Spanish</option>
              </select>
            </label>
          </div>
          <label>
            Instruction template
            <select
              onChange={(e) => {
                const selected = instructionTemplates.find((t) => t.id === e.target.value);
                if (selected) setBroadcastForm((s) => ({ ...s, text: selected.body }));
              }}
            >
              <option value="">Select template</option>
              {instructionTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Message
            <textarea
              value={broadcastForm.text}
              onChange={(e) => setBroadcastForm((s) => ({ ...s, text: e.target.value }))}
            />
          </label>
          <button className="primary" type="button" onClick={sendBroadcastInstruction}>
            Send broadcast
          </button>
          <div className="note-list">
            {(broadcasts || []).slice(0, 8).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">{entry.cohort} | {entry.language}</div>
                <div className="meta">
                  Read: {entry.readAt ? new Date(entry.readAt).toLocaleString() : "No"} | Escalation:{" "}
                  {entry.escalationLevel || 0}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Compliance + Legal</h3>
          </div>
          <div className="form">
            <label>
              Consent type
              <input
                value={consentForm.consentType}
                onChange={(e) => setConsentForm((s) => ({ ...s, consentType: e.target.value }))}
              />
            </label>
            <label>
              Consent expiry
              <input
                type="date"
                value={consentForm.expiresAt}
                onChange={(e) => setConsentForm((s) => ({ ...s, expiresAt: e.target.value }))}
              />
            </label>
            <label>
              Notes
              <input
                value={consentForm.notes}
                onChange={(e) => setConsentForm((s) => ({ ...s, notes: e.target.value }))}
              />
            </label>
            <button className="primary" type="button" onClick={createConsent} disabled={!selectedPatient?.id}>
              Add consent
            </button>
          </div>
          <div className="note-list">
            {consents.slice(0, 8).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">{entry.consentType}</div>
                <div className="meta">{entry.status} | expires {entry.expiresAt || "n/a"}</div>
              </div>
            ))}
            {patientAudit.slice(0, 8).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">{entry.action}</div>
                <div className="meta">{new Date(entry.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Receptionist Access Control</h3>
            <button
              className="ghost"
              type="button"
              onClick={() => {
                loadReceptionists(selectedPatient?.id || "");
                loadReceptionAccess(selectedPatient?.id || "");
              }}
            >
              Refresh
            </button>
          </div>
          <div className="meta receptionist-access-intro">
            Authorize receptionist visibility for selected patient only. This controls operational access
            (check-in, scheduling, handoff) without exposing full clinical data by default.
          </div>
          <div className="form-row receptionist-access-search-row">
            <label>
              Find receptionist (name, email, or platform ID)
              <input
                value={receptionistSearchQuery}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  setReceptionistSearchQuery(nextValue);
                  loadReceptionists(selectedPatient?.id || "", nextValue);
                }}
                placeholder="e.g. RCPT-00012"
              />
            </label>
          </div>
          <form className="form receptionist-enroll-form" onSubmit={enrollReceptionist} noValidate>
            <div className="form-row receptionist-enroll-grid">
              <label>
                Receptionist full name
                <input
                  value={receptionistForm.fullName}
                  onChange={(e) =>
                    setReceptionistForm((s) => ({ ...s, fullName: e.target.value }))
                  }
                  placeholder="e.g. Front Desk User"
                />
              </label>
              <label>
                Receptionist email
                <input
                  type="email"
                  value={receptionistForm.email}
                  onChange={(e) =>
                    setReceptionistForm((s) => ({ ...s, email: e.target.value }))
                  }
                  placeholder="reception@clinic.com"
                />
              </label>
            </div>
            <div className="form-row receptionist-enroll-actions">
              <label>
                Temporary password (optional)
                <input
                  value={receptionistForm.password}
                  onChange={(e) =>
                    setReceptionistForm((s) => ({ ...s, password: e.target.value }))
                  }
                  placeholder="Leave blank to auto-generate"
                />
              </label>
              <button className="primary" type="submit" disabled={isEnrollingReceptionist}>
                {isEnrollingReceptionist ? "Enrolling..." : "Enroll receptionist"}
              </button>
            </div>
            {enrollReceptionistInlineMessage.text ? (
              <p
                className={`meta ${
                  enrollReceptionistInlineMessage.type === "error"
                    ? "notice error"
                    : "notice"
                }`}
              >
                {enrollReceptionistInlineMessage.text}
              </p>
            ) : null}
          </form>
          {createdReceptionist?.credentialsIssued ? (
            <div className="notice">
              Receptionist created: {createdReceptionist.receptionist?.fullName}
              <br />
              Platform ID: {createdReceptionist.receptionist?.platformStaffId || "Not assigned"}
              <br />
              Login email: {createdReceptionist.credentialsIssued.email}
              <br />
              Temp password: {createdReceptionist.credentialsIssued.temporaryPassword}
            </div>
          ) : null}
          <div className="form receptionist-grant-form">
            <label>
              Receptionist
              <select
                value={receptionGrantDraft.receptionistId}
                onChange={(e) => {
                  setReceptionGrantDraft((s) => ({ ...s, receptionistId: e.target.value }));
                  setAssignReceptionistInlineMessage({ type: "", text: "" });
                }}
                disabled={!selectedPatient?.id}
              >
                <option value="">Select receptionist</option>
                {receptionists.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    [{entry.platformStaffId || "No-ID"}] {entry.fullName}
                    {entry.ownedByCurrentDoctor ? " [My Staff]" : " [Platform]"}{" "}
                    {entry.email ? `(${entry.email})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <button
                className="ghost"
                type="button"
                onClick={() => assignReceptionistOwner(receptionGrantDraft.receptionistId)}
                disabled={!receptionGrantDraft.receptionistId || isAssigningReceptionistOwner}
              >
                {isAssigningReceptionistOwner ? "Assigning..." : "Assign existing receptionist to my account"}
              </button>
            </div>
            {assignReceptionistInlineMessage.text ? (
              <p
                className={`meta ${
                  assignReceptionistInlineMessage.type === "error"
                    ? "notice error"
                    : "notice"
                }`}
              >
                {assignReceptionistInlineMessage.text}
              </p>
            ) : null}
            <label className="checkbox receptionist-scope-row">
              <input
                type="checkbox"
                checked={Boolean(receptionGrantDraft.canViewDemographics)}
                onChange={(e) =>
                  setReceptionGrantDraft((s) => ({
                    ...s,
                    canViewDemographics: e.target.checked,
                  }))
                }
                disabled={!selectedPatient?.id}
              />
              Demographics (name, contact, DOB)
            </label>
            <label className="checkbox receptionist-scope-row">
              <input
                type="checkbox"
                checked={Boolean(receptionGrantDraft.canViewAppointments)}
                onChange={(e) =>
                  setReceptionGrantDraft((s) => ({
                    ...s,
                    canViewAppointments: e.target.checked,
                  }))
                }
                disabled={!selectedPatient?.id}
              />
              Appointment workflow
            </label>
            <label className="checkbox receptionist-scope-row">
              <input
                type="checkbox"
                checked={Boolean(receptionGrantDraft.canViewPrivateNotes)}
                onChange={(e) =>
                  setReceptionGrantDraft((s) => ({
                    ...s,
                    canViewPrivateNotes: e.target.checked,
                  }))
                }
                disabled={!selectedPatient?.id}
              />
              Doctor private notes
            </label>
            <label className="checkbox receptionist-scope-row">
              <input
                type="checkbox"
                checked={Boolean(receptionGrantDraft.canViewPrescriptions)}
                onChange={(e) =>
                  setReceptionGrantDraft((s) => ({
                    ...s,
                    canViewPrescriptions: e.target.checked,
                  }))
                }
                disabled={!selectedPatient?.id}
              />
              Prescription summary
            </label>
            <button className="primary" type="button" onClick={saveReceptionAccess} disabled={!selectedPatient?.id}>
              Save receptionist access
            </button>
          </div>
          <div className="note-list receptionist-access-list">
            {(receptionAccess || []).map((entry) => (
              <article key={entry.id} className="note-item receptionist-access-item">
                <div className="queue-title">
                  [{entry.receptionistPlatformStaffId || "No-ID"}] {entry.receptionistName}
                </div>
                <div className="meta">
                  Demographics: {entry.scopes?.canViewDemographics ? "Yes" : "No"} | Appointments:{" "}
                  {entry.scopes?.canViewAppointments ? "Yes" : "No"} | Private notes:{" "}
                  {entry.scopes?.canViewPrivateNotes ? "Yes" : "No"} | Prescriptions:{" "}
                  {entry.scopes?.canViewPrescriptions ? "Yes" : "No"}
                </div>
                <div className="form-row">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() =>
                      setReceptionGrantDraft({
                        receptionistId: entry.receptionistId,
                        canViewDemographics: Boolean(entry.scopes?.canViewDemographics),
                        canViewAppointments: Boolean(entry.scopes?.canViewAppointments),
                        canViewPrivateNotes: Boolean(entry.scopes?.canViewPrivateNotes),
                        canViewPrescriptions: Boolean(entry.scopes?.canViewPrescriptions),
                      })
                    }
                  >
                    Load into form
                  </button>
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => revokeReceptionAccess(entry.receptionistId)}
                  >
                    Revoke
                  </button>
                </div>
              </article>
            ))}
            {!selectedPatient?.id ? (
              <div className="meta">Select a patient to configure receptionist access.</div>
            ) : null}
            {selectedPatient?.id && !receptionists.length ? (
              <div className="meta">
                No receptionists found. Enroll a receptionist above to populate this selector.
              </div>
            ) : null}
            {selectedPatient?.id && !receptionAccess.length ? (
              <div className="meta">No receptionist access grants for this patient yet.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div className="doctor-summary" data-module="patient-comms">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Refill Requests Queue</h3>
            <button className="ghost" type="button" onClick={loadRefillRequests}>
              Refresh
            </button>
          </div>
          <div className="note-list">
            {refillRequests.slice(0, 12).map((entry) => (
              <div key={entry.id} className="note-item">
                <div className="queue-title">Prescription {entry.prescId}</div>
                <div className="meta">{entry.status} | {entry.reason || "No reason"}</div>
                {entry.status === "pending" ? (
                  <div className="form-row">
                    <button className="primary" type="button" onClick={() => decideRefillRequest(entry.id, "approved")}>
                      Approve
                    </button>
                    <button className="ghost" type="button" onClick={() => decideRefillRequest(entry.id, "rejected")}>
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {!refillRequests.length ? <div className="meta">No refill requests yet.</div> : null}
          </div>
        </article>
      </div>

      <div id="patients" className="doctor-summary" data-module="patients">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Patient Search</h3>
          </div>
          <div className="form-inline">
            <div className="inline-input">
              <input
                placeholder="Search by patient name, email, TRN, or ID"
                value={searchQuery}
                onChange={(e) => onPatientInput(e.target.value)}
              />
            </div>
          </div>
          <div className="doctor-list">
            {patients.map((patient) => (
              <button
                key={patient.id}
                className="doctor-list-item doctor-list-button"
                onClick={() => openPatientRecordModal(patient)}
              >
                <div>
                  <div className="doctor-list-title">{patient.fullName}</div>
                  <div className="meta">{patient.email || patient.phone || "No contact"}</div>
                </div>
                <span className="doctor-pill">
                  {loadingPatientRecordId === String(patient.id) ? "Opening..." : "Open record"}
                </span>
              </button>
            ))}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Add Patient</h3>
          </div>
          <form className="form" onSubmit={createPatient}>
            <label>
              Full name
              <input
                value={patientForm.fullName}
                onChange={(e) => setPatientForm((s) => ({ ...s, fullName: e.target.value }))}
              />
            </label>
            <label>
              Email (login)
              <input
                type="email"
                value={patientForm.email}
                onChange={(e) => setPatientForm((s) => ({ ...s, email: e.target.value }))}
              />
            </label>
            <label>
              Temporary password
              <input
                value={patientForm.password}
                onChange={(e) => setPatientForm((s) => ({ ...s, password: e.target.value }))}
              />
            </label>
            <div className="form-row">
              <label>
                DOB
                <input
                  type="date"
                  value={patientForm.dob}
                  onChange={(e) => setPatientForm((s) => ({ ...s, dob: e.target.value }))}
                />
              </label>
              <label>
                Phone
                <input
                  value={patientForm.phone}
                  onChange={(e) => setPatientForm((s) => ({ ...s, phone: e.target.value }))}
                />
              </label>
            </div>
            <label>
              Address
              <input
                value={patientForm.address}
                onChange={(e) => setPatientForm((s) => ({ ...s, address: e.target.value }))}
              />
            </label>
            <label>
              Allergies (comma separated)
              <input
                value={patientForm.allergies}
                onChange={(e) => setPatientForm((s) => ({ ...s, allergies: e.target.value }))}
                placeholder="penicillin, aspirin"
              />
            </label>
            <div className="form-row">
              <label>
                Government ID
                <input
                  value={patientForm.idNumber}
                  onChange={(e) => setPatientForm((s) => ({ ...s, idNumber: e.target.value }))}
                />
              </label>
              <label>
                TRN
                <input
                  value={patientForm.trn}
                  onChange={(e) => setPatientForm((s) => ({ ...s, trn: e.target.value }))}
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Emergency contact name
                <input
                  value={patientForm.emergencyContactName}
                  onChange={(e) =>
                    setPatientForm((s) => ({ ...s, emergencyContactName: e.target.value }))
                  }
                />
              </label>
              <label>
                Emergency contact phone
                <input
                  value={patientForm.emergencyContactPhone}
                  onChange={(e) =>
                    setPatientForm((s) => ({ ...s, emergencyContactPhone: e.target.value }))
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Weight (kg)
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={patientForm.weightKg}
                  onChange={(e) => setPatientForm((s) => ({ ...s, weightKg: e.target.value }))}
                />
              </label>
              <label>
                Weight (lbs)
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={patientForm.weightLbs}
                  onChange={(e) => setPatientForm((s) => ({ ...s, weightLbs: e.target.value }))}
                />
              </label>
            </div>
            <button className="primary" type="submit">
              Create patient
            </button>
          </form>
          {createdPatient ? (
            <div className="notice">
              Patient created: {createdPatient.patient.fullName}
              <br />
              Login email: {createdPatient.credentialsIssued.email}
              <br />
              Temp password: {createdPatient.credentialsIssued.temporaryPassword}
            </div>
          ) : null}
        </article>
      </div>

      <div id="prescriptions" className="doctor-summary" data-module="prescriptions">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Create Prescription</h3>
          </div>
          <div className="meta">
            Selected patient: {selectedPatient ? selectedPatient.fullName : "None selected"}
          </div>
          <div className="meta">
            Guardrails active: dose range by age/weight, duplicate therapy detection, and controlled-substance hard stops.
          </div>
          <form className="form" onSubmit={createPrescription}>
            <div className="form-row">
              <label>
                Patient
                <select
                  value={selectedPatient?.id || ""}
                  onChange={(e) => selectCurrentPatientById(e.target.value)}
                >
                  <option value="">Select patient</option>
                  {patients.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.fullName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                Quick template
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                >
                  <option value="">Select template</option>
                  {prescriptionTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} ({template.source})
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions-inline">
                <button
                  type="button"
                  className="ghost"
                  onClick={applyTemplate}
                  disabled={!selectedTemplateId}
                >
                  Apply template
                </button>
                <button type="button" className="ghost" onClick={saveCurrentAsFavorite}>
                  Save favorite
                </button>
              </div>
            </div>
            {favoriteMeds.length ? (
              <div className="doctor-favorites-row">
                {favoriteMeds.slice(0, 8).map((favorite) => (
                  <button
                    key={favorite.id}
                    type="button"
                    className="doctor-date-chip doctor-date-chip--available"
                    onClick={() => applyFavoriteMed(favorite)}
                  >
                    {favorite.name} {favorite.strength}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="form-row">
              <label>
                Diagnosis
                <input
                  value={prescriptionForm.diagnosis}
                  onChange={(e) => onDiagnosisInput(e.target.value)}
                  placeholder="e.g. Hypertension, Type 2 diabetes"
                />
                {diagnosisSuggestions.length ? (
                  <div className="search-results">
                    {diagnosisSuggestions.map((entry) => (
                      <button
                        key={entry.diagnosisKey}
                        type="button"
                        className="search-item"
                        onClick={() => pickDiagnosisSuggestion(entry)}
                      >
                        <span className="search-name">
                          {entry.diagnosisLabel}
                          {entry.diagnosisCode ? ` (${entry.diagnosisCode})` : ""}
                        </span>
                        <span className="search-pill">{entry.mappingCount} mapped meds</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </label>
              <label>
                Patient weight (kg)
                <input
                  type="number"
                  min="1"
                  step="0.1"
                  value={prescriptionForm.patientWeightKg}
                  onChange={(e) =>
                    setPrescriptionForm((s) => ({ ...s, patientWeightKg: e.target.value }))
                  }
                  placeholder="Auto-loaded from patient profile when available"
                />
                <div className="meta">
                  {record?.patient?.weightLbs
                    ? `Patient profile weight: ${record.patient.weightLbs} lbs`
                    : "No weight in patient profile yet"}
                </div>
              </label>
            </div>
            {diagnosisMappings.length ? (
              <div className="doctor-favorites-row">
                {diagnosisMappings.map((mapping) => (
                  <button
                    key={mapping.id}
                    type="button"
                    className="doctor-date-chip doctor-date-chip--available"
                    onClick={() => applyDiagnosisMedicationMapping(mapping)}
                  >
                    {mapping.medication?.name}
                    {mapping.medication?.defaultStrength
                      ? ` ${mapping.medication.defaultStrength}`
                      : ""}
                  </button>
                ))}
              </div>
            ) : null}
            {selectedDiagnosisSuggestion ? (
              <div className="meta">
                Catalog source: {selectedDiagnosisSuggestion.diagnosisLabel}
                {selectedDiagnosisSuggestion.diagnosisCode
                  ? ` (${selectedDiagnosisSuggestion.diagnosisCode})`
                  : ""}{" "}
                approved by MOH
              </div>
            ) : null}
            <div className="form-row">
              <label>
                Medication (MOH approved only)
                <input
                  value={drugQuery}
                  onChange={(e) => onDrugInput(e.target.value)}
                  placeholder="Type drug name or code"
                />
                {drugResults.length ? (
                  <div className="search-results">
                    {drugResults.map((drug) => (
                      <button
                        type="button"
                        key={drug.code}
                        className="search-item"
                        onClick={() => pickDrug(drug)}
                      >
                        <span className="search-name">
                          {drug.name} ({drug.code})
                        </span>
                        <span className="search-pill">{drug.medicationType}</span>
                        {drug.controlledSubstance ? (
                          <span className="warning-badge warning-badge--high">Controlled</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </label>
              <label>
                Strength
                <select
                  value={prescriptionForm.strength}
                  onChange={(e) =>
                    setPrescriptionForm((s) => ({ ...s, strength: e.target.value }))
                  }
                  disabled={!selectedDrug}
                >
                  <option value="">Select strength</option>
                  {(selectedDrug?.strengths || []).map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Qty
                <input
                  type="number"
                  value={prescriptionForm.qty}
                  onChange={(e) => setPrescriptionForm((s) => ({ ...s, qty: e.target.value }))}
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Medication type
                <input value={selectedDrug?.medicationType || ""} readOnly />
              </label>
              <label>
                Used for
                <input value={selectedDrug?.usedFor || ""} readOnly />
              </label>
            </div>
            {selectedDrug?.controlledSubstance ? (
              <label>
                Controlled substance justification (required)
                <textarea
                  value={prescriptionForm.controlledSubstanceJustification}
                  onChange={(e) =>
                    setPrescriptionForm((s) => ({
                      ...s,
                      controlledSubstanceJustification: e.target.value,
                    }))
                  }
                  placeholder="Clinical justification for controlled substance prescription"
                />
              </label>
            ) : null}
            <div className="form-row">
              <label>
                Allowed refills
                <input
                  type="number"
                  value={prescriptionForm.allowedRefills}
                  onChange={(e) =>
                    setPrescriptionForm((s) => ({ ...s, allowedRefills: e.target.value }))
                  }
                />
              </label>
              <label>
                Expiry date
                <input
                  type="date"
                  value={prescriptionForm.expiryDate}
                  onChange={(e) =>
                    setPrescriptionForm((s) => ({ ...s, expiryDate: e.target.value }))
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Save as template name
                <input
                  value={templateNameDraft}
                  onChange={(e) => setTemplateNameDraft(e.target.value)}
                  placeholder="e.g. HTN - Amlodipine starter"
                />
              </label>
              <label>
                Template notes
                <input
                  value={templateNotesDraft}
                  onChange={(e) => setTemplateNotesDraft(e.target.value)}
                  placeholder="Optional notes for template"
                />
              </label>
              <button
                className="ghost"
                type="button"
                onClick={saveCurrentAsTemplate}
                disabled={!selectedDrug || !templateNameDraft.trim()}
              >
                Save template
              </button>
            </div>
            <button
              className="primary"
              type="submit"
              disabled={
                !selectedPatient ||
                !selectedDrug ||
                !prescriptionForm.strength ||
                (selectedDrug?.controlledSubstance &&
                  prescriptionForm.controlledSubstanceJustification.trim().length < 15)
              }
            >
              Create prescription
            </button>
          </form>
          {safetyWarnings.length ? (
            <div className="notice">
              <strong>Prescription safety review</strong>
              <div className="note-list">
                {safetyWarnings.map((warning, index) => (
                  <div key={`${warning.type}-${index}`} className="note-item">
                    <div className="queue-title warning-title">
                      <span
                        className={`warning-badge warning-badge--${String(
                          warning.severity || "info"
                        ).toLowerCase()}`}
                      >
                        {String(warning.severity || "info").toUpperCase()}
                      </span>
                      {warning.hardStop ? (
                        <span className="warning-badge warning-badge--hardstop">HARD STOP</span>
                      ) : null}
                      <span>{warning.type}</span>
                    </div>
                    <div className="meta">{warning.message}</div>
                  </div>
                ))}
              </div>
              {!safetyWarnings.some((warning) => warning.hardStop) ? (
                <div className="form-row">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => submitPrescription({ overrideSafety: true })}
                  >
                    Override and create anyway
                  </button>
                </div>
              ) : (
                <div className="meta">
                  Hard-stop rule active. Remove the interacting medication to continue.
                </div>
              )}
            </div>
          ) : null}
          {result ? (
            <div className="notice">
              Created prescription: {result.prescription.id}
              <br />
              Doctor: {result.doctor?.name || result.prescription.doctorName || "N/A"} (
              {result.doctor?.id || result.prescription.doctorId || "N/A"})
              <br />
              Link code: {result.linkCode}
              <br />
              Refill amount: {Number(result.prescription.allowedRefills || 0)}
              {result.qrDataUrl ? (
                <div className="qr-panel">
                  <img className="qr-image" src={result.qrDataUrl} alt="Prescription QR" />
                </div>
              ) : null}
              <div className="form-row">
                <button type="button" className="primary" onClick={openWhatsAppShare}>
                  Send via WhatsApp
                </button>
                <button type="button" className="primary" onClick={openEmailShare}>
                  Send via Email
                </button>
                <button type="button" className="ghost" onClick={copyQrPayload}>
                  Copy QR Payload
                </button>
              </div>
              {result.patientShare?.text ? (
                <pre className="notice">{result.patientShare.text}</pre>
              ) : null}
            </div>
          ) : null}
          <div className="form-row">
            <button className="ghost" type="button" onClick={generateFollowUpPlan}>
              One-click follow-up plan
            </button>
          </div>
          {followUpPlan ? (
            <div className="notice">
              <strong>Follow-up Plan</strong>
              <pre className="notice">{followUpPlan.text}</pre>
            </div>
          ) : null}
          <div className="qr-scan-panel">
            <div className="qr-scan-header">
              <strong>Doctor QR Scanner</strong>
              <div className="form-row">
                <button className="primary" type="button" onClick={startDoctorScan}>
                  Start scan
                </button>
                <button className="ghost" type="button" onClick={stopDoctorScan}>
                  Stop scan
                </button>
              </div>
            </div>
            <video ref={doctorScannerVideoRef} className="qr-video" muted playsInline />
            {doctorScanStatus ? <div className="meta">{doctorScanStatus}</div> : null}
            <label>
              QR content (scan/paste)
              <textarea
                value={doctorQrContent}
                onChange={(event) => setDoctorQrContent(event.target.value)}
                placeholder="Scanned prescription QR payload"
              />
            </label>
            <button className="primary" type="button" onClick={verifyDoctorScannedPrescription}>
              Verify scanned prescription
            </button>
            {verifiedScannedPrescription ? (
              <div className="notice">
                <strong>Scanned Prescription Details</strong>
                <br />
                ID: {verifiedScannedPrescription.id}
                <br />
                Doctor: {verifiedScannedPrescription.doctorName || "N/A"} (
                {verifiedScannedPrescription.doctorId || "N/A"})
                <br />
                Patient: {verifiedScannedPrescription.patientFullName || "N/A"}
                <br />
                Refill amount: {Number(verifiedScannedPrescription.allowedRefills || 0)}
                <br />
                Expiry: {verifiedScannedPrescription.expiryDate || "N/A"}
                <br />
                Meds:{" "}
                {(verifiedScannedPrescription.meds || [])
                  .map((med) => `${med.name} ${med.strength} x${med.qty}`)
                  .join(", ")}
              </div>
            ) : null}
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Patient Record</h3>
          </div>
          {record ? (
            <div className="modal-list">
              <div className="modal-list-item">
                <strong>{record.patient.fullName}</strong>
                <div className="meta">
                  {record.patient.email} | {record.patient.phone}
                </div>
                <div className="meta">DOB: {record.patient.dob || "n/a"}</div>
                <div className="meta">ID: {record.patient.idNumber || "n/a"}</div>
                <div className="meta">TRN: {record.patient.trn || "n/a"}</div>
                <div className="meta">Address: {record.patient.address || "n/a"}</div>
                <div className="meta">
                  Weight: {record.patient.weightKg || "n/a"} kg | {record.patient.weightLbs || "n/a"} lbs
                </div>
                <div className="meta">
                  Allergies: {(record.patient.allergies || []).length
                    ? record.patient.allergies.join(", ")
                    : "none recorded"}
                </div>
              </div>
              <div className="modal-list-item">
                <strong>Edit Patient Details</strong>
                <div className="form">
                  <div className="form-row">
                    <label>
                      Full name
                      <input
                        value={patientEditForm.fullName}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, fullName: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Email
                      <input
                        type="email"
                        value={patientEditForm.email}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, email: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      DOB
                      <input
                        type="date"
                        value={patientEditForm.dob}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, dob: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Phone
                      <input
                        value={patientEditForm.phone}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, phone: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Address
                    <input
                      value={patientEditForm.address}
                      onChange={(e) =>
                        setPatientEditForm((s) => ({ ...s, address: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Allergies (comma separated)
                    <input
                      value={patientEditForm.allergies}
                      onChange={(e) =>
                        setPatientEditForm((s) => ({ ...s, allergies: e.target.value }))
                      }
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      Government ID
                      <input
                        value={patientEditForm.idNumber}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, idNumber: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      TRN
                      <input
                        value={patientEditForm.trn}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, trn: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Emergency contact name
                      <input
                        value={patientEditForm.emergencyContactName}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({
                            ...s,
                            emergencyContactName: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Emergency contact phone
                      <input
                        value={patientEditForm.emergencyContactPhone}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({
                            ...s,
                            emergencyContactPhone: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Weight (kg)
                      <input
                        type="number"
                        min="1"
                        step="0.1"
                        value={patientEditForm.weightKg}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, weightKg: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Weight (lbs)
                      <input
                        type="number"
                        min="1"
                        step="0.1"
                        value={patientEditForm.weightLbs}
                        onChange={(e) =>
                          setPatientEditForm((s) => ({ ...s, weightLbs: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <button className="primary" type="button" onClick={savePatientDetails}>
                    Save patient details
                  </button>
                </div>
              </div>
              <div className="modal-list-item">
                <strong>Prescription History</strong>
                {(record.prescriptions || []).length ? (
                  <div className="note-list">
                    {record.prescriptions.map((entry) => (
                      <div className="note-item" key={entry.id}>
                        <div className="meta">{entry.id}</div>
                        <div className="note-text">
                          {(entry.meds || []).map((med) => med.name).join(", ")}
                          {" | Refill amount: "}
                          {Number(entry.allowedRefills || 0)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="meta">No prescriptions yet.</div>
                )}
              </div>
              <div className="modal-list-item">
                <strong>Order History</strong>
                {(record.orders || []).length ? (
                  <div className="note-list">
                    {record.orders.map((order) => (
                      <div className="note-item" key={order.id}>
                        <div className="meta">
                          {order.id} - {order.orderStatus}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="meta">No orders yet.</div>
                )}
              </div>
              <div className="modal-list-item">
                <strong>Patient Timeline Indicators</strong>
                <div className="meta">
                  Last seen: {patientIndicators.lastSeenAt
                    ? new Date(patientIndicators.lastSeenAt).toLocaleString()
                    : "No encounter yet"}
                </div>
                <div className="meta">
                  Next due: {patientIndicators.nextDueAt
                    ? new Date(patientIndicators.nextDueAt).toLocaleString()
                    : "No upcoming due item"}
                </div>
                {(patientRiskFlags || []).length ? (
                  <div className="doctor-favorites-row">
                    {patientRiskFlags.map((flag, idx) => (
                      <span
                        key={`${flag.type}-${idx}`}
                        className={`warning-badge warning-badge--${String(flag.severity || "moderate").toLowerCase()}`}
                      >
                        {flag.type}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="meta">No active risk flags.</div>
                )}
              </div>
              <div className="modal-list-item">
                <strong>Unified Timeline</strong>
                {patientTimeline.length ? (
                  <div className="note-list">
                    {patientTimeline.slice(0, 30).map((entry, idx) => (
                      <div className="note-item" key={`${entry.type}-${entry.timestamp}-${idx}`}>
                        <div className="queue-title">
                          {entry.type} | {entry.status || "n/a"}
                        </div>
                        <div className="meta">{new Date(entry.timestamp).toLocaleString()}</div>
                        {entry.reason ? <div className="meta">Reason: {entry.reason}</div> : null}
                        {entry.preview ? <div className="meta">Chat: {entry.preview}</div> : null}
                        {entry.message ? <div className="meta">{entry.message}</div> : null}
                        {entry.triageTags?.length ? (
                          <div className="meta">Tags: {entry.triageTags.join(", ")}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="meta">No timeline events loaded.</div>
                )}
              </div>
            </div>
          ) : (
            <p className="meta">Select a patient to load full record.</p>
          )}
        </article>
      </div>

      <div className="status">
        <div>
          <h4>Pending connection requests</h4>
        </div>
        <button className="primary" onClick={loadPending}>
          Refresh
        </button>
      </div>
      <div className="queue">
        {requests.map((request) => (
          <article className="queue-card" key={request.id}>
            <div>
              <div className="queue-title">{request.patientName || request.patientId}</div>
              <div className="queue-meta">
                status: {request.status} | patient id: {request.patientId}
              </div>
              {request.patientEmail ? <div className="queue-meta">email: {request.patientEmail}</div> : null}
            </div>
            <button className="primary" onClick={() => approve(request.id)}>
              Approve
            </button>
          </article>
        ))}
        {!requests.length ? <div className="meta">No pending connection requests.</div> : null}
      </div>

      <div
        id="appointments"
        className="doctor-summary appointments-summary"
        data-module="appointments"
      >
        <article className="doctor-card appointments-calendar-card">
          <div className="doctor-card-header">
            <h3>Appointments Calendar</h3>
            <button className="primary" type="button" onClick={() => {
              loadAvailability();
              loadBookings();
            }}>
              Refresh
            </button>
          </div>
          <div className="calendar-month-nav">
            <button type="button" className="ghost" onClick={() => shiftCalendarMonth(-1)}>
              Prev
            </button>
            <div className="calendar-month-title">{formatMonthTitle(calendarMonth)}</div>
            <button type="button" className="ghost" onClick={() => shiftCalendarMonth(1)}>
              Next
            </button>
          </div>
          <div className="calendar-shell">
            <div className="calendar-weekdays">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="calendar-weekday">
                  {label}
                </div>
              ))}
            </div>
            <div className="calendar-month-grid">
              {calendarCells.map((cell) => {
                if (cell.empty) {
                  return <div key={cell.key} className="calendar-day calendar-day--empty" />;
                }

                const classes = ["calendar-day", "calendar-day-button"];
              if (cell.key === selectedDateKey) {
                classes.push("calendar-day--selected");
              }
              if (cell.key === todayDateKey) {
                classes.push("calendar-day--today");
              }
              if (cell.stats.completed > 0) {
                classes.push("calendar-day--completed");
                } else if (cell.stats.booked > 0) {
                  classes.push("calendar-day--booked");
                } else if (cell.stats.available > 0) {
                  classes.push("calendar-day--available");
                }

                return (
                  <div
                    key={cell.key}
                    className={classes.join(" ")}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectCalendarDate(cell.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectCalendarDate(cell.key);
                      return;
                    }
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      navigateCalendarByDays(cell.key, -1);
                      return;
                    }
                    if (event.key === "ArrowRight") {
                      event.preventDefault();
                      navigateCalendarByDays(cell.key, 1);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      navigateCalendarByDays(cell.key, -7);
                      return;
                    }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      navigateCalendarByDays(cell.key, 7);
                      return;
                    }
                    if (event.key === "Home") {
                      event.preventDefault();
                      navigateCalendarWithinWeek(cell.key, "start");
                      return;
                    }
                    if (event.key === "End") {
                      event.preventDefault();
                      navigateCalendarWithinWeek(cell.key, "end");
                    }
                  }}
                >
                    <div className="calendar-day-header">
                      <span className="calendar-day-number">{cell.dayNumber}</span>
                      <button
                        type="button"
                        className="calendar-info-icon"
                        aria-label={`Open information for ${cell.key}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          openDateInformation(cell.key);
                        }}
                      >
                        i
                      </button>
                    </div>
                    <div className="calendar-counts">
                      <span className="calendar-badge calendar-badge--available">
                        A: {cell.stats.available}
                      </span>
                      <span className="calendar-badge calendar-badge--booked">
                        B: {cell.stats.booked}
                      </span>
                      <span className="calendar-badge calendar-badge--completed">
                        C: {cell.stats.completed}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="calendar-selected-summary">
            <span className="doctor-date-chip doctor-date-chip--available">
              Date: {selectedDateKey || "None"}
            </span>
            <span className="doctor-date-chip doctor-date-chip--available">
              Available: {selectedDayStats.available}
            </span>
            <span className="doctor-date-chip doctor-date-chip--pending">
              Booked: {selectedDayStats.booked}
            </span>
            <span className="doctor-date-chip doctor-date-chip--approved">
              Completed: {selectedDayStats.completed}
            </span>
          </div>
          <div className="meta">Legend: A = availability slots, B = active bookings, C = completed appointments.</div>
        </article>

        <article className="doctor-card appointments-side-card">
          <div className="doctor-card-header">
            <h3>Set Availability</h3>
          </div>
          <form className="form" onSubmit={createAvailability}>
            <div className="form-row">
              <label>
                Start
                <input
                  type="datetime-local"
                  value={availabilityForm.startAt}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, startAt: e.target.value }))
                  }
                />
              </label>
              <label>
                End
                <input
                  type="datetime-local"
                  value={availabilityForm.endAt}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, endAt: e.target.value }))
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Mode
                <select
                  value={availabilityForm.mode}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, mode: e.target.value }))
                  }
                >
                  <option value="in-person">In-person</option>
                  <option value="virtual">Virtual</option>
                </select>
              </label>
              <label>
                Location
                <input
                  value={availabilityForm.location}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, location: e.target.value }))
                  }
                />
              </label>
              <label>
                Max bookings
                <input
                  type="number"
                  min="1"
                  value={availabilityForm.maxBookings}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, maxBookings: Number(e.target.value) }))
                  }
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(availabilityForm.feeRequired)}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, feeRequired: e.target.checked }))
                  }
                />
                Fee required
              </label>
              <label>
                Fee amount
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={availabilityForm.feeAmount}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, feeAmount: Number(e.target.value || 0) }))
                  }
                />
              </label>
              <label>
                Currency
                <select
                  value={availabilityForm.feeCurrency}
                  onChange={(e) =>
                    setAvailabilityForm((s) => ({ ...s, feeCurrency: e.target.value }))
                  }
                >
                  <option value="JMD">JMD</option>
                  <option value="USD">USD</option>
                </select>
              </label>
            </div>
            <button className="primary" type="submit">
              Add availability slot
            </button>
          </form>
          <div className="queue">
            {selectedDayAvailability.map((slot) => (
              <article key={slot.id} className="queue-card">
                <div>
                  <div className="queue-title">
                    {new Date(slot.startAt).toLocaleString()} -{" "}
                    {new Date(slot.endAt).toLocaleString()}
                  </div>
                  <div className="queue-meta">
                    {slot.mode} | {slot.location || "No location"} | max {slot.maxBookings}
                    {" | "}
                    fee: {slot.feeRequired ? `${slot.feeCurrency || "JMD"} ${Number(slot.feeAmount || 0).toFixed(2)}` : "none"}
                  </div>
                </div>
                <button
                  className="ghost"
                  type="button"
                  onClick={() => deactivateAvailability(slot.id)}
                  disabled={slot.isActive === false}
                >
                  {slot.isActive === false ? "Inactive" : "Deactivate"}
                </button>
              </article>
            ))}
            {!selectedDayAvailability.length ? (
              <div className="meta">No slots for selected date.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div className="doctor-summary" data-module="appointments">
        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Patient Appointment Requests</h3>
            <button className="primary" type="button" onClick={loadBookings}>
              Refresh requests
            </button>
          </div>
          <div className="meta">Showing bookings for: {selectedDateKey || "No selected date"}</div>
          <div className="queue">
            {selectedDayBookings.map((booking) => (
              <article key={booking.id} className="queue-card">
                <div>
                  <div className="queue-title">
                    {booking.patientName || booking.patientId} ({booking.status})
                  </div>
                  {booking.status === "approved" ? (
                    <button
                      type="button"
                      className="doctor-inline-badge-cta"
                      onClick={() => focusVisitCharge(booking.id)}
                    >
                      In-room Billing
                    </button>
                  ) : null}
                  <div className="queue-meta">
                    {new Date(booking.startAt).toLocaleString()} -{" "}
                    {new Date(booking.endAt).toLocaleString()}
                  </div>
                  <div className="queue-meta">
                    {booking.mode} | {booking.location || "No location"} | reason:{" "}
                    {booking.reason || "n/a"}
                  </div>
                  <div className="queue-meta">
                    Triage: {(booking.triageTags || []).length
                      ? booking.triageTags.join(", ")
                      : "routine"}
                  </div>
                  <div className="queue-meta">
                    Billing: {booking.feeCurrency || "JMD"} {Number(booking.feeAmount || 0).toFixed(2)} | NHF:{" "}
                    {booking.feeCurrency || "JMD"} {Number(booking.nhfDeductionAmount || 0).toFixed(2)} | Ready:{" "}
                    {booking.billingReadyForCollection ? "Yes" : "No"}
                  </div>
                  <div className="queue-meta">
                    Sent to reception:{" "}
                    {booking.receptionHandoffAt ? new Date(booking.receptionHandoffAt).toLocaleString() : "Not sent"}
                  </div>
                  <div className="doctor-reminder-panel">
                    <div className="doctor-reminder-grid">
                      <label>
                        Consultation fee
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={getVisitChargeDraft(booking).consultationFee}
                          ref={(el) => {
                            if (el) visitChargeInputRefs.current[booking.id] = el;
                          }}
                          onChange={(e) =>
                            updateVisitChargeDraft(booking.id, {
                              consultationFee: Number(e.target.value || 0),
                            })
                          }
                        />
                      </label>
                      <label>
                        Additional charges
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={getVisitChargeDraft(booking).additionalCharges}
                          onChange={(e) =>
                            updateVisitChargeDraft(booking.id, {
                              additionalCharges: Number(e.target.value || 0),
                            })
                          }
                        />
                      </label>
                      <label>
                        NHF deduction
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={getVisitChargeDraft(booking).nhfDeductionAmount}
                          onChange={(e) =>
                            updateVisitChargeDraft(booking.id, {
                              nhfDeductionAmount: Number(e.target.value || 0),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="doctor-reminder-grid">
                      <label>
                        Currency
                        <select
                          value={getVisitChargeDraft(booking).feeCurrency}
                          onChange={(e) =>
                            updateVisitChargeDraft(booking.id, {
                              feeCurrency: e.target.value,
                            })
                          }
                        >
                          <option value="JMD">JMD</option>
                          <option value="USD">USD</option>
                        </select>
                      </label>
                      <label>
                        Charge notes
                        <input
                          value={getVisitChargeDraft(booking).chargeNotes}
                          onChange={(e) =>
                            updateVisitChargeDraft(booking.id, {
                              chargeNotes: e.target.value,
                            })
                          }
                          placeholder="Billing notes for front desk"
                        />
                      </label>
                    </div>
                    <div className="form-row">
                      <button className="ghost" type="button" onClick={() => saveVisitCharge(booking)}>
                        Save charges for reception
                      </button>
                      {booking.status === "approved" ? (
                        <button
                          className="primary"
                          type="button"
                          onClick={() => saveVisitCharge(booking, { completeAfterSave: true })}
                        >
                          Complete + send to reception
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  {["approved", "completed"].includes(String(booking.status || "").toLowerCase()) ? (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => sendBookingToReception(booking)}
                    >
                      {booking.receptionHandoffAt ? "Resend to receptionist" : "Send to receptionist"}
                    </button>
                  ) : null}
                  {booking.status === "pending" ? (
                    <>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => decideBooking(booking.id, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => decideBooking(booking.id, "rejected")}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {booking.status === "approved" ? (
                    <>
                      <button
                        className="primary"
                        type="button"
                        onClick={() => decideBooking(booking.id, "completed")}
                      >
                        Mark completed
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        onClick={() => decideBooking(booking.id, "no_show")}
                      >
                        Mark no-show
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
            {!selectedDayBookings.length ? (
              <div className="meta">No bookings for selected date.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div className="doctor-summary" data-module="appointments">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Appointment Intelligence</h3>
            <div className="form-row">
              <button className="ghost" type="button" onClick={loadAppointmentIntelligence}>
                Refresh intelligence
              </button>
              <button className="primary" type="button" onClick={autoFillWaitlist}>
                Waitlist auto-fill
              </button>
            </div>
          </div>
          <div className="meta">Waitlist size: {appointmentIntel.waitlistCount || 0}</div>
          {waitlistAutoFillResult ? (
            <div className="meta">
              Last auto-fill: {waitlistAutoFillResult.filledCount || 0} booking(s) created
            </div>
          ) : null}
          <div className="note-list">
            {(appointmentIntel.overbookSuggestions || []).map((suggestion) => (
              <div key={suggestion.availabilityId} className="note-item">
                <div className="queue-title">Overbook suggestion</div>
                <div className="meta">
                  {new Date(suggestion.startAt).toLocaleString()} | add {suggestion.overbookBy}
                </div>
                <div className="meta">{suggestion.reason}</div>
              </div>
            ))}
            {!appointmentIntel.overbookSuggestions?.length ? (
              <div className="meta">No overbook suggestions at this time.</div>
            ) : null}
          </div>
          <div className="note-list">
            {(appointmentIntel.predictions || []).slice(0, 10).map((prediction) => (
              <div key={prediction.bookingId} className="note-item">
                <div className="queue-title">
                  {prediction.patientName} | No-show risk:{" "}
                  {Math.round(Number(prediction.noShowRiskScore || 0) * 100)}%
                </div>
                <div className="meta">{new Date(prediction.startAt).toLocaleString()}</div>
                <div className="meta">
                  Tags: {(prediction.triageTags || []).length
                    ? prediction.triageTags.join(", ")
                    : "routine"}
                </div>
                {prediction.riskReasons?.length ? (
                  <div className="meta">Signals: {prediction.riskReasons.join(", ")}</div>
                ) : null}
              </div>
            ))}
            {!appointmentIntel.predictions?.length ? (
              <div className="meta">No predictions available yet.</div>
            ) : null}
          </div>
        </article>
      </div>

      <div id="chat" className="doctor-summary" data-module="chat">
        <article className="doctor-card doctor-card--wide">
          <div className="doctor-card-header">
            <h3>Direct Chat</h3>
            <button className="primary" type="button" onClick={() => setIsChatModalOpen(true)}>
              Open Messaging
            </button>
          </div>
          <div className="doctor-chat-launch">
            <div className="meta">
              Open a focused messaging workspace for patient and pharmacy communication.
            </div>
            <div className="doctor-chat-launch-kpis">
              <span className="doctor-date-chip doctor-date-chip--approved">
                Threads: {chatThreads.length}
              </span>
              <span className="doctor-date-chip doctor-date-chip--available">
                Active: {activeThread ? "Yes" : "No"}
              </span>
              <span className="doctor-date-chip doctor-date-chip--pending">
                Unread: {totalUnreadMessages}
              </span>
            </div>
          </div>
        </article>

        <article className="doctor-card">
          <div className="doctor-card-header">
            <h3>Private Patient Notes</h3>
          </div>
          <div className="meta">
            Visibility: Doctor / Receptionist only.
          </div>
          <div className="form">
            <label>
              Patient
              <select
                value={notesPatientId}
                onChange={(e) => setNotesPatientId(e.target.value)}
              >
                <option value="">Select patient</option>
                {patients.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              New private note
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Clinical observations, follow-up instructions, admin notes..."
              />
            </label>
            <button
              className="primary"
              type="button"
              onClick={savePrivateNote}
              disabled={!notesPatientId || !noteDraft.trim()}
            >
              Save note
            </button>
          </div>
          <div className="note-list">
            {privateNotes.map((note) => (
              <article key={note.id} className="note-item">
                <div className="note-text">{note.text}</div>
                <div className="meta">
                  {new Date(note.createdAt).toLocaleString()} | {note.visibility}
                </div>
              </article>
            ))}
            {!privateNotes.length ? (
              <div className="meta">No private notes yet for selected patient.</div>
            ) : null}
          </div>
        </article>
      </div>

        </div>
      </div>

      {status ? <p className="notice">{status}</p> : null}
      {error ? <p className="notice error">{error}</p> : null}

      {activeModule === "chat" ? (
        <button
          type="button"
          className="doctor-chat-fab"
          aria-label="Open messaging"
          onClick={() => setIsChatModalOpen(true)}
        >
          Chat
        </button>
      ) : null}

      {isPatientRecordModalOpen ? (
        <>
          <button
            type="button"
            className="modal-scrim"
            aria-label="Close patient record"
            onClick={() => setIsPatientRecordModalOpen(false)}
          />
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <article className="modal doctor-patient-record-modal">
              <header className="modal-header">
                <div>
                  <h3>Patient Record</h3>
                  <div className="meta">
                    {record?.patient?.fullName || selectedPatient?.fullName || "Selected patient"}
                  </div>
                </div>
                <div className="form-row">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      navigate("/doctor/prescriptions");
                      setIsPatientRecordModalOpen(false);
                    }}
                  >
                    Open Full Workspace
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setIsPatientRecordModalOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </header>
              <div className="modal-body">
                {record ? (
                  <div className="modal-list">
                    <div className="modal-list-item">
                      <strong>{record.patient?.fullName || "Patient"}</strong>
                      <div className="meta">
                        {record.patient?.email || "n/a"} | {record.patient?.phone || "n/a"}
                      </div>
                      <div className="meta">DOB: {record.patient?.dob || "n/a"}</div>
                      <div className="meta">ID: {record.patient?.idNumber || "n/a"}</div>
                      <div className="meta">TRN: {record.patient?.trn || "n/a"}</div>
                      <div className="meta">Address: {record.patient?.address || "n/a"}</div>
                    </div>
                    <div className="modal-list-item">
                      <strong>Timeline Indicators</strong>
                      <div className="meta">
                        Last seen: {patientIndicators.lastSeenAt
                          ? new Date(patientIndicators.lastSeenAt).toLocaleString()
                          : "No encounter yet"}
                      </div>
                      <div className="meta">
                        Next due: {patientIndicators.nextDueAt
                          ? new Date(patientIndicators.nextDueAt).toLocaleString()
                          : "No upcoming due item"}
                      </div>
                    </div>
                    <div className="modal-list-item">
                      <strong>Recent Prescriptions</strong>
                      {(record.prescriptions || []).slice(0, 5).map((entry) => (
                        <div key={entry.id} className="meta">
                          {entry.id} | Refill amount: {Number(entry.allowedRefills || 0)}
                        </div>
                      ))}
                      {!record.prescriptions?.length ? <div className="meta">No prescriptions yet.</div> : null}
                    </div>
                    <div className="modal-list-item">
                      <strong>Recent Orders</strong>
                      {(record.orders || []).slice(0, 5).map((entry) => (
                        <div key={entry.id} className="meta">
                          {entry.id} | {entry.orderStatus || "n/a"}
                        </div>
                      ))}
                      {!record.orders?.length ? <div className="meta">No orders yet.</div> : null}
                    </div>
                  </div>
                ) : (
                  <div className="meta">No record loaded.</div>
                )}
              </div>
            </article>
          </div>
        </>
      ) : null}

      {isChatModalOpen ? (
        <>
          <button
            type="button"
            className="modal-scrim"
            aria-label="Close messaging"
            onClick={() => setIsChatModalOpen(false)}
          />
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <article className="modal doctor-chat-modal">
              <header className="modal-header">
                <div>
                  <h3>Doctor Messaging</h3>
                  <div className="meta">
                    Active chat:{" "}
                    {activeThread
                      ? `${activeThread.counterpartName || activeThread.counterpartId || "Unknown"}`
                      : "None selected"}
                  </div>
                </div>
                <div className="form-row">
                  <button className="primary" type="button" onClick={loadChatThreads}>
                    Refresh chats
                  </button>
                  <button type="button" className="ghost" onClick={() => setIsChatModalOpen(false)}>
                    Close
                  </button>
                </div>
              </header>
              <div className="modal-body doctor-chat-modal-body">
                <div className="form-row doctor-chat-toolbar">
                  <label>
                    Chat with
                    <select
                      value={chatTargetType}
                      onChange={(e) => setChatTargetType(e.target.value)}
                    >
                      <option value="patient">Patient</option>
                      <option value="pharmacy">Pharmacy</option>
                    </select>
                  </label>
                  {chatTargetType === "patient" ? (
                    <label>
                      Patient
                      <select
                        value={chatTargetPatientId}
                        onChange={(e) => setChatTargetPatientId(e.target.value)}
                      >
                        <option value="">Select patient</option>
                        {patients.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.fullName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label>
                      Pharmacy
                      <select
                        value={chatTargetPharmacyId}
                        onChange={(e) => setChatTargetPharmacyId(e.target.value)}
                      >
                        <option value="">Select pharmacy</option>
                        {pharmacies.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.fullName}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="primary"
                    type="button"
                    onClick={startOrOpenChat}
                    disabled={
                      !user?.id ||
                      (chatTargetType === "patient" &&
                        !(chatTargetPatientId || selectedPatient?.id)) ||
                      (chatTargetType === "pharmacy" && !chatTargetPharmacyId)
                    }
                  >
                    Start / Open Chat
                  </button>
                </div>
                <div className="doctor-chat-layout">
                  <aside className="doctor-chat-threads">
                    <div className="doctor-chat-label">Conversations</div>
                    <div className="queue">
                      {chatThreads.map((thread) => (
                        <button
                          key={thread.id}
                          type="button"
                          className={`patient-record-card ${
                            activeThreadId === thread.id ? "active doctor-chat-thread-active" : ""
                          }`}
                          onClick={() => setActiveThreadId(thread.id)}
                        >
                          <div className="doctor-chat-thread-top">
                            <div className="patient-record-title">
                              {thread.counterpartName || thread.counterpartId || "Unknown"}
                            </div>
                            {Number(thread.unreadCount || 0) > 0 ? (
                              <span className="doctor-chat-unread-badge">
                                {Number(thread.unreadCount)}
                              </span>
                            ) : null}
                          </div>
                          <div className="queue-meta">
                            {thread.threadType === "doctor_pharmacy"
                              ? "Doctor <> Pharmacy"
                              : "Doctor <> Patient"}
                            {thread.lastMessageAt
                              ? ` | ${new Date(thread.lastMessageAt).toLocaleString()}`
                              : ""}
                          </div>
                          <div className="doctor-chat-preview">
                            {thread.lastMessagePreview || "No messages yet."}
                          </div>
                        </button>
                      ))}
                      {!chatThreads.length ? (
                        <div className="meta doctor-chat-empty">No chat threads yet.</div>
                      ) : null}
                    </div>
                  </aside>
                  <section className="doctor-chat-panel">
                    <div className="chat-window doctor-chat-window">
                      {threadMessages.map((msg) => (
                        <div
                          key={msg.id}
                          className={`chat-bubble ${
                            msg.senderId === user?.id
                              ? "chat-patient doctor-chat-outbound"
                              : "chat-office doctor-chat-inbound"
                          }`}
                        >
                          <div>{msg.message}</div>
                          <div className="meta">{new Date(msg.createdAt).toLocaleString()}</div>
                        </div>
                      ))}
                      {!threadMessages.length && activeThreadId ? (
                        <div className="meta">Chat opened. Send the first message.</div>
                      ) : null}
                      {!threadMessages.length && !activeThreadId ? (
                        <div className="meta">No messages yet.</div>
                      ) : null}
                    </div>
                    <div className="form-row chat-form doctor-chat-form">
                      <input
                        value={chatMessageDraft}
                        onChange={(e) => setChatMessageDraft(e.target.value)}
                        placeholder="Type message..."
                      />
                      <button
                        className="primary"
                        type="button"
                        onClick={sendChatMessage}
                        disabled={!activeThreadId || !chatMessageDraft.trim()}
                      >
                        Send
                      </button>
                    </div>
                  </section>
                </div>
              </div>
            </article>
          </div>
        </>
      ) : null}

      {isSymptomReportModalOpen ? (
        <>
          <button
            type="button"
            className="modal-scrim"
            aria-label="Close symptom report details"
            onClick={() => setIsSymptomReportModalOpen(false)}
          />
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <article className="modal doctor-symptom-report-modal">
              <header className="modal-header">
                <div>
                  <h3>Patient Symptom Report</h3>
                  <div className="meta">
                    {activeSymptomReport?.patient?.fullName || "Patient"} |{" "}
                    {activeSymptomReport?.report?.sharedForVirtualDiagnosis
                      ? "Virtual diagnosis requested"
                      : "Review for upcoming visit"}
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setIsSymptomReportModalOpen(false)}
                >
                  Close
                </button>
              </header>
              <div className="modal-body">
                <div className="note-list">
                  <article className="note-item">
                    <div className="queue-title">
                      {activeSymptomReport?.report?.symptomName || activeSymptomReport?.report?.text || "Symptom report"}
                    </div>
                    <div className="queue-meta">
                      Severity: {activeSymptomReport?.report?.symptomSeverity || "n/a"} | Occurred:{" "}
                      {activeSymptomReport?.report?.occurredAt
                        ? new Date(activeSymptomReport.report.occurredAt).toLocaleString()
                        : "n/a"}
                    </div>
                    <div className="queue-meta">
                      Shared at:{" "}
                      {activeSymptomReport?.report?.sharedAt
                        ? new Date(activeSymptomReport.report.sharedAt).toLocaleString()
                        : "n/a"}
                    </div>
                    <div className="note-text">
                      {activeSymptomReport?.report?.symptomExplanation ||
                        activeSymptomReport?.report?.text ||
                        "No additional symptom explanation."}
                    </div>
                    {activeSymptomReport?.report?.sharedNote ? (
                      <div className="meta">Patient note: {activeSymptomReport.report.sharedNote}</div>
                    ) : null}
                    <div className="queue-meta">
                      Reviewed:{" "}
                      {activeSymptomReport?.report?.reviewedByDoctorAt
                        ? new Date(activeSymptomReport.report.reviewedByDoctorAt).toLocaleString()
                        : "Pending doctor review"}
                    </div>
                    {activeSymptomReport?.report?.doctorReviewNote ? (
                      <div className="meta">Doctor review note: {activeSymptomReport.report.doctorReviewNote}</div>
                    ) : null}
                  </article>
                  <article className="note-item">
                    <div className="queue-title">Patient Contact</div>
                    <div className="queue-meta">
                      ID: {activeSymptomReport?.patient?.id || "n/a"} | Email:{" "}
                      {activeSymptomReport?.patient?.email || "n/a"} | Phone:{" "}
                      {activeSymptomReport?.patient?.phone || "n/a"}
                    </div>
                    <div className="form-row">
                      <button className="primary" type="button" onClick={openPatientRecordFromSymptomReport}>
                        Go to patient records
                      </button>
                      <button className="primary" type="button" onClick={startVirtualDiagnosisFromSymptomReport}>
                        Start virtual diagnosis chat
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        disabled={!activeSymptomReport?.patient?.phone}
                        onClick={() => {
                          const phone = String(activeSymptomReport?.patient?.phone || "").trim();
                          if (!phone) return;
                          window.open(`tel:${phone}`, "_self");
                        }}
                      >
                        Start call
                      </button>
                      <button
                        className="ghost"
                        type="button"
                        disabled={
                          !activeSymptomReport?.report?.id ||
                          Boolean(reviewingSymptomReportIds[activeSymptomReport.report.id]) ||
                          Boolean(activeSymptomReport?.report?.reviewedByDoctorAt)
                        }
                        onClick={async () => {
                          const reportId = activeSymptomReport?.report?.id;
                          if (!reportId) return;
                          await markSymptomReportReviewed({ reportId });
                          await openSymptomReportModal({ reportId });
                        }}
                      >
                        {activeSymptomReport?.report?.reviewedByDoctorAt
                          ? "Already reviewed"
                          : reviewingSymptomReportIds[activeSymptomReport?.report?.id]
                            ? "Reviewing..."
                            : "Mark reviewed"}
                      </button>
                    </div>
                  </article>
                </div>
              </div>
            </article>
          </div>
        </>
      ) : null}

      {isDateModalOpen ? (
        <>
          <button
            type="button"
            className="modal-scrim"
            aria-label="Close appointment details"
            onClick={() => setIsDateModalOpen(false)}
          />
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <article className="modal doctor-date-modal">
              <header className="modal-header">
                <div>
                  <h3>Appointments for {selectedDateKey}</h3>
                  <div className="doctor-date-kpis">
                    <span className="doctor-date-kpi doctor-date-kpi--available">
                      Availability: {selectedDayStats.available}
                    </span>
                    <span className="doctor-date-kpi doctor-date-kpi--booked">
                      Booked: {selectedDayStats.booked}
                    </span>
                    <span className="doctor-date-kpi doctor-date-kpi--completed">
                      Completed: {selectedDayStats.completed}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setIsDateModalOpen(false)}
                >
                  Close
                </button>
              </header>
              <div className="modal-body doctor-date-modal-body">
                <section className="modal-section doctor-date-section">
                  <h4 className="doctor-date-heading">
                    Availability Slots
                    <span className="doctor-date-section-pill doctor-date-section-pill--available">
                      SCHEDULE
                    </span>
                  </h4>
                  {selectedDayAvailability.length ? (
                    <div className="note-list">
                      {selectedDayAvailability.map((slot) => (
                        <article
                          key={slot.id}
                          className={`note-item doctor-date-card ${
                            slot.isActive === false
                              ? "doctor-date-card--inactive"
                              : "doctor-date-card--available"
                          }`}
                        >
                          <div className="queue-title">
                            {new Date(slot.startAt).toLocaleString()} -{" "}
                            {new Date(slot.endAt).toLocaleString()}
                          </div>
                          <div className="queue-meta">
                            {slot.mode} | {slot.location || "No location"} | max {slot.maxBookings}
                            {" | "}
                            fee: {slot.feeRequired ? `${slot.feeCurrency || "JMD"} ${Number(slot.feeAmount || 0).toFixed(2)}` : "none"}
                          </div>
                          <div className="doctor-date-chip-row">
                            <span
                              className={`doctor-date-chip ${
                                slot.isActive === false
                                  ? "doctor-date-chip--inactive"
                                  : "doctor-date-chip--available"
                              }`}
                            >
                              {slot.isActive === false ? "Inactive" : "Available"}
                            </span>
                          </div>
                          <button
                            className="ghost"
                            type="button"
                            onClick={() => deactivateAvailability(slot.id)}
                            disabled={slot.isActive === false}
                          >
                            {slot.isActive === false ? "Inactive" : "Deactivate"}
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="meta">No availability slots on this date.</div>
                  )}
                </section>

                <section className="modal-section doctor-date-section">
                  <h4 className="doctor-date-heading">
                    Patient Bookings
                    <span className="doctor-date-section-pill doctor-date-section-pill--booked">
                      CLINICAL QUEUE
                    </span>
                  </h4>
                  {selectedDayBookings.length ? (
                    <div className="note-list">
                      {selectedDayBookings.map((booking) => (
                        <article
                          key={booking.id}
                          className={`note-item doctor-date-card doctor-date-card--${booking.status || "pending"}`}
                        >
                          <div className="queue-title">
                            {booking.patientName || booking.patientId}
                          </div>
                          {booking.status === "approved" ? (
                            <button
                              type="button"
                              className="doctor-inline-badge-cta"
                              onClick={() => focusVisitCharge(booking.id)}
                            >
                              In-room Billing
                            </button>
                          ) : null}
                          <div className="doctor-date-chip-row">
                            <span
                              className={`doctor-date-chip doctor-date-chip--${booking.status || "pending"}`}
                            >
                              {String(booking.status || "pending").toUpperCase()}
                            </span>
                          </div>
                          <div className="queue-meta">
                            {new Date(booking.startAt).toLocaleString()} -{" "}
                            {new Date(booking.endAt).toLocaleString()}
                          </div>
                          <div className="queue-meta">
                            {booking.mode} | {booking.location || "No location"} | reason:{" "}
                            {booking.reason || "n/a"}
                          </div>
                          <div className="queue-meta">
                            Triage: {(booking.triageTags || []).length
                              ? booking.triageTags.join(", ")
                              : "routine"}
                          </div>
                          <div className="queue-meta">
                            Billing: {booking.feeCurrency || "JMD"} {Number(booking.feeAmount || 0).toFixed(2)} | NHF:{" "}
                            {booking.feeCurrency || "JMD"} {Number(booking.nhfDeductionAmount || 0).toFixed(2)} | Ready:{" "}
                            {booking.billingReadyForCollection ? "Yes" : "No"}
                          </div>
                          <div className="queue-meta">
                            Sent to reception:{" "}
                            {booking.receptionHandoffAt
                              ? new Date(booking.receptionHandoffAt).toLocaleString()
                              : "Not sent"}
                          </div>
                          <div className="queue-meta">
                            Reminder next due: {booking.reminder?.nextDueAt
                              ? new Date(booking.reminder.nextDueAt).toLocaleString()
                              : "None"}
                            {" | "}Last sent: {booking.reminder?.lastSentAt
                              ? new Date(booking.reminder.lastSentAt).toLocaleString()
                              : "Never"}
                          </div>
                          <div className="doctor-reminder-panel">
                            <div className="doctor-reminder-grid">
                              <label>
                                Consultation fee
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={getVisitChargeDraft(booking).consultationFee}
                                  ref={(el) => {
                                    if (el) visitChargeInputRefs.current[booking.id] = el;
                                  }}
                                  onChange={(e) =>
                                    updateVisitChargeDraft(booking.id, {
                                      consultationFee: Number(e.target.value || 0),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Additional charges
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={getVisitChargeDraft(booking).additionalCharges}
                                  onChange={(e) =>
                                    updateVisitChargeDraft(booking.id, {
                                      additionalCharges: Number(e.target.value || 0),
                                    })
                                  }
                                />
                              </label>
                              <label>
                                NHF deduction
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={getVisitChargeDraft(booking).nhfDeductionAmount}
                                  onChange={(e) =>
                                    updateVisitChargeDraft(booking.id, {
                                      nhfDeductionAmount: Number(e.target.value || 0),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <div className="doctor-reminder-grid">
                              <label>
                                Currency
                                <select
                                  value={getVisitChargeDraft(booking).feeCurrency}
                                  onChange={(e) =>
                                    updateVisitChargeDraft(booking.id, {
                                      feeCurrency: e.target.value,
                                    })
                                  }
                                >
                                  <option value="JMD">JMD</option>
                                  <option value="USD">USD</option>
                                </select>
                              </label>
                              <label>
                                Charge notes
                                <input
                                  value={getVisitChargeDraft(booking).chargeNotes}
                                  onChange={(e) =>
                                    updateVisitChargeDraft(booking.id, {
                                      chargeNotes: e.target.value,
                                    })
                                  }
                                  placeholder="Billing notes for front desk"
                                />
                              </label>
                            </div>
                            <div className="form-row">
                              <button className="ghost" type="button" onClick={() => saveVisitCharge(booking)}>
                                Save charges for reception
                              </button>
                              {booking.status === "approved" ? (
                                <button
                                  className="primary"
                                  type="button"
                                  onClick={() => saveVisitCharge(booking, { completeAfterSave: true })}
                                >
                                  Complete + send to reception
                                </button>
                              ) : null}
                            </div>
                          </div>
                          <div className="doctor-reminder-panel">
                            <div className="doctor-reminder-grid">
                              <label>
                                Channel
                                <select
                                  value={getReminderDraft(booking).channel}
                                  onChange={(e) =>
                                    updateReminderDraft(booking.id, { channel: e.target.value })
                                  }
                                >
                                  <option value="email">Email</option>
                                  <option value="whatsapp">WhatsApp</option>
                                  <option value="sms">SMS</option>
                                </select>
                              </label>
                              <label>
                                Custom alert time
                                <input
                                  type="datetime-local"
                                  value={getReminderDraft(booking).customAlertAt}
                                  onChange={(e) =>
                                    updateReminderDraft(booking.id, {
                                      customAlertAt: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className="checkbox doctor-reminder-checkbox">
                                <input
                                  type="checkbox"
                                  checked={Boolean(getReminderDraft(booking).default24h)}
                                  onChange={(e) =>
                                    updateReminderDraft(booking.id, {
                                      default24h: e.target.checked,
                                    })
                                  }
                                />
                                24-hour reminder
                              </label>
                            </div>
                            <div className="form-row">
                              <button
                                className="primary"
                                type="button"
                                onClick={() => saveReminderConfig(booking)}
                              >
                                Save reminder schedule
                              </button>
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => sendReminderNow(booking)}
                              >
                                Send reminder now
                              </button>
                            </div>
                          </div>
                          <div className="form-row">
                            {["approved", "completed"].includes(String(booking.status || "").toLowerCase()) ? (
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => sendBookingToReception(booking)}
                              >
                                {booking.receptionHandoffAt ? "Resend to receptionist" : "Send to receptionist"}
                              </button>
                            ) : null}
                            {booking.status === "pending" ? (
                              <>
                                <button
                                  className="primary"
                                  type="button"
                                  onClick={() => decideBooking(booking.id, "approved")}
                                >
                                  Approve
                                </button>
                                <button
                                  className="ghost"
                                  type="button"
                                  onClick={() => decideBooking(booking.id, "rejected")}
                                >
                                  Reject
                                </button>
                              </>
                            ) : null}
                          {booking.status === "approved" ? (
                            <>
                              <button
                                className="primary"
                                type="button"
                                onClick={() => decideBooking(booking.id, "completed")}
                              >
                                Mark completed
                              </button>
                              <button
                                className="ghost"
                                type="button"
                                onClick={() => decideBooking(booking.id, "no_show")}
                              >
                                Mark no-show
                              </button>
                            </>
                          ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="meta">No patient bookings on this date.</div>
                  )}
                </section>
              </div>
            </article>
          </div>
        </>
      ) : null}
    </section>
  );
}

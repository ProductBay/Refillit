const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  DoctorConnection,
  Order,
  PatientProfile,
  Prescription,
  User,
  ChatThread,
  ChatMessage,
  AppointmentAvailability,
  Appointment,
  DoctorPrivateNote,
  DoctorPrescriptionTemplate,
  DoctorFavoriteMed,
  AppointmentWaitlist,
  DoctorReceptionAccess,
  Referral,
  PharmacyIntervention,
  SharedCareNote,
  SoapNote,
  ConsentRecord,
  CareInstructionBroadcast,
  RefillRequest,
  AuditLog,
  PatientVisitPrepItem,
  InstallmentProposal,
  MohClinicalCatalogEntry,
} = require("../models");
const { writeAudit } = require("../utils/audit");
const { hashPassword } = require("../utils/password");
const { hashIdentifier, normalizeEmail } = require("../utils/crypto");
const { decryptValue, encryptValue } = require("../utils/fieldCrypto");
const { ensurePlatformStaffId, nextPlatformStaffIdForRole } = require("../utils/platformStaffId");
const { findApprovedDrug } = require("../constants/mohDrugs");
const {
  buildPrescriptionQrPayload,
  generatePrescriptionQrDataUrl,
  parsePrescriptionQr,
  toCompactPrescriptionLink,
} = require("../utils/prescriptionQr");

const router = express.Router();

const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const REMINDER_CHANNELS = new Set(["email", "whatsapp", "sms"]);
const RECEPTION_SCOPE_KEYS = [
  "canViewDemographics",
  "canViewAppointments",
  "canViewPrivateNotes",
  "canViewPrescriptions",
];
const ALLERGY_KEYWORDS = {
  penicillin: ["amoxicillin", "penicillin", "ampicillin"],
  sulfa: ["sulfamethoxazole", "sulfa", "trimethoprim"],
  aspirin: ["aspirin"],
  nsaid: ["ibuprofen", "naproxen", "diclofenac"],
};
const INTERACTION_PAIRS = [
  { a: "amlodipine", b: "atorvastatin", severity: "high", hardStop: true },
  { a: "metformin", b: "insulin nph", severity: "high", hardStop: false },
  { a: "losartan", b: "hydrochlorothiazide", severity: "moderate", hardStop: false },
];
const MIN_CONTROLLED_JUSTIFICATION_LENGTH = 15;
const DEFAULT_PRESCRIPTION_TEMPLATES = [
  {
    id: "tpl-htn-1",
    name: "Hypertension Starter",
    diagnosis: "Hypertension",
    meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
    allowedRefills: 2,
    notes: "Monitor blood pressure at home daily.",
  },
  {
    id: "tpl-dm2-1",
    name: "Type 2 Diabetes Starter",
    diagnosis: "Type 2 diabetes",
    meds: [{ ndcCode: "M002", name: "Metformin", strength: "500mg", qty: 60 }],
    allowedRefills: 2,
    notes: "Take with meals and monitor fasting glucose.",
  },
  {
    id: "tpl-asthma-1",
    name: "Asthma Relief",
    diagnosis: "Asthma",
    meds: [{ ndcCode: "M005", name: "Salbutamol", strength: "100mcg inhaler", qty: 1 }],
    allowedRefills: 1,
    notes: "Use as needed for wheeze or shortness of breath.",
  },
];

const ICD10_CODES = [
  { code: "I10", label: "Essential (primary) hypertension" },
  { code: "E11.9", label: "Type 2 diabetes mellitus without complications" },
  { code: "J45.909", label: "Unspecified asthma, uncomplicated" },
  { code: "R07.9", label: "Chest pain, unspecified" },
  { code: "M54.5", label: "Low back pain" },
];

const CPT_CODES = [
  { code: "99213", label: "Established patient office/outpatient visit" },
  { code: "99214", label: "Established patient moderate complexity visit" },
  { code: "93000", label: "Electrocardiogram complete" },
  { code: "80053", label: "Comprehensive metabolic panel" },
  { code: "71046", label: "Chest X-ray 2 views" },
];

const INSTRUCTION_TEMPLATES = [
  {
    id: "tmpl-med-adherence",
    language: "en",
    category: "medication",
    title: "Medication Adherence",
    body: "Take your medications exactly as prescribed. Do not skip doses.",
  },
  {
    id: "tmpl-med-adherence-es",
    language: "es",
    category: "medication",
    title: "Adherencia a Medicamentos",
    body: "Tome sus medicamentos exactamente como se le indicó. No omita dosis.",
  },
  {
    id: "tmpl-followup",
    language: "en",
    category: "follow_up",
    title: "Follow-up Reminder",
    body: "Please complete your follow-up visit and required tests before your next refill.",
  },
];

const toValidDate = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const toMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
};
const normalizeFeeCurrency = (value) =>
  (String(value || "JMD").trim().toUpperCase().slice(0, 8) || "JMD");

const parseStrengthToMg = (strength) => {
  const raw = String(strength || "").trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(mcg|mg|g)\b/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount)) return null;
  if (unit === "mcg") return amount / 1000;
  if (unit === "g") return amount * 1000;
  return amount;
};

const calculateAgeYears = (dob) => {
  const parsed = toValidDate(dob);
  if (!parsed) return null;
  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  return diffMs > 0 ? diffMs / (365.25 * 24 * 60 * 60 * 1000) : null;
};

const dateKey = (value) => String(value || "").slice(0, 10);

const triageTagsFromReason = (reason) => {
  const text = String(reason || "").toLowerCase();
  const tags = [];
  if (!text) return ["routine"];
  if (/(chest pain|shortness of breath|bleeding|stroke|suicid)/.test(text)) tags.push("urgent");
  if (/(refill|medication|prescription)/.test(text)) tags.push("medication");
  if (/(fever|infection|cough)/.test(text)) tags.push("infection");
  if (/(follow up|follow-up|review|checkup)/.test(text)) tags.push("follow_up");
  if (/(pain|injury|swelling)/.test(text)) tags.push("pain");
  if (!tags.length) tags.push("routine");
  return Array.from(new Set(tags)).slice(0, 4);
};

const buildSimpleStructuredSoapFromText = (text) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return {
      subjective: "",
      objective: "",
      assessment: "",
      plan: "",
    };
  }
  const combined = lines.join(" ");
  const chunks = combined.split(/[.;]\s+/).filter(Boolean);
  return {
    subjective: chunks.slice(0, 2).join(". "),
    objective: chunks.slice(2, 4).join(". "),
    assessment: chunks.slice(4, 5).join(". "),
    plan: chunks.slice(5).join(". "),
  };
};

const OBJECTIVE_ASSIST_RULES = [
  {
    id: "respiratory",
    keywords: ["shortness of breath", "dyspnea", "wheeze", "wheezing", "cough", "asthma"],
    exam: [
      "Respiratory exam: work of breathing, accessory muscle use, chest expansion symmetry.",
      "Lung auscultation: wheeze/crackles/air entry documented bilaterally.",
    ],
    vitals: ["SpO2", "Respiratory rate", "Heart rate"],
  },
  {
    id: "cardiac",
    keywords: ["chest pain", "chest tightness", "palpitation", "palpitations"],
    exam: [
      "Cardiovascular exam: rate, rhythm, perfusion, edema status.",
      "Pain characterization documented with exertional/rest pattern and reproducibility on palpation if relevant.",
    ],
    vitals: ["Blood pressure", "Heart rate", "SpO2"],
  },
  {
    id: "infectious",
    keywords: ["fever", "chills", "sore throat", "infection"],
    exam: [
      "Targeted infectious-source exam and general appearance documented.",
      "Hydration status and mucous membranes assessed.",
    ],
    vitals: ["Temperature", "Heart rate", "Blood pressure"],
  },
  {
    id: "neurologic",
    keywords: ["headache", "dizziness", "weakness", "numbness", "syncope"],
    exam: [
      "Neurologic screen: mental status, focal motor/sensory asymmetry, speech/facial symmetry.",
      "Balance/gait assessment when clinically indicated.",
    ],
    vitals: ["Blood pressure", "Heart rate"],
  },
  {
    id: "gi",
    keywords: ["abdominal pain", "nausea", "vomiting", "diarrhea"],
    exam: [
      "Abdominal exam: tenderness location, guarding/rebound, bowel activity as applicable.",
      "Hydration and orthostatic tolerance reviewed when GI losses suspected.",
    ],
    vitals: ["Temperature", "Heart rate", "Blood pressure"],
  },
  {
    id: "musculoskeletal",
    keywords: [
      "joint pain",
      "back pain",
      "swelling",
      "injury",
      "fracture",
      "broken arm",
      "arm pain",
      "fall",
      "trauma",
      "sprain",
    ],
    exam: [
      "MSK exam: ROM limits, focal tenderness, swelling, and neurovascular integrity.",
    ],
    vitals: ["Heart rate", "Blood pressure"],
  },
  {
    id: "preventive_checkup",
    keywords: [
      "check up",
      "checkup",
      "regular check up",
      "regular checkup",
      "annual physical",
      "wellness visit",
      "routine review",
      "follow up visit",
    ],
    exam: [
      "Preventive exam: general appearance, cardiopulmonary baseline, abdominal and focused system review as indicated.",
      "Health maintenance review completed (screenings, immunization status, chronic risk factors).",
    ],
    vitals: ["Blood pressure", "Heart rate", "Temperature", "SpO2", "Weight", "BMI"],
  },
];

const KNOWN_SYMPTOMS = [
  "shortness of breath",
  "dyspnea",
  "wheeze",
  "wheezing",
  "cough",
  "chest pain",
  "chest tightness",
  "palpitations",
  "palpitation",
  "fever",
  "chills",
  "headache",
  "dizziness",
  "weakness",
  "numbness",
  "syncope",
  "abdominal pain",
  "nausea",
  "vomiting",
  "diarrhea",
  "sore throat",
  "back pain",
  "joint pain",
  "swelling",
  "fracture",
  "broken arm",
  "arm pain",
  "fall",
  "trauma",
  "sprain",
  "check up",
  "checkup",
  "annual physical",
  "wellness visit",
];

const extractDenials = (text) => {
  const raw = String(text || "");
  const matches = raw.match(/(?:denies|denied|no|without)\s+([a-z0-9,\s-]+)/gi) || [];
  const values = [];
  for (const entry of matches) {
    const cleaned = entry
      .replace(/^(denies|denied|no|without)\s+/i, "")
      .split(/,| and | or /i)
      .map((chunk) => chunk.trim().toLowerCase())
      .filter((chunk) => chunk.length > 2);
    values.push(...cleaned);
  }
  return Array.from(new Set(values)).slice(0, 8);
};

const extractDurationPhrase = (text) => {
  const raw = String(text || "").toLowerCase();
  const match = raw.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(hour|hours|day|days|week|weeks|month|months|year|years)\b/
  );
  if (match) return `${match[1]} ${match[2]}`;
  if (raw.includes("since yesterday")) return "since yesterday";
  if (raw.includes("since today")) return "since today";
  return "";
};

const extractSeverityPhrase = (text) => {
  const raw = String(text || "").toLowerCase();
  if (raw.includes("severe")) return "severe";
  if (raw.includes("moderate")) return "moderate";
  if (raw.includes("mild")) return "mild";
  if (raw.includes("worsening") || raw.includes("worse")) return "worsening";
  if (raw.includes("improving") || raw.includes("better")) return "improving";
  return "";
};

const buildObjectiveAssistFromSubjective = (subjective, diagnosis = "") => {
  const text = String(subjective || "").toLowerCase();
  const diagnosisText = String(diagnosis || "").toLowerCase();
  const detectedRules = OBJECTIVE_ASSIST_RULES.filter(
    (rule) => containsAny(text, rule.keywords) || (diagnosisText && containsAny(diagnosisText, rule.keywords))
  );

  const detectedKeywords = [];
  const examPoints = [];
  const vitals = new Set(["Blood pressure", "Heart rate", "Temperature", "SpO2"]);
  const deniedItems = extractDenials(text);
  const duration = extractDurationPhrase(text);
  const severity = extractSeverityPhrase(text);
  const confirmedSymptoms = KNOWN_SYMPTOMS.filter(
    (symptom) => text.includes(symptom) && !deniedItems.some((denial) => denial.includes(symptom))
  ).slice(0, 8);

  for (const rule of detectedRules) {
    for (const keyword of rule.keywords) {
      if (text.includes(keyword) || diagnosisText.includes(keyword)) {
        detectedKeywords.push(keyword);
      }
    }
    for (const point of rule.exam) examPoints.push(point);
    for (const vital of rule.vitals) vitals.add(vital);
  }

  const cleanExam = Array.from(new Set(examPoints));
  const cleanKeywords = Array.from(new Set(detectedKeywords)).slice(0, 10);
  const vitalsList = Array.from(vitals);

  const contextBits = [];
  if (confirmedSymptoms.length) contextBits.push(`reported symptoms: ${confirmedSymptoms.join(", ")}`);
  if (duration) contextBits.push(`reported duration: ${duration}`);
  if (severity) contextBits.push(`reported severity trend: ${severity}`);
  if (deniedItems.length) contextBits.push(`reported negatives: denies ${deniedItems.join(", ")}`);

  const objectiveLines = [
    contextBits.length
      ? `Subjective-derived context (patient-reported, not yet exam-confirmed): ${contextBits.join("; ")}.`
      : "Subjective-derived context available; objective findings require direct exam confirmation.",
    `Vitals to capture with measured values now: ${vitalsList.join(", ")}.`,
    "Document numeric results directly in chart (e.g., BP mmHg, HR bpm, Temp C, SpO2 %, RR).",
  ];

  if (cleanExam.length) {
    objectiveLines.push(`Focused objective exam priorities: ${cleanExam.join(" ")}`);
  } else {
    objectiveLines.push(
      "Focused objective exam priorities: system-based exam aligned to presenting complaint with pertinent positives/negatives."
    );
  }

  const confidence = Math.min(
    0.95,
    0.4 +
      cleanKeywords.length * 0.05 +
      confirmedSymptoms.length * 0.04 +
      (duration ? 0.05 : 0) +
      (severity ? 0.05 : 0)
  );

  return {
    objectiveText: objectiveLines.join(" "),
    detectedKeywords: cleanKeywords,
    confirmedSymptoms,
    deniedSymptoms: deniedItems,
    recommendedVitals: vitalsList,
    recommendedExamPoints: cleanExam,
    confidence: Number(confidence.toFixed(2)),
  };
};

const ASSESSMENT_RULES = [
  {
    id: "asthma_exacerbation",
    keywords: ["wheeze", "wheezing", "shortness of breath", "dyspnea", "asthma"],
    primary: "Probable asthma/reactive airway exacerbation.",
    differential: ["Viral bronchitis", "Upper airway irritation", "Anxiety-related dyspnea"],
    riskSignals: ["spo2_low", "respiratory_distress"],
  },
  {
    id: "cardiac_chest_pain",
    keywords: ["chest pain", "chest tightness", "palpitation", "palpitations"],
    primary: "Chest pain syndrome requiring cardiac risk stratification.",
    differential: ["Musculoskeletal chest wall pain", "GERD-related pain", "Anxiety/panic symptoms"],
    riskSignals: ["chest_pain", "tachycardia", "hypotension", "spo2_low"],
  },
  {
    id: "infectious_syndrome",
    keywords: ["fever", "chills", "sore throat", "infection", "cough"],
    primary: "Acute infectious syndrome (site to be clinically localized).",
    differential: ["Viral URI", "Bacterial upper airway infection", "Early lower respiratory infection"],
    riskSignals: ["fever", "tachycardia", "hypotension"],
  },
  {
    id: "gi_syndrome",
    keywords: ["abdominal pain", "nausea", "vomiting", "diarrhea"],
    primary: "Acute gastrointestinal symptom complex.",
    differential: ["Viral gastroenteritis", "Food-related intolerance", "Functional GI flare"],
    riskSignals: ["tachycardia", "hypotension", "fever"],
  },
  {
    id: "neuro_syndrome",
    keywords: ["headache", "dizziness", "weakness", "numbness", "syncope"],
    primary: "Neurologic symptom complex requiring focused neuro correlation.",
    differential: ["Primary headache disorder", "Vestibular etiology", "Metabolic/volume-related etiology"],
    riskSignals: ["neurologic_red_flag", "hypertension_severe"],
  },
  {
    id: "msk_trauma_syndrome",
    keywords: ["fracture", "broken arm", "arm injury", "arm pain", "fall", "trauma", "deformity", "swelling"],
    primary: "Musculoskeletal trauma pattern; fracture/dislocation must be excluded or confirmed.",
    differential: ["Soft-tissue contusion", "Ligament sprain/strain", "Occult fracture"],
    riskSignals: ["trauma_significant", "severe_pain"],
  },
  {
    id: "preventive_visit_syndrome",
    keywords: ["check up", "checkup", "annual physical", "wellness visit", "routine review", "follow up visit"],
    primary: "Routine preventive/maintenance encounter without acute destabilizing syndrome from available text.",
    differential: ["Stable chronic disease follow-up", "Preventive counseling encounter", "Asymptomatic risk-screening visit"],
    riskSignals: [],
  },
];

const OBJECTIVE_ISSUE_RULES = [
  {
    id: "respiratory_issue",
    objectiveTokens: ["wheeze", "dyspnea", "shortness of breath", "respiratory distress", "air entry"],
    label: "Respiratory compromise pattern",
    assessment: "Objective respiratory findings support lower-airway involvement; correlate with bronchodilator response and oxygenation trend.",
  },
  {
    id: "cardiac_issue",
    objectiveTokens: ["chest pain", "chest tightness", "tachycardia", "perfusion"],
    label: "Cardiovascular symptom-risk pattern",
    assessment: "Objective findings support cardiopulmonary risk stratification and exclusion of acute ischemic/hemodynamic causes.",
  },
  {
    id: "infectious_issue",
    objectiveTokens: ["fever", "temperature", "infectious-source", "sore throat", "cough"],
    label: "Infectious/inflammatory pattern",
    assessment: "Objective findings are compatible with acute infectious process; localize source and severity based on exam/labs.",
  },
  {
    id: "neurologic_issue",
    objectiveTokens: ["focal", "mental status", "speech", "gait", "balance", "neurologic"],
    label: "Neurologic concern pattern",
    assessment: "Objective neurologic findings require focused localization and red-flag exclusion.",
  },
  {
    id: "gi_issue",
    objectiveTokens: ["abdominal", "guarding", "rebound", "hydration", "orthostatic"],
    label: "Gastrointestinal/dehydration pattern",
    assessment: "Objective abdominal/hydration findings support GI syndrome assessment with volume-status correlation.",
  },
  {
    id: "msk_trauma_issue",
    objectiveTokens: ["deformity", "tenderness", "swelling", "reduced rom", "neurovascular", "fracture", "splint"],
    label: "Musculoskeletal trauma pattern",
    assessment:
      "Objective trauma findings support suspected musculoskeletal injury; assess stability and confirm with imaging where indicated.",
  },
  {
    id: "preventive_issue",
    objectiveTokens: ["preventive exam", "health maintenance", "screening", "immunization", "wellness"],
    label: "Preventive care pattern",
    assessment:
      "Objective preventive-visit findings support maintenance-focused assessment with risk-factor and screening prioritization.",
  },
];

const parseFirstNumeric = (text, pattern) => {
  const match = String(text || "").match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const parseBloodPressure = (text) => {
  const match = String(text || "").match(/\b(?:bp|blood pressure)\s*[:=]?\s*(\d{2,3})\s*\/\s*(\d{2,3})\b/i);
  if (!match) return null;
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
  return { systolic, diastolic };
};

const parseObjectiveMeasurements = (objectiveText) => {
  const source = String(objectiveText || "");
  const heartRate = parseFirstNumeric(source, /\b(?:hr|heart rate)\s*[:=]?\s*(\d{2,3})\b/i);
  const respiratoryRate = parseFirstNumeric(source, /\b(?:rr|resp(?:iratory)? rate)\s*[:=]?\s*(\d{1,2})\b/i);
  const spo2 = parseFirstNumeric(source, /\b(?:spo2|o2 sat|oxygen sat(?:uration)?)\s*[:=]?\s*(\d{2,3})\s*%?/i);
  const temperature = parseFirstNumeric(source, /\b(?:temp|temperature)\s*[:=]?\s*(\d{2}(?:\.\d+)?)\b/i);
  const bp = parseBloodPressure(source);
  return {
    heartRate,
    respiratoryRate,
    spo2,
    temperature,
    systolic: bp?.systolic ?? null,
    diastolic: bp?.diastolic ?? null,
  };
};

const deriveClinicalRiskSignals = ({ merged, measurements }) => {
  const signals = [];
  if (merged.includes("chest pain") || merged.includes("chest tightness")) signals.push("chest_pain");
  if (merged.includes("altered mental status") || merged.includes("focal deficit")) {
    signals.push("neurologic_red_flag");
  }
  if (/(fracture|broken arm|deformity|major trauma|fall)/.test(merged)) {
    signals.push("trauma_significant");
  }
  if (/(severe pain|pain 8\/10|pain 9\/10|pain 10\/10)/.test(merged)) {
    signals.push("severe_pain");
  }
  if (measurements.spo2 !== null && measurements.spo2 < 94) signals.push("spo2_low");
  if (measurements.heartRate !== null && measurements.heartRate >= 110) signals.push("tachycardia");
  if (measurements.respiratoryRate !== null && measurements.respiratoryRate >= 24) {
    signals.push("respiratory_distress");
  }
  if (measurements.temperature !== null && measurements.temperature >= 38) signals.push("fever");
  if (measurements.systolic !== null && measurements.systolic < 90) signals.push("hypotension");
  if (measurements.systolic !== null && measurements.systolic >= 180) signals.push("hypertension_severe");
  return Array.from(new Set(signals));
};

const riskLevelFromSignals = (signals = []) => {
  const hasHigh = signals.some((entry) =>
    ["spo2_low", "hypotension", "hypertension_severe", "neurologic_red_flag", "trauma_significant"].includes(entry)
  );
  if (hasHigh) return "high";
  const hasModerate = signals.some((entry) =>
    ["chest_pain", "tachycardia", "respiratory_distress", "fever", "severe_pain"].includes(entry)
  );
  if (hasModerate) return "moderate";
  return "low";
};

const buildAssessmentAssist = ({ subjective = "", objective = "", diagnosis = "" }) => {
  const subjectiveText = String(subjective || "").toLowerCase();
  const objectiveText = String(objective || "").toLowerCase();
  const diagnosisText = String(diagnosis || "").toLowerCase();
  const merged = `${subjectiveText} ${objectiveText} ${diagnosisText}`.trim();
  const deniedItems = extractDenials(subjectiveText);
  const objectiveMeasurements = parseObjectiveMeasurements(objectiveText);
  const derivedRiskSignals = deriveClinicalRiskSignals({ merged, measurements: objectiveMeasurements });
  const detectedObjectiveIssues = OBJECTIVE_ISSUE_RULES.filter((rule) =>
    containsAny(objectiveText, rule.objectiveTokens)
  ).map((rule) => ({
    id: rule.id,
    label: rule.label,
    assessment: rule.assessment,
  }));

  const matched = ASSESSMENT_RULES.filter((rule) => containsAny(merged, rule.keywords));
  const matchedKeywords = [];
  const weightedCandidates = [];
  for (const rule of matched) {
    let score = 1;
    for (const kw of rule.keywords) {
      if (merged.includes(kw)) {
        matchedKeywords.push(kw);
        score += 0.5;
      }
    }
    const overlapSignals = (rule.riskSignals || []).filter((entry) => derivedRiskSignals.includes(entry));
    score += overlapSignals.length * 0.6;
    weightedCandidates.push({
      id: rule.id,
      label: rule.primary,
      score: Number(score.toFixed(2)),
      overlaps: overlapSignals,
      differentials: rule.differential || [],
    });
  }

  weightedCandidates.sort((a, b) => b.score - a.score);
  const likelyCandidates = weightedCandidates.slice(0, 3);

  for (const candidate of likelyCandidates) {
    for (const token of candidate.overlaps || []) {
      if (!matchedKeywords.includes(token)) matchedKeywords.push(token);
    }
  }

  const keywords = Array.from(new Set(matchedKeywords)).slice(0, 10);

  const primary =
    likelyCandidates[0]?.label ||
    "Clinical syndrome not fully classifiable from text alone; correlate with focused exam and measured findings.";
  const differentials = Array.from(
    new Set(likelyCandidates.flatMap((entry) => entry.differentials || []))
  ).slice(0, 4);
  const issueSpecificAssessments = Array.from(
    new Set(detectedObjectiveIssues.map((entry) => entry.assessment))
  ).slice(0, 3);

  const flags = [];
  if (derivedRiskSignals.includes("chest_pain") && derivedRiskSignals.includes("spo2_low")) {
    flags.push("Chest symptoms with low oxygen saturation: urgent cardiopulmonary evaluation recommended.");
  } else if (merged.includes("chest pain") || merged.includes("shortness of breath")) {
    flags.push("Consider urgent cardiopulmonary exclusion if red flags are present.");
  }
  if (derivedRiskSignals.includes("tachycardia")) flags.push("Objective tachycardia noted; correlate with etiology and hemodynamic status.");
  if (derivedRiskSignals.includes("hypotension")) flags.push("Hypotension signal detected; assess perfusion and potential instability.");
  if (derivedRiskSignals.includes("hypertension_severe")) flags.push("Severe hypertension signal detected; evaluate for acute end-organ risk.");
  if (deniedItems.some((item) => item.includes("fever"))) {
    flags.push("Reported fever denial may lower likelihood of systemic infection.");
  }
  if (!flags.length) {
    flags.push("Assessment should remain provisional pending objective exam confirmation.");
  }

  const evidence = [];
  if (keywords.length) evidence.push(`Matched keywords: ${keywords.join(", ")}`);
  if (deniedItems.length) evidence.push(`Reported denials: ${deniedItems.join(", ")}`);
  if (diagnosisText) evidence.push(`Diagnosis context entered: ${diagnosis}`);
  const objectiveEvidence = [];
  if (objectiveMeasurements.systolic !== null && objectiveMeasurements.diastolic !== null) {
    objectiveEvidence.push(`BP ${objectiveMeasurements.systolic}/${objectiveMeasurements.diastolic}`);
  }
  if (objectiveMeasurements.heartRate !== null) objectiveEvidence.push(`HR ${objectiveMeasurements.heartRate}`);
  if (objectiveMeasurements.respiratoryRate !== null) objectiveEvidence.push(`RR ${objectiveMeasurements.respiratoryRate}`);
  if (objectiveMeasurements.temperature !== null) objectiveEvidence.push(`Temp ${objectiveMeasurements.temperature}`);
  if (objectiveMeasurements.spo2 !== null) objectiveEvidence.push(`SpO2 ${objectiveMeasurements.spo2}%`);
  if (objectiveEvidence.length) evidence.push(`Objective measures parsed: ${objectiveEvidence.join(", ")}`);
  if (detectedObjectiveIssues.length) {
    evidence.push(
      `Objective-recognized issues: ${detectedObjectiveIssues.map((entry) => entry.label).join("; ")}`
    );
  }

  const riskLevel = riskLevelFromSignals(derivedRiskSignals);
  const assessmentLines = [
    `Primary impression: ${primary}`,
    differentials.length ? `Differential considerations: ${differentials.join("; ")}.` : "",
    likelyCandidates.length
      ? `Likely diagnostic candidates: ${likelyCandidates
          .map((entry) => `${entry.label} (score ${entry.score})`)
          .join(" | ")}.`
      : "",
    issueSpecificAssessments.length
      ? `Issue-oriented assessment: ${issueSpecificAssessments.join(" ")}`
      : "",
    `Clinical rationale: ${evidence.join(" | ") || "limited text evidence"}.`,
    `Risk level: ${riskLevel}. Safety note: ${flags.join(" ")}`,
  ].filter(Boolean);

  const confidence = Math.min(
    0.96,
    0.35 +
      keywords.length * 0.06 +
      (objectiveText.length > 40 ? 0.14 : 0) +
      (diagnosisText ? 0.1 : 0) +
      (likelyCandidates.length ? 0.08 : 0) +
      (detectedObjectiveIssues.length ? 0.08 : 0) +
      (riskLevel === "high" ? 0.05 : 0)
  );

  return {
    assessmentText: assessmentLines.join(" "),
    matchedKeywords: keywords,
    differentials,
    safetyFlags: flags,
    likelyDiagnoses: likelyCandidates,
    detectedObjectiveIssues,
    riskLevel,
    objectiveMeasures: objectiveMeasurements,
    confidence: Number(confidence.toFixed(2)),
  };
};

const PLAN_ASSIST_RULES = [
  {
    id: "respiratory_plan",
    triggers: ["asthma", "wheeze", "dyspnea", "shortness of breath", "reactive airway"],
    actions: [
      "Initiate/optimize bronchodilator strategy and document response window.",
      "Reassess respiratory status and oxygenation after treatment interval.",
    ],
    followUp: "Follow-up within 24-72 hours if persistent symptoms; sooner for worsening respiratory effort.",
    redFlags: ["Worsening shortness of breath", "SpO2 decline", "Inability to speak full sentences"],
  },
  {
    id: "cardiac_plan",
    triggers: ["chest pain", "chest tightness", "palpitation", "cardiac"],
    actions: [
      "Perform cardiac risk-directed workup (ECG/troponin pathway per protocol).",
      "Monitor hemodynamics and symptom evolution during evaluation.",
    ],
    followUp: "Urgent same-day reassessment pathway if symptoms recur or escalate.",
    redFlags: ["Persistent chest pain", "Syncope", "Hemodynamic instability"],
  },
  {
    id: "infectious_plan",
    triggers: ["infection", "fever", "chills", "sore throat", "infectious"],
    actions: [
      "Localize suspected infectious source and assess severity markers.",
      "Provide targeted antimicrobial/supportive care based on clinical criteria.",
    ],
    followUp: "Reassess in 48-72 hours or earlier if systemic deterioration.",
    redFlags: ["Persistent high fever", "New confusion", "Poor oral intake/dehydration"],
  },
  {
    id: "gi_plan",
    triggers: ["abdominal", "nausea", "vomiting", "diarrhea", "gastro"],
    actions: [
      "Initiate hydration and symptom-control plan with intake/output monitoring guidance.",
      "Escalate diagnostics if focal abdominal findings or persistent symptoms present.",
    ],
    followUp: "Follow-up within 48 hours if no improvement in GI symptoms.",
    redFlags: ["Persistent vomiting", "Bloody stool/emesis", "Progressive abdominal pain"],
  },
  {
    id: "neuro_plan",
    triggers: ["headache", "neurologic", "weakness", "numbness", "syncope"],
    actions: [
      "Complete focused neurologic monitoring and trend change in deficits.",
      "Escalate imaging/referral workflow if red-flag neurologic signs are present.",
    ],
    followUp: "Early follow-up (24-48 hours) for unresolved neurologic complaints.",
    redFlags: ["New focal deficit", "Altered consciousness", "Severe sudden-onset headache"],
  },
  {
    id: "msk_trauma_plan",
    triggers: ["fracture", "broken arm", "arm injury", "trauma", "deformity", "sprain"],
    actions: [
      "Immobilize injured limb/joint, provide analgesia plan, and document distal neurovascular status.",
      "Order/arrange imaging and definitive orthopedic evaluation pathway based on severity.",
    ],
    followUp:
      "Urgent orthopedic follow-up based on imaging and stability; provide clear return precautions for neurovascular changes.",
    redFlags: ["Increasing pain despite support", "Numbness/tingling", "Cold/pale extremity", "Progressive swelling"],
  },
  {
    id: "preventive_checkup_plan",
    triggers: ["check up", "checkup", "annual physical", "wellness visit", "routine review", "preventive"],
    actions: [
      "Complete age/risk-appropriate preventive screening checklist and chronic risk review.",
      "Provide lifestyle counseling and document preventive goals with measurable targets.",
    ],
    followUp:
      "Schedule routine maintenance follow-up interval and pending preventive screening completion.",
    redFlags: ["New concerning symptom after visit", "Unexpected abnormal screening result"],
  },
];

const buildPlanAssist = ({ subjective = "", objective = "", assessment = "", diagnosis = "" }) => {
  const text = `${String(subjective || "").toLowerCase()} ${String(objective || "").toLowerCase()} ${String(
    assessment || ""
  ).toLowerCase()} ${String(diagnosis || "").toLowerCase()}`.trim();
  const parsedMeasures = parseObjectiveMeasurements(objective);
  const riskSignals = deriveClinicalRiskSignals({ merged: text, measurements: parsedMeasures });
  const riskLevel = riskLevelFromSignals(riskSignals);

  const matchedRules = PLAN_ASSIST_RULES.filter((rule) => containsAny(text, rule.triggers));
  const combinedActions = Array.from(
    new Set(matchedRules.flatMap((rule) => rule.actions || []))
  ).slice(0, 6);
  const combinedRedFlags = Array.from(
    new Set(matchedRules.flatMap((rule) => rule.redFlags || []))
  ).slice(0, 6);

  const defaultActions = [
    "Finalize diagnosis-oriented treatment plan and document measurable treatment goals.",
    "Educate patient on medication adherence and expected response timeline.",
  ];

  const actions = combinedActions.length ? combinedActions : defaultActions;
  const followUp =
    matchedRules[0]?.followUp ||
    "Arrange follow-up based on symptom severity and objective trend within standard clinical window.";

  const escalationNotes = [];
  if (riskLevel === "high") {
    escalationNotes.push("High-risk objective pattern: prioritize urgent escalation/acute pathway.");
  } else if (riskLevel === "moderate") {
    escalationNotes.push("Moderate-risk pattern: close interval follow-up and reassessment advised.");
  }
  if (parsedMeasures.spo2 !== null && parsedMeasures.spo2 < 94) {
    escalationNotes.push("Low oxygen saturation detected; include immediate respiratory safety instructions.");
  }

  const planText = [
    `Treatment plan: ${actions.join(" ")}`,
    `Follow-up plan: ${followUp}`,
    `Safety-net instructions: ${(combinedRedFlags.length ? combinedRedFlags : ["Return immediately for any clinical worsening."]).join(
      "; "
    )}.`,
    escalationNotes.length ? `Escalation notes: ${escalationNotes.join(" ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const confidence = Math.min(
    0.96,
    0.38 +
      matchedRules.length * 0.1 +
      (String(assessment || "").trim() ? 0.16 : 0) +
      (String(objective || "").trim() ? 0.12 : 0) +
      (riskLevel === "high" ? 0.08 : riskLevel === "moderate" ? 0.05 : 0)
  );

  return {
    planText,
    actions,
    followUp,
    redFlags: combinedRedFlags,
    riskLevel,
    escalationNotes,
    objectiveMeasures: parsedMeasures,
    confidence: Number(confidence.toFixed(2)),
  };
};

const containsAny = (text, keywords) => keywords.some((kw) => text.includes(kw));

const isPatientInCohort = ({ patient, riskFlags, cohort }) => {
  const value = String(cohort || "").trim().toLowerCase();
  if (!value || value === "all") return true;
  if (value === "high_risk") return (riskFlags || []).some((flag) => flag.severity === "high");
  if (value === "non_adherence") return (riskFlags || []).some((flag) => flag.type === "non_adherence");
  if (value === "no_show") return (riskFlags || []).some((flag) => flag.type === "repeated_no_show");
  return false;
};

const normalizeMedName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const parseAllergyListInput = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
};

const decodeAllergyListFromProfile = (profile) => {
  if (!profile?.allergies) return [];
  try {
    const raw = decryptValue(profile.allergies);
    if (!raw) return [];
    if (raw.startsWith("[")) {
      return parseAllergyListInput(JSON.parse(raw));
    }
    return parseAllergyListInput(raw);
  } catch (_err) {
    return [];
  }
};

const findMedicationSafetyWarnings = ({ prescribedMeds = [], activeMeds = [], allergies = [] }) => {
  const warnings = [];
  const prescribed = prescribedMeds.map((med) => ({
    ...med,
    normalized: normalizeMedName(med.name || med.ndcCode),
  }));
  const active = activeMeds.map((med) => ({
    ...med,
    normalized: normalizeMedName(med.name || med.ndcCode),
  }));
  const allergyTokens = allergies.map((entry) => normalizeMedName(entry));

  for (const med of prescribed) {
    if (!med.normalized) continue;
    for (const activeMed of active) {
      if (!activeMed.normalized) continue;
      if (med.normalized === activeMed.normalized) {
        warnings.push({
          type: "duplicate_therapy",
          severity: "moderate",
          message: `${med.name} appears in active patient therapy.`,
          medication: med.name,
          conflictsWith: activeMed.name,
        });
      }
      for (const pair of INTERACTION_PAIRS) {
        const direct =
          med.normalized.includes(pair.a) && activeMed.normalized.includes(pair.b);
        const reverse =
          med.normalized.includes(pair.b) && activeMed.normalized.includes(pair.a);
        if (direct || reverse) {
          warnings.push({
            type: "drug_interaction",
            severity: pair.severity,
            hardStop: Boolean(pair.hardStop),
            message: `Potential interaction: ${med.name} with ${activeMed.name}.`,
            medication: med.name,
            conflictsWith: activeMed.name,
          });
        }
      }
    }
    for (const allergy of allergyTokens) {
      if (!allergy) continue;
      if (med.normalized.includes(allergy)) {
        warnings.push({
          type: "allergy_conflict",
          severity: "high",
          message: `${med.name} may conflict with recorded allergy: ${allergy}.`,
          medication: med.name,
          allergy,
        });
      }
      for (const [bucket, terms] of Object.entries(ALLERGY_KEYWORDS)) {
        if (!allergy.includes(bucket)) continue;
        if (terms.some((term) => med.normalized.includes(term))) {
          warnings.push({
            type: "allergy_conflict",
            severity: "high",
            message: `${med.name} may conflict with recorded allergy: ${allergy}.`,
            medication: med.name,
            allergy,
          });
        }
      }
    }
  }

  return warnings;
};

const findDoseSafetyWarnings = ({ prescribedMeds = [], patientDob, patientWeightKg }) => {
  const warnings = [];
  const ageYears = calculateAgeYears(patientDob);
  const weight = toNumberOrNull(patientWeightKg);
  for (const med of prescribedMeds) {
    const approved = findApprovedDrug({
      code: med.ndcCode,
      name: med.name,
      strength: med.strength,
    });
    if (!approved?.doseGuide) continue;
    const doseMg = parseStrengthToMg(med.strength);
    if (!doseMg) continue;

    const adultRule = approved.doseGuide.adultMgPerDose || null;
    const pediatricRule = approved.doseGuide.pediatricMgPerKgPerDose || null;
    const isPediatric = Number.isFinite(ageYears) ? ageYears < 18 : false;

    if (!isPediatric && adultRule) {
      if (doseMg < adultRule.min || doseMg > adultRule.max) {
        warnings.push({
          type: "dose_out_of_range",
          severity: "high",
          message: `${approved.name} ${med.strength} is outside adult dose range (${adultRule.min}-${adultRule.max}mg).`,
          medication: approved.name,
        });
      }
    }

    if (isPediatric && pediatricRule && Number.isFinite(weight) && weight > 0) {
      const minMg = pediatricRule.min * weight;
      const maxMg = pediatricRule.max * weight;
      if (doseMg < minMg || doseMg > maxMg) {
        warnings.push({
          type: "dose_out_of_range",
          severity: "high",
          message: `${approved.name} ${med.strength} is outside pediatric range for ${weight}kg (${Math.round(
            minMg
          )}-${Math.round(maxMg)}mg per dose).`,
          medication: approved.name,
        });
      }
    }
  }
  return warnings;
};

const findIntraPrescriptionDuplicateWarnings = (prescribedMeds = []) => {
  const warnings = [];
  const seen = new Map();
  for (const med of prescribedMeds) {
    const key = normalizeMedName(med.name || med.ndcCode);
    if (!key) continue;
    if (seen.has(key)) {
      warnings.push({
        type: "duplicate_therapy",
        severity: "moderate",
        message: `Duplicate therapy detected in draft: ${med.name || med.ndcCode}.`,
        medication: med.name || med.ndcCode,
      });
      continue;
    }
    seen.set(key, true);
  }
  return warnings;
};

const getReminderSummary = (booking) => {
  const startAt = toValidDate(booking.startAt);
  const candidates = [];
  if (booking.reminderDefault24h !== false && !booking.reminderDefaultSentAt && startAt) {
    candidates.push(new Date(startAt.getTime() - 24 * 60 * 60 * 1000));
  }
  if (booking.reminderCustomAlertAt && !booking.reminderCustomSentAt) {
    const custom = toValidDate(booking.reminderCustomAlertAt);
    if (custom) candidates.push(custom);
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return {
    channel: booking.reminderChannel || "email",
    default24h: booking.reminderDefault24h !== false,
    customAlertAt: booking.reminderCustomAlertAt || null,
    defaultSentAt: booking.reminderDefaultSentAt || null,
    customSentAt: booking.reminderCustomSentAt || null,
    lastSentAt: booking.reminderLastSentAt || null,
    nextDueAt: candidates.length ? candidates[0].toISOString() : null,
    history: Array.isArray(booking.reminderHistory) ? booking.reminderHistory : [],
  };
};

const sendBookingReminder = async ({
  booking,
  channel,
  kind,
  actorDoctorId,
  actorLabel = "doctor",
}) => {
  const doctor = await User.findByPk(booking.doctorId);
  const patient = await User.findByPk(booking.patientId);
  const patientProfile = await PatientProfile.findOne({ where: { userId: booking.patientId } });
  if (!patient) {
    return { ok: false, status: 404, error: "Patient not found for booking" };
  }

  const resolvedChannel = channel || booking.reminderChannel || "email";
  if (!REMINDER_CHANNELS.has(resolvedChannel)) {
    return { ok: false, status: 400, error: "Invalid reminder channel" };
  }

  const contact =
    resolvedChannel === "email"
      ? patient.email || null
      : patientProfile?.phone || patient.email || null;
  if (!contact) {
    return {
      ok: false,
      status: 400,
      error: `No patient contact found for ${resolvedChannel} reminder`,
    };
  }

  if (kind === "default24h" && booking.reminderDefaultSentAt) {
    return { ok: false, status: 409, error: "24-hour reminder already sent" };
  }
  if (kind === "custom" && booking.reminderCustomSentAt) {
    return { ok: false, status: 409, error: "Custom reminder already sent" };
  }

  const sentAt = new Date().toISOString();
  const text = [
    "Refillit Appointment Reminder",
    `Patient: ${patient.fullName || booking.patientId}`,
    `Doctor: ${doctor?.fullName || booking.doctorId}`,
    `Date/Time: ${new Date(booking.startAt).toLocaleString()}`,
    `Mode: ${booking.mode || "in-person"}`,
    `Location: ${booking.location || "N/A"}`,
    `Status: ${booking.status || "pending"}`,
  ].join("\n");

  booking.reminderChannel = resolvedChannel;
  booking.reminderLastSentAt = sentAt;
  if (kind === "default24h") booking.reminderDefaultSentAt = sentAt;
  if (kind === "custom") booking.reminderCustomSentAt = sentAt;
  booking.reminderHistory = Array.isArray(booking.reminderHistory) ? booking.reminderHistory : [];
  booking.reminderHistory.push({
    sentAt,
    kind,
    channel: resolvedChannel,
    actor: actorLabel,
    actorDoctorId: actorDoctorId || null,
    contact,
    text,
  });
  await booking.save();
  return {
    ok: true,
    reminder: {
      sentAt,
      kind,
      channel: resolvedChannel,
      contact,
      text,
    },
  };
};

const runDueReminderRulesForDoctor = async (doctorId) => {
  const now = new Date();
  const bookings = await Appointment.findAll({ where: { doctorId } });
  for (const booking of bookings) {
    if (!["pending", "approved"].includes(booking.status)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const startAt = toValidDate(booking.startAt);
    if (!startAt) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const defaultDue = new Date(startAt.getTime() - 24 * 60 * 60 * 1000);
    if (booking.reminderDefault24h !== false && !booking.reminderDefaultSentAt && defaultDue <= now) {
      // eslint-disable-next-line no-await-in-loop
      await sendBookingReminder({
        booking,
        channel: booking.reminderChannel,
        kind: "default24h",
        actorLabel: "system",
      });
    }
    if (booking.reminderCustomAlertAt && !booking.reminderCustomSentAt) {
      const customDue = toValidDate(booking.reminderCustomAlertAt);
      if (customDue && customDue <= now) {
        // eslint-disable-next-line no-await-in-loop
        await sendBookingReminder({
          booking,
          channel: booking.reminderChannel,
          kind: "custom",
          actorLabel: "system",
        });
      }
    }
  }
};

const toPatientSummary = (user, profile) => ({
  id: user.id,
  fullName: user.fullName,
  email: user.email || null,
  dob: profile?.dob || null,
  phone: profile?.phone || null,
  weightKg: toNumberOrNull(profile?.weightKg),
  weightLbs: toNumberOrNull(profile?.weightLbs),
});

const normalizeCatalogText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const normalizeDiagnosisKey = (value) =>
  normalizeCatalogText(value).replace(/[^a-z0-9]+/g, " ").trim();

const weightLbsToKg = (value) => {
  const parsed = toNumberOrNull(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number((parsed / 2.2046226218).toFixed(2));
};

const weightKgToLbs = (value) => {
  const parsed = toNumberOrNull(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number((parsed * 2.2046226218).toFixed(2));
};

const listDoctorApprovedPatientIds = async (doctorId) => {
  const directPatients = await User.findAll({
    where: { role: "patient", createdByDoctorId: doctorId },
  });
  const approvedConnections = await DoctorConnection.findAll({
    where: { doctorId, status: "approved" },
  });
  return new Set([
    ...directPatients.map((entry) => entry.id),
    ...approvedConnections.map((entry) => entry.patientId),
  ]);
};

const ensureDoctorCanAccessPatient = async (doctorId, patientId) => {
  const allowedPatientIds = await listDoctorApprovedPatientIds(doctorId);
  return allowedPatientIds.has(patientId);
};

const normalizeReceptionScopes = (payload = {}, fallback = null) => {
  const base = fallback || {
    canViewDemographics: true,
    canViewAppointments: true,
    canViewPrivateNotes: false,
    canViewPrescriptions: false,
  };
  const normalized = {};
  for (const key of RECEPTION_SCOPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      normalized[key] = Boolean(payload[key]);
    } else {
      normalized[key] = Boolean(base[key]);
    }
  }
  return normalized;
};

const getReceptionistGrant = async ({ doctorId, patientId, receptionistId }) => {
  return DoctorReceptionAccess.findOne({
    where: {
      doctorId,
      patientId,
      receptionistId,
      status: "active",
    },
  });
};

const ensureDoctorConnection = async (doctorId, patientId, source) => {
  let connection = await DoctorConnection.findOne({
    where: { doctorId, patientId },
  });
  if (!connection) {
    connection = await DoctorConnection.create({
      doctorId,
      patientId,
      status: "approved",
      source,
    });
    return connection;
  }
  if (connection.status !== "approved") {
    connection.status = "approved";
    connection.source = source || connection.source;
    await connection.save();
  }
  return connection;
};

const buildTaskInbox = async (doctorId) => {
  await runDueReminderRulesForDoctor(doctorId);
  const pendingConnections = await DoctorConnection.findAll({
    where: { doctorId, status: "pending" },
  });
  const bookings = await Appointment.findAll({ where: { doctorId } });
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);

  let pendingAppointments = 0;
  let dueReminders = 0;
  let todayAppointments = 0;
  let completedToday = 0;
  let unsignedSoapNotes = 0;
  let pendingRefillRequests = 0;
  let receptionistAlerts = 0;
  let pendingSymptomReports = 0;

  const soapNotes = await SoapNote.findAll({ where: { doctorId } });
  unsignedSoapNotes = soapNotes.filter((entry) => !entry.signedAt).length;
  const refillRequests = await RefillRequest.findAll({ where: { doctorId } });
  pendingRefillRequests = refillRequests.filter((entry) => entry.status === "pending").length;

  const items = [];
  for (const booking of bookings) {
    if (booking.status === "pending") pendingAppointments += 1;
    if (booking.status === "completed" && String(booking.startAt || "").slice(0, 10) === todayKey) {
      completedToday += 1;
    }
    if (String(booking.startAt || "").slice(0, 10) === todayKey) {
      todayAppointments += 1;
    }
    const reminder = getReminderSummary(booking);
    if (reminder.nextDueAt && new Date(reminder.nextDueAt) <= now) {
      dueReminders += 1;
    }
    if (booking.status === "pending" || (reminder.nextDueAt && new Date(reminder.nextDueAt) <= now)) {
      // eslint-disable-next-line no-await-in-loop
      const patient = await User.findByPk(booking.patientId);
      items.push({
        type: booking.status === "pending" ? "appointment_pending" : "reminder_due",
        bookingId: booking.id,
        patientName: patient?.fullName || booking.patientId,
        startAt: booking.startAt,
        status: booking.status,
        reminderDueAt: reminder.nextDueAt || null,
      });
    }
    const alerts = Array.isArray(booking.doctorAlerts) ? booking.doctorAlerts : [];
    const unreadAlerts = alerts.filter((entry) => entry?.read !== true);
    receptionistAlerts += unreadAlerts.length;
    for (const alert of unreadAlerts.slice(0, 2)) {
      items.push({
        type: "reception_alert",
        alertId: alert.id || null,
        bookingId: booking.id,
        patientId: booking.patientId,
        patientName: null,
        startAt: alert.at || booking.startAt,
        status: booking.status,
        alertType: alert.type || "reception_alert",
        alertMessage: alert.message || "Receptionist update",
        alertPriority: alert.priority || "normal",
      });
    }
  }

  for (const note of soapNotes.filter((entry) => !entry.signedAt).slice(0, 4)) {
    items.push({
      type: "unsigned_soap_note",
      noteId: note.id,
      patientId: note.patientId,
      startAt: note.createdAt,
      status: "unsigned",
    });
  }

  for (const refill of refillRequests.filter((entry) => entry.status === "pending").slice(0, 4)) {
    items.push({
      type: "pending_refill_request",
      refillRequestId: refill.id,
      patientId: refill.patientId,
      startAt: refill.createdAt,
      status: refill.status,
    });
  }

  const sharedSymptomReports = await PatientVisitPrepItem.findAll({
    where: { sharedDoctorId: doctorId, sharedWithDoctor: true },
  });
  const pendingReports = sharedSymptomReports.filter((entry) => !entry.reviewedByDoctorAt);
  pendingSymptomReports = pendingReports.length;
  for (const report of pendingReports.slice(0, 4)) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(report.patientId);
    items.push({
      type: "symptom_report_shared",
      reportId: report.id,
      patientId: report.patientId,
      patientName: patient?.fullName || report.patientId,
      startAt: report.sharedAt || report.createdAt,
      status: "shared",
      symptomName: report.symptomName || report.text || "Symptom report",
      symptomSeverity: report.symptomSeverity || null,
      sharedForVirtualDiagnosis: Boolean(report.sharedForVirtualDiagnosis),
    });
  }

  return {
    counts: {
      pendingConnections: pendingConnections.length,
      pendingAppointments,
      dueReminders,
      todayAppointments,
      completedToday,
      unsignedSoapNotes,
      pendingRefillRequests,
      receptionistAlerts,
      pendingSymptomReports,
    },
    items: items
      .sort((a, b) => new Date(b.startAt || b.reminderDueAt || 0) - new Date(a.startAt || a.reminderDueAt || 0))
      .slice(0, 12),
  };
};

router.get("/patients", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const rawQuery = String(req.query.query || "").trim();
  const query = rawQuery.toLowerCase();
  const allowedPatientIds = await listDoctorApprovedPatientIds(req.user.id);
  const users = await User.findAll({ where: { role: "patient" } });

  const queryHashes = rawQuery
    ? new Set([
      hashIdentifier(rawQuery),
      hashIdentifier(rawQuery.toUpperCase()),
      hashIdentifier(rawQuery.toLowerCase()),
    ])
    : null;
  const patients = [];
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const profile = await PatientProfile.findOne({ where: { userId: user.id } });
    if (query) {
      const nameMatch = String(user.fullName || "").toLowerCase().includes(query);
      const emailMatch = String(user.email || "").toLowerCase().includes(query);
      const idMatch = Boolean(profile?.idNumberHash && queryHashes?.has(profile.idNumberHash));
      const trnMatch = Boolean(profile?.trnHash && queryHashes?.has(profile.trnHash));
      if (!nameMatch && !emailMatch && !idMatch && !trnMatch) {
        // eslint-disable-next-line no-continue
        continue;
      }
    }
    patients.push({
      ...toPatientSummary(user, profile),
      hasSensitiveProfile: Boolean(profile),
      canPrescribe: allowedPatientIds.has(user.id),
    });
    if (patients.length >= 50) break;
  }
  res.json({ patients });
});

router.get("/pharmacies", requireAuth, requireRoles(["doctor"]), async (_req, res) => {
  const users = await User.findAll({ where: { role: "pharmacy" } });
  const pharmacies = users.map((user) => ({
    id: user.id,
    fullName: user.fullName,
    email: user.email || null,
  }));
  return res.json({ pharmacies });
});

router.get("/prescription-templates", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const customTemplates = await DoctorPrescriptionTemplate.findAll({
    where: { doctorId: req.user.id },
  });
  return res.json({
    templates: [
      ...DEFAULT_PRESCRIPTION_TEMPLATES.map((tpl) => ({ ...tpl, source: "system" })),
      ...customTemplates.map((tpl) => ({ ...tpl, source: "doctor" })),
    ],
  });
});

router.post("/prescription-templates", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const diagnosis = String(body.diagnosis || "").trim();
  const meds = Array.isArray(body.meds) ? body.meds : [];
  if (!name || !diagnosis || !meds.length) {
    return res.status(400).json({ error: "name, diagnosis, and at least one medication are required" });
  }
  const template = await DoctorPrescriptionTemplate.create({
    doctorId: req.user.id,
    name,
    diagnosis,
    meds,
    allowedRefills: Number(body.allowedRefills || 0),
    notes: String(body.notes || "").trim(),
  });
  return res.status(201).json({ template: { ...template, source: "doctor" } });
});

router.get("/favorite-meds", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const favorites = await DoctorFavoriteMed.findAll({ where: { doctorId: req.user.id } });
  return res.json({ favorites });
});

router.get("/quick-orders", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const favorites = await DoctorFavoriteMed.findAll({ where: { doctorId: req.user.id } });
  return res.json({
    quickOrders: favorites.map((entry) => ({
      id: entry.id,
      label: `${entry.name} ${entry.strength}`,
      med: {
        ndcCode: entry.ndcCode,
        name: entry.name,
        strength: entry.strength,
        qty: entry.qty,
        allowedRefills: entry.allowedRefills,
      },
    })),
  });
});

router.post("/favorite-meds", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  const med = body.med || {};
  const approved = findApprovedDrug({
    code: med.ndcCode,
    name: med.name,
    strength: med.strength,
  });
  if (!approved) {
    return res.status(400).json({ error: "Favorite medication must be MOH-approved." });
  }
  const existing = await DoctorFavoriteMed.findOne({
    where: { doctorId: req.user.id, ndcCode: approved.code, strength: med.strength },
  });
  if (existing) {
    return res.json({ favorite: existing });
  }
  const favorite = await DoctorFavoriteMed.create({
    doctorId: req.user.id,
    ndcCode: approved.code,
    name: approved.name,
    strength: med.strength,
    qty: Number(med.qty || 30),
    allowedRefills: Number(med.allowedRefills || 0),
    medicationType: approved.medicationType,
    usedFor: approved.usedFor,
    controlledSubstance: Boolean(approved.controlledSubstance),
  });
  return res.status(201).json({ favorite });
});

router.get(
  "/diagnosis-catalog/suggestions",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const query = normalizeDiagnosisKey(req.query?.query || "");
    const rows = await MohClinicalCatalogEntry.findAll({});
    const approved = rows.filter(
      (entry) => normalizeCatalogText(entry?.status || "pending") === "approved"
    );
    const suggestionMap = new Map();
    for (const entry of approved) {
      const label = String(entry.diagnosisLabel || "").trim();
      if (!label) continue;
      const code = String(entry.diagnosisCode || "").trim();
      const aliases = Array.isArray(entry.diagnosisAliases)
        ? entry.diagnosisAliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : [];
      const key = `${normalizeDiagnosisKey(code)}|${normalizeDiagnosisKey(label)}`;
      const haystack = [code, label, ...aliases].map(normalizeDiagnosisKey).join(" ");
      if (query && !haystack.includes(query)) continue;
      if (!suggestionMap.has(key)) {
        suggestionMap.set(key, {
          diagnosisCode: code || null,
          diagnosisLabel: label,
          aliases,
          diagnosisKey: key,
          mappingCount: 0,
        });
      }
      suggestionMap.get(key).mappingCount += 1;
    }
    const suggestions = Array.from(suggestionMap.values()).sort((a, b) =>
      String(a.diagnosisLabel || "").localeCompare(String(b.diagnosisLabel || ""))
    );
    return res.json({ suggestions: suggestions.slice(0, 25) });
  }
);

router.get(
  "/diagnosis-catalog/mappings",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const diagnosisQuery = normalizeDiagnosisKey(req.query?.diagnosis || "");
    const diagnosisCode = normalizeDiagnosisKey(req.query?.diagnosisCode || "");
    if (!diagnosisQuery && !diagnosisCode) {
      return res.status(400).json({ error: "diagnosis or diagnosisCode is required" });
    }
    const rows = await MohClinicalCatalogEntry.findAll({});
    const approved = rows.filter(
      (entry) => normalizeCatalogText(entry?.status || "pending") === "approved"
    );
    const mappings = approved
      .filter((entry) => {
        const entryCode = normalizeDiagnosisKey(entry.diagnosisCode || "");
        const entryLabel = normalizeDiagnosisKey(entry.diagnosisLabel || "");
        const aliasValues = Array.isArray(entry.diagnosisAliases)
          ? entry.diagnosisAliases.map((alias) => normalizeDiagnosisKey(alias))
          : [];
        if (diagnosisCode && entryCode === diagnosisCode) return true;
        if (!diagnosisQuery) return false;
        return (
          entryLabel.includes(diagnosisQuery) ||
          aliasValues.some((alias) => alias.includes(diagnosisQuery))
        );
      })
      .map((entry) => ({
        id: entry.id,
        diagnosisCode: entry.diagnosisCode || null,
        diagnosisLabel: entry.diagnosisLabel || null,
        medication: {
          code: entry.medicationCode || null,
          name: entry.medicationName || null,
          medicationType: entry.medicationType || null,
          usedFor: entry.usedFor || null,
          strengths: Array.isArray(entry.strengths) ? entry.strengths : [],
          defaultStrength: entry.defaultStrength || null,
          controlledSubstance: Boolean(entry.controlledSubstance),
        },
        policyCode: entry.policyCode || null,
      }))
      .sort((a, b) => String(a.medication?.name || "").localeCompare(String(b.medication?.name || "")));
    return res.json({ mappings });
  }
);

router.post("/follow-up-plan/generate", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  const diagnosis = String(body.diagnosis || "").trim();
  if (!diagnosis) {
    return res.status(400).json({ error: "diagnosis is required" });
  }
  const patientName = String(body.patientName || "Patient").trim();
  const meds = Array.isArray(body.meds) ? body.meds : [];
  const nextVisitDays = Number(body.nextVisitDays || 14);
  const actions = [
    "Continue prescribed medications as directed.",
    "Monitor symptoms daily and report worsening signs immediately.",
    "Complete labs/vitals review before next visit.",
    "Confirm medication adherence and side-effect tolerance.",
  ];
  const medSummary = meds.length
    ? meds.map((med) => `${med.name || med.ndcCode} ${med.strength || ""}`.trim()).join(", ")
    : "No medications listed.";
  const planText = [
    `Follow-up Plan - ${diagnosis}`,
    `Patient: ${patientName}`,
    `Medications: ${medSummary}`,
    `Next review: ${nextVisitDays} day(s)`,
    "",
    ...actions.map((action, idx) => `${idx + 1}. ${action}`),
  ].join("\n");

  return res.json({
    plan: {
      diagnosis,
      patientName,
      meds,
      nextVisitDays,
      actions,
      text: planText,
      generatedAt: new Date().toISOString(),
    },
  });
});

router.get("/task-inbox", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const inbox = await buildTaskInbox(req.user.id);
  return res.json(inbox);
});

router.get(
  "/patients/:id/symptom-reports",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patient = await User.findByPk(req.params.id);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }
    const allowedPatientIds = await listDoctorApprovedPatientIds(req.user.id);
    if (!allowedPatientIds.has(patient.id)) {
      await ensureDoctorConnection(req.user.id, patient.id, "doctor_symptom_reports_access");
    }

    const reports = await PatientVisitPrepItem.findAll({ where: { patientId: patient.id } });
    const sharedDoctorIds = Array.from(
      new Set(reports.map((entry) => String(entry.sharedDoctorId || "").trim()).filter(Boolean))
    );
    const sharedDoctorNameById = new Map();
    for (const doctorId of sharedDoctorIds) {
      // eslint-disable-next-line no-await-in-loop
      const doctor = await User.findByPk(doctorId);
      if (doctor && doctor.role === "doctor") {
        sharedDoctorNameById.set(doctorId, doctor.fullName || null);
      }
    }

    const normalized = reports
      .map((entry) => {
        const sharedDoctorId = String(entry.sharedDoctorId || "").trim() || null;
        const isSharedToCurrentDoctor =
          Boolean(entry.sharedWithDoctor) && sharedDoctorId === String(req.user.id);
        return {
          id: entry.id,
          patientId: entry.patientId,
          text: entry.text || "",
          category: entry.category || "question",
          visitDate: entry.visitDate || null,
          symptomName: entry.symptomName || null,
          symptomExplanation: entry.symptomExplanation || null,
          symptomSeverity: entry.symptomSeverity || null,
          occurredAt: entry.occurredAt || null,
          completed: Boolean(entry.completed),
          sharedWithDoctor: Boolean(entry.sharedWithDoctor),
          sharedDoctorId,
          sharedDoctorName: sharedDoctorId ? sharedDoctorNameById.get(sharedDoctorId) || null : null,
          sharedAt: entry.sharedAt || null,
          sharedForVirtualDiagnosis: Boolean(entry.sharedForVirtualDiagnosis),
          sharedNote: entry.sharedNote || null,
          reviewedByDoctorAt: entry.reviewedByDoctorAt || null,
          reviewedByDoctorId: entry.reviewedByDoctorId || null,
          doctorReviewNote: entry.doctorReviewNote || null,
          isSharedToCurrentDoctor,
          canReview: isSharedToCurrentDoctor && !entry.reviewedByDoctorAt,
          createdAt: entry.createdAt || null,
          updatedAt: entry.updatedAt || null,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.occurredAt || b.sharedAt || b.createdAt || 0) -
          new Date(a.occurredAt || a.sharedAt || a.createdAt || 0)
      );

    return res.json({ reports: normalized });
  }
);

router.post(
  "/patient-symptom-reports/:id/review",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const report = await PatientVisitPrepItem.findByPk(req.params.id);
    if (!report || String(report.sharedDoctorId || "") !== String(req.user.id) || !report.sharedWithDoctor) {
      return res.status(404).json({ error: "Shared symptom report not found" });
    }
    report.reviewedByDoctorAt = new Date().toISOString();
    report.reviewedByDoctorId = req.user.id;
    report.doctorReviewNote = String(req.body?.note || "").trim() || null;
    await report.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.patient_symptom_report.review",
      entityType: "patient_visit_prep_item",
      entityId: report.id,
      metadata: { patientId: report.patientId },
    });
    return res.json({ report });
  }
);

router.get(
  "/patient-symptom-reports/:id",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const report = await PatientVisitPrepItem.findByPk(req.params.id);
    if (!report || String(report.sharedDoctorId || "") !== String(req.user.id) || !report.sharedWithDoctor) {
      return res.status(404).json({ error: "Shared symptom report not found" });
    }
    const patient = await User.findByPk(report.patientId);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }
    const profile = await PatientProfile.findOne({ where: { userId: patient.id } });
    return res.json({
      report: {
        id: report.id,
        patientId: report.patientId,
        text: report.text || "",
        category: report.category || "question",
        visitDate: report.visitDate || null,
        symptomName: report.symptomName || null,
        symptomExplanation: report.symptomExplanation || null,
        symptomSeverity: report.symptomSeverity || null,
        occurredAt: report.occurredAt || null,
        completed: Boolean(report.completed),
        sharedAt: report.sharedAt || null,
        sharedForVirtualDiagnosis: Boolean(report.sharedForVirtualDiagnosis),
        sharedNote: report.sharedNote || null,
        reviewedByDoctorAt: report.reviewedByDoctorAt || null,
        reviewedByDoctorId: report.reviewedByDoctorId || null,
        doctorReviewNote: report.doctorReviewNote || null,
        createdAt: report.createdAt || null,
        updatedAt: report.updatedAt || null,
      },
      patient: {
        id: patient.id,
        fullName: patient.fullName || null,
        email: patient.email || null,
        phone: profile?.phone || null,
        dob: profile?.dob || null,
      },
    });
  }
);

router.post(
  "/appointments/:id/reception-alerts/:alertId/read",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    const alertId = String(req.params.alertId || "").trim();
    if (!alertId) {
      return res.status(400).json({ error: "alertId is required" });
    }
    const alerts = Array.isArray(booking.doctorAlerts) ? booking.doctorAlerts : [];
    let found = false;
    const nextAlerts = alerts.map((entry) => {
      if (String(entry?.id || "") !== alertId) return entry;
      found = true;
      return {
        ...entry,
        read: true,
        readAt: new Date().toISOString(),
        readBy: req.user.id,
      };
    });
    if (!found) {
      return res.status(404).json({ error: "Alert not found" });
    }
    booking.doctorAlerts = nextAlerts;
    await booking.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.reception_alert.read",
      entityType: "appointment",
      entityId: booking.id,
      metadata: { alertId },
    });

    return res.json({ ok: true });
  }
);

router.post("/patients", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  if (!body.fullName || !body.email || !body.password) {
    return res.status(400).json({ error: "fullName, email, and password are required" });
  }

  const email = normalizeEmail(body.email);
  const emailHash = hashIdentifier(email);
  const existing = await User.findOne({ where: { emailHash } });
  if (existing) {
    return res.status(409).json({ error: "Patient already exists with this email" });
  }

  const user = await User.create({
    fullName: body.fullName,
    email,
    role: "patient",
    passwordHash: await hashPassword(body.password),
    createdByDoctorId: req.user.id,
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
    weightKg: toNumberOrNull(body.weightKg),
    weightLbs: toNumberOrNull(body.weightLbs),
  });

  await DoctorConnection.create({
    doctorId: req.user.id,
    patientId: user.id,
    status: "approved",
    source: "doctor_created",
  });

  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.patient.create",
    entityType: "user",
    entityId: user.id,
  });

  res.status(201).json({
    patient: {
      ...toPatientSummary(user, profile),
      idNumberLast4: idNumberRaw ? idNumberRaw.slice(-4) : null,
      trnLast4: trnRaw ? trnRaw.slice(-4) : null,
    },
    credentialsIssued: { email, temporaryPassword: body.password },
  });
});

router.put("/patients/:id", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patient = await User.findByPk(req.params.id);
  if (!patient || patient.role !== "patient") {
    return res.status(404).json({ error: "Patient not found" });
  }
  const allowedPatientIds = await listDoctorApprovedPatientIds(req.user.id);
  if (!allowedPatientIds.has(patient.id)) {
    await ensureDoctorConnection(req.user.id, patient.id, "doctor_patient_update");
  }

  const body = req.body || {};

  if (typeof body.fullName === "string") {
    const nextName = body.fullName.trim();
    if (nextName) patient.fullName = nextName;
  }

  if (typeof body.email === "string" && body.email.trim()) {
    const nextEmail = normalizeEmail(body.email);
    const nextEmailHash = hashIdentifier(nextEmail);
    if (nextEmailHash !== patient.emailHash) {
      const existing = await User.findOne({ where: { emailHash: nextEmailHash } });
      if (existing && existing.id !== patient.id) {
        return res.status(409).json({ error: "Another user already has that email" });
      }
      patient.email = nextEmail;
      patient.emailHash = nextEmailHash;
    }
  }
  await patient.save();

  let profile = await PatientProfile.findOne({ where: { userId: patient.id } });
  if (!profile) {
    profile = await PatientProfile.create({ userId: patient.id });
  }

  if (Object.prototype.hasOwnProperty.call(body, "dob")) {
    profile.dob = body.dob || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "phone")) {
    profile.phone = body.phone || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "address")) {
    profile.address = body.address ? encryptValue(body.address) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "idNumber")) {
    const idNumberRaw = String(body.idNumber || "").trim();
    profile.idNumber = idNumberRaw ? encryptValue(idNumberRaw) : null;
    profile.idNumberHash = idNumberRaw ? hashIdentifier(idNumberRaw) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "trn")) {
    const trnRaw = String(body.trn || "").trim();
    profile.trn = trnRaw ? encryptValue(trnRaw) : null;
    profile.trnHash = trnRaw ? hashIdentifier(trnRaw) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "emergencyContactName")) {
    profile.emergencyContactName = body.emergencyContactName
      ? encryptValue(body.emergencyContactName)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "emergencyContactPhone")) {
    profile.emergencyContactPhone = body.emergencyContactPhone
      ? encryptValue(body.emergencyContactPhone)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "allergies")) {
    const allergies = parseAllergyListInput(body.allergies);
    profile.allergies = allergies.length ? encryptValue(JSON.stringify(allergies)) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "weightKg")) {
    profile.weightKg = toNumberOrNull(body.weightKg);
    if (profile.weightKg && !Object.prototype.hasOwnProperty.call(body, "weightLbs")) {
      profile.weightLbs = weightKgToLbs(profile.weightKg);
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "weightLbs")) {
    profile.weightLbs = toNumberOrNull(body.weightLbs);
    if (profile.weightLbs && !Object.prototype.hasOwnProperty.call(body, "weightKg")) {
      profile.weightKg = weightLbsToKg(profile.weightLbs);
    }
  }
  await profile.save();

  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.patient.update",
    entityType: "user",
    entityId: patient.id,
  });

  return res.json({
    patient: {
      ...toPatientSummary(patient, profile),
      address: profile?.address ? decryptValue(profile.address) : null,
      idNumber: profile?.idNumber ? decryptValue(profile.idNumber) : null,
      trn: profile?.trn ? decryptValue(profile.trn) : null,
      emergencyContactName: profile?.emergencyContactName
        ? decryptValue(profile.emergencyContactName)
        : null,
      emergencyContactPhone: profile?.emergencyContactPhone
        ? decryptValue(profile.emergencyContactPhone)
        : null,
      allergies: decodeAllergyListFromProfile(profile),
      weightKg: toNumberOrNull(profile?.weightKg),
      weightLbs: toNumberOrNull(profile?.weightLbs),
    },
  });
});

router.get(
  "/patients/:id/record",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patient = await User.findByPk(req.params.id);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }
    const allowedPatientIds = await listDoctorApprovedPatientIds(req.user.id);
    if (!allowedPatientIds.has(patient.id)) {
      await ensureDoctorConnection(req.user.id, patient.id, "doctor_record_access");
    }

    const profile = await PatientProfile.findOne({ where: { userId: patient.id } });
    const prescriptions = await Prescription.findAll({ where: { patientId: patient.id } });
    const patientOrders = await Order.findAll({ where: { patientId: patient.id } });

    const orders = patientOrders
      .filter((order) => prescriptions.some((p) => p.id === order.prescId))
      .map((order) => ({
        id: order.id,
        prescId: order.prescId,
        orderStatus: order.orderStatus,
        deliveryOption: order.deliveryOption,
        createdAt: order.createdAt,
      }));

    res.json({
      patient: {
        id: patient.id,
        fullName: patient.fullName,
        email: patient.email || null,
        dob: profile?.dob || null,
        phone: profile?.phone || null,
        address: profile?.address ? decryptValue(profile.address) : null,
        idNumber: profile?.idNumber ? decryptValue(profile.idNumber) : null,
        trn: profile?.trn ? decryptValue(profile.trn) : null,
        emergencyContactName: profile?.emergencyContactName
          ? decryptValue(profile.emergencyContactName)
          : null,
        emergencyContactPhone: profile?.emergencyContactPhone
          ? decryptValue(profile.emergencyContactPhone)
          : null,
        allergies: decodeAllergyListFromProfile(profile),
        weightKg: toNumberOrNull(profile?.weightKg),
        weightLbs: toNumberOrNull(profile?.weightLbs),
      },
      prescriptions: prescriptions.map((entry) => ({
        id: entry.id,
        meds: entry.meds,
        allowedRefills: Number(entry.allowedRefills || 0),
        createdAt: entry.createdAt,
        expiryDate: entry.expiryDate,
        linked: entry.linked,
      })),
      orders,
    });
  }
);

router.get(
  "/patients/:id/timeline",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patient = await User.findByPk(req.params.id);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }
    const allowedPatientIds = await listDoctorApprovedPatientIds(req.user.id);
    if (!allowedPatientIds.has(patient.id)) {
      await ensureDoctorConnection(req.user.id, patient.id, "doctor_timeline_access");
    }

    const appointments = await Appointment.findAll({
      where: { doctorId: req.user.id, patientId: patient.id },
    });
    const prescriptions = await Prescription.findAll({ where: { patientId: patient.id } });
    const orders = await Order.findAll({ where: { patientId: patient.id } });
    const relevantOrders = orders.filter((order) =>
      prescriptions.some((prescription) => prescription.id === order.prescId)
    );
    const thread = await ChatThread.findOne({
      where: { doctorId: req.user.id, patientId: patient.id },
    });
    const messages = thread
      ? await ChatMessage.findAll({ where: { threadId: thread.id } })
      : [];

    const timeline = [];
    for (const appt of appointments) {
      timeline.push({
        type: "visit",
        status: appt.status,
        source: appt.source || "appointment",
        reason: appt.reason || null,
        triageTags: Array.isArray(appt.triageTags) ? appt.triageTags : [],
        timestamp: appt.startAt || appt.createdAt,
      });
    }
    for (const prescription of prescriptions) {
      timeline.push({
        type: "prescription",
        status: "issued",
        prescriptionId: prescription.id,
        meds: prescription.meds || [],
        allowedRefills: Number(prescription.allowedRefills || 0),
        timestamp: prescription.createdAt,
      });
    }
    for (const order of relevantOrders) {
      timeline.push({
        type: "fill",
        status: order.orderStatus,
        orderId: order.id,
        prescriptionId: order.prescId,
        timestamp: order.createdAt,
      });
    }
    for (const message of messages) {
      timeline.push({
        type: "chat",
        status: message.senderId === req.user.id ? "doctor" : "patient",
        preview: String(message.message || "").slice(0, 120),
        timestamp: message.createdAt,
      });
    }

    const missedDoseSignals = [];
    for (const prescription of prescriptions) {
      const hasCompletedFill = relevantOrders.some(
        (order) => order.prescId === prescription.id && order.orderStatus === "completed"
      );
      if (!hasCompletedFill && toValidDate(prescription.createdAt)) {
        const ageDays =
          (Date.now() - new Date(prescription.createdAt).getTime()) / (24 * 60 * 60 * 1000);
        if (ageDays > 14) {
          missedDoseSignals.push({
            type: "missed_dose_signal",
            prescriptionId: prescription.id,
            message: "No completed fill recorded for active prescription in >14 days.",
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    for (const signal of missedDoseSignals) {
      timeline.push(signal);
    }

    timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const completedVisits = appointments.filter((entry) => entry.status === "completed");
    const lastSeenAt = completedVisits.length
      ? completedVisits.sort((a, b) => new Date(b.startAt) - new Date(a.startAt))[0].startAt
      : messages.length
        ? messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0].createdAt
        : null;
    const upcomingAppointments = appointments
      .filter((entry) => ["pending", "approved"].includes(entry.status))
      .filter((entry) => toValidDate(entry.startAt) && new Date(entry.startAt) > new Date())
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const nextDueAt = upcomingAppointments.length
      ? upcomingAppointments[0].startAt
      : prescriptions
        .filter((entry) => entry.expiryDate && toValidDate(entry.expiryDate))
        .sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate))[0]?.expiryDate || null;

    const noShowCount = appointments.filter((entry) => entry.status === "no_show").length;
    const failedOrders = relevantOrders.filter((entry) => entry.orderStatus === "failed").length;
    const riskFlags = [];
    if (noShowCount >= 2) {
      riskFlags.push({
        type: "repeated_no_show",
        severity: "high",
        message: `${noShowCount} no-show events recorded.`,
      });
    }
    if (failedOrders >= 2 || missedDoseSignals.length >= 1) {
      riskFlags.push({
        type: "non_adherence",
        severity: failedOrders >= 2 ? "high" : "moderate",
        message:
          failedOrders >= 2
            ? `${failedOrders} failed fills indicate adherence risk.`
            : "Potential non-adherence detected from missed dose signals.",
      });
    }

    return res.json({
      patient: {
        id: patient.id,
        fullName: patient.fullName,
      },
      indicators: {
        lastSeenAt,
        nextDueAt,
      },
      riskFlags,
      timeline: timeline.slice(0, 120),
    });
  }
);

router.get(
  "/patients/:id/private-notes",
  requireAuth,
  requireRoles(["doctor", "receptionist", "admin"]),
  async (req, res) => {
    const patient = await User.findByPk(req.params.id);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }

    const where = { patientId: patient.id };
    if (req.user.role === "doctor") {
      where.doctorId = req.user.id;
    } else if (req.user.role === "receptionist") {
      const doctorId = String(req.query.doctorId || "").trim();
      if (!doctorId) {
        return res.status(400).json({ error: "doctorId query is required for receptionist access" });
      }
      const grant = await getReceptionistGrant({
        doctorId,
        patientId: patient.id,
        receptionistId: req.user.id,
      });
      if (!grant || !grant.canViewPrivateNotes) {
        return res.status(403).json({ error: "Receptionist is not authorized for private notes" });
      }
      where.doctorId = doctorId;
    } else if (req.query.doctorId) {
      where.doctorId = req.query.doctorId;
    }

    const notes = await DoctorPrivateNote.findAll({ where });
    notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({
      notes: notes.map((entry) => ({
        ...entry,
        visibility: "doctor_receptionist_only",
      })),
    });
  }
);

router.post(
  "/patients/:id/private-notes",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patient = await User.findByPk(req.params.id);
    if (!patient || patient.role !== "patient") {
      return res.status(404).json({ error: "Patient not found" });
    }
    const text = String(req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const note = await DoctorPrivateNote.create({
      doctorId: req.user.id,
      patientId: patient.id,
      text,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 8) : [],
      visibility: "doctor_receptionist_only",
    });
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.patient.private_note.create",
      entityType: "doctor_private_note",
      entityId: note.id,
    });
    return res.status(201).json({ note });
  }
);

router.post("/receptionists", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const fullName = String(req.body?.fullName || "").trim();
  const rawEmail = String(req.body?.email || "").trim();
  const requestedPassword = String(req.body?.password || "").trim();
  if (!fullName || !rawEmail) {
    return res.status(400).json({ error: "fullName and email are required" });
  }

  const email = normalizeEmail(rawEmail);
  const emailHash = hashIdentifier(email);
  const existing = await User.findOne({ where: { emailHash } });
  if (existing) {
    return res.status(409).json({ error: "A user with this email already exists" });
  }

  const temporaryPassword = requestedPassword || `Rcpt-${randomCode()}!`;
  const passwordHash = await hashPassword(temporaryPassword);
  const receptionist = await User.create({
    fullName,
    email,
    passwordHash,
    role: "receptionist",
    createdByDoctorId: req.user.id,
    platformStaffId: await nextPlatformStaffIdForRole({
      UserModel: User,
      role: "receptionist",
      doctorId: req.user.id,
    }),
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.receptionist.create",
    entityType: "user",
    entityId: receptionist.id,
    metadata: {
      role: receptionist.role,
      createdByDoctorId: req.user.id,
      platformStaffId: receptionist.platformStaffId || null,
    },
  });

  return res.status(201).json({
    receptionist: {
      id: receptionist.id,
      fullName: receptionist.fullName,
      email: receptionist.email,
      role: receptionist.role,
      platformStaffId: receptionist.platformStaffId || null,
      certificationId: receptionist.platformStaffId || null,
      createdByDoctorId: receptionist.createdByDoctorId || null,
    },
    credentialsIssued: {
      email: receptionist.email,
      temporaryPassword,
    },
  });
});

router.get("/receptionists", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = String(req.query.patientId || "").trim();
  const query = String(req.query.query || "").trim().toLowerCase();
  let allowed = true;
  if (patientId) {
    allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
  }
  if (!allowed) {
    return res.status(403).json({ error: "No access to patient" });
  }

  const receptionists = await User.findAll({ where: { role: "receptionist" } });
  for (const receptionist of receptionists) {
    // Ensure older receptionist records receive a stable platform ID for audit/search use.
    // eslint-disable-next-line no-await-in-loop
    await ensurePlatformStaffId({ UserModel: User, user: receptionist, role: "receptionist" });
  }
  const grants = patientId
    ? await DoctorReceptionAccess.findAll({
        where: { doctorId: req.user.id, patientId, status: "active" },
      })
    : [];
  const grantByReceptionistId = new Map(grants.map((entry) => [entry.receptionistId, entry]));

  const ordered = receptionists
    .filter((entry) => {
      if (!query) return true;
      const target = `${entry.fullName || ""} ${entry.email || ""} ${entry.platformStaffId || ""}`.toLowerCase();
      return target.includes(query);
    })
    .slice()
    .sort((a, b) => {
      const aOwned = a.createdByDoctorId === req.user.id ? 1 : 0;
      const bOwned = b.createdByDoctorId === req.user.id ? 1 : 0;
      if (aOwned !== bOwned) return bOwned - aOwned;
      return String(a.fullName || "").localeCompare(String(b.fullName || ""));
    });

  return res.json({
    receptionists: ordered.map((entry) => {
      const grant = grantByReceptionistId.get(entry.id) || null;
      return {
        id: entry.id,
        fullName: entry.fullName,
        email: entry.email || null,
        platformStaffId: entry.platformStaffId || null,
        certificationId: entry.platformStaffId || null,
        createdByDoctorId: entry.createdByDoctorId || null,
        ownedByCurrentDoctor: entry.createdByDoctorId === req.user.id,
        grant: grant
          ? {
              id: grant.id,
              status: grant.status,
              scopes: normalizeReceptionScopes(grant, grant),
              updatedAt: grant.updatedAt,
            }
          : null,
      };
    }),
  });
});

router.post(
  "/receptionists/:id/assign-owner",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const receptionistId = String(req.params.id || "").trim();
    if (!receptionistId) {
      return res.status(400).json({ error: "receptionist id is required" });
    }

    const receptionist = await User.findByPk(receptionistId);
    if (!receptionist || receptionist.role !== "receptionist") {
      return res.status(404).json({ error: "Receptionist not found" });
    }

    const forceTransfer = Boolean(req.body?.forceTransfer);
    const currentOwnerId = receptionist.createdByDoctorId || null;
    if (currentOwnerId && currentOwnerId !== req.user.id && !forceTransfer) {
      return res.status(409).json({
        error: "Receptionist is already assigned to another doctor. Set forceTransfer=true to reassign.",
        currentOwnerId,
      });
    }

    receptionist.createdByDoctorId = req.user.id;
    if (!receptionist.platformStaffId) {
      receptionist.platformStaffId = await nextPlatformStaffIdForRole({
        UserModel: User,
        role: "receptionist",
        doctorId: req.user.id,
      });
    }
    await receptionist.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.receptionist.assign_owner",
      entityType: "user",
      entityId: receptionist.id,
      metadata: {
        previousOwnerId: currentOwnerId,
        nextOwnerId: req.user.id,
        forceTransfer,
        platformStaffId: receptionist.platformStaffId || null,
      },
    });

    return res.status(201).json({
      receptionist: {
        id: receptionist.id,
        fullName: receptionist.fullName,
        email: receptionist.email || null,
        role: receptionist.role,
        platformStaffId: receptionist.platformStaffId || null,
        certificationId: receptionist.platformStaffId || null,
        createdByDoctorId: receptionist.createdByDoctorId || null,
        ownedByCurrentDoctor: receptionist.createdByDoctorId === req.user.id,
      },
    });
  }
);

router.get(
  "/patients/:id/receptionist-access",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patientId = req.params.id;
    const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
    if (!allowed) return res.status(403).json({ error: "No access to patient" });

    const accessRows = await DoctorReceptionAccess.findAll({
      where: { doctorId: req.user.id, patientId, status: "active" },
    });
    const receptionistIds = Array.from(new Set(accessRows.map((entry) => entry.receptionistId)));
    const receptionistMap = new Map();
    for (const id of receptionistIds) {
      // eslint-disable-next-line no-await-in-loop
      const receptionist = await User.findByPk(id);
      if (receptionist && receptionist.role === "receptionist") {
        receptionistMap.set(id, receptionist);
      }
    }

    const access = accessRows
      .map((entry) => ({
        id: entry.id,
        receptionistId: entry.receptionistId,
        receptionistName: receptionistMap.get(entry.receptionistId)?.fullName || "Unknown receptionist",
        receptionistPlatformStaffId: receptionistMap.get(entry.receptionistId)?.platformStaffId || null,
        receptionistCertificationId: receptionistMap.get(entry.receptionistId)?.platformStaffId || null,
        status: entry.status,
        scopes: normalizeReceptionScopes(entry, entry),
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.receptionistName.localeCompare(b.receptionistName));

    return res.json({ access });
  }
);

router.post(
  "/patients/:id/receptionist-access",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patientId = req.params.id;
    const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
    if (!allowed) return res.status(403).json({ error: "No access to patient" });

    const receptionistId = String(req.body?.receptionistId || "").trim();
    if (!receptionistId) return res.status(400).json({ error: "receptionistId is required" });
    const receptionist = await User.findByPk(receptionistId);
    if (!receptionist || receptionist.role !== "receptionist") {
      return res.status(404).json({ error: "Receptionist not found" });
    }

    const scopes = normalizeReceptionScopes(req.body, null);
    let grant = await DoctorReceptionAccess.findOne({
      where: {
        doctorId: req.user.id,
        patientId,
        receptionistId,
      },
    });
    if (!grant) {
      grant = await DoctorReceptionAccess.create({
        doctorId: req.user.id,
        patientId,
        receptionistId,
        status: "active",
        ...scopes,
      });
    } else {
      Object.assign(grant, scopes, { status: "active" });
      await grant.save();
    }
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.receptionist_access.upsert",
      entityType: "doctor_reception_access",
      entityId: grant.id,
      metadata: {
        patientId,
        receptionistId,
        receptionistPlatformStaffId: receptionist.platformStaffId || null,
        scopes,
      },
    });
    return res.status(201).json({
      access: {
        id: grant.id,
        receptionistId: grant.receptionistId,
        receptionistPlatformStaffId: receptionist.platformStaffId || null,
        receptionistCertificationId: receptionist.platformStaffId || null,
        status: grant.status,
        scopes: normalizeReceptionScopes(grant, grant),
        updatedAt: grant.updatedAt,
      },
    });
  }
);

router.delete(
  "/patients/:id/receptionist-access/:receptionistId",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const patientId = req.params.id;
    const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
    if (!allowed) return res.status(403).json({ error: "No access to patient" });

    const grant = await DoctorReceptionAccess.findOne({
      where: {
        doctorId: req.user.id,
        patientId,
        receptionistId: req.params.receptionistId,
      },
    });
    if (!grant) return res.status(404).json({ error: "Access grant not found" });
    grant.status = "revoked";
    await grant.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.receptionist_access.revoke",
      entityType: "doctor_reception_access",
      entityId: grant.id,
      metadata: {
        patientId,
        receptionistId: grant.receptionistId,
        receptionistPlatformStaffId: (await User.findByPk(grant.receptionistId))?.platformStaffId || null,
      },
    });
    return res.json({ revoked: true });
  }
);

router.post(
  "/appointments/availability",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const body = req.body || {};
    if (!body.startAt || !body.endAt) {
      return res.status(400).json({ error: "startAt and endAt are required" });
    }
    const availability = await AppointmentAvailability.create({
      doctorId: req.user.id,
      startAt: body.startAt,
      endAt: body.endAt,
      mode: body.mode || "in-person",
      location: body.location || null,
      maxBookings: Number(body.maxBookings || 1),
      feeRequired: Boolean(body.feeRequired),
      feeAmount: toMoney(body.feeAmount || 0),
      feeCurrency: normalizeFeeCurrency(body.feeCurrency),
      isActive: true,
    });
    return res.status(201).json({ availability });
  }
);

router.get(
  "/appointments/availability",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const slots = await AppointmentAvailability.findAll({
      where: { doctorId: req.user.id },
    });
    const availability = slots
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
      .map((slot) => ({
        ...slot,
        isActive: slot.isActive !== false,
      }));
    res.json({ availability });
  }
);

router.post(
  "/appointments/availability/:id/deactivate",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const slot = await AppointmentAvailability.findByPk(req.params.id);
    if (!slot || slot.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Availability slot not found" });
    }
    slot.isActive = false;
    await slot.save();
    return res.json({ availability: slot });
  }
);

router.get(
  "/appointments/bookings",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    await runDueReminderRulesForDoctor(req.user.id);
    const status = req.query.status || "";
    const all = await Appointment.findAll({ where: { doctorId: req.user.id } });
    const filtered = status ? all.filter((entry) => entry.status === status) : all;
    const bookings = [];
    for (const entry of filtered.sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
      // eslint-disable-next-line no-await-in-loop
      const patient = await User.findByPk(entry.patientId);
      bookings.push({
        ...entry,
        patientName: patient?.fullName || null,
        patientEmail: patient?.email || null,
        reminder: getReminderSummary(entry),
      });
    }
    res.json({ bookings });
  }
);

router.get(
  "/appointments/waitlist",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const entries = await AppointmentWaitlist.findAll({
      where: { doctorId: req.user.id },
    });
    const waitlist = entries.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return res.json({ waitlist });
  }
);

router.post(
  "/appointments/waitlist/auto-fill",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const waiting = await AppointmentWaitlist.findAll({
      where: { doctorId: req.user.id, status: "waiting" },
    });
    const slots = await AppointmentAvailability.findAll({
      where: { doctorId: req.user.id },
    });
    const activeFutureSlots = slots
      .filter((slot) => slot.isActive !== false && new Date(slot.startAt) > new Date())
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const existingBookings = await Appointment.findAll({ where: { doctorId: req.user.id } });
    const filled = [];

    for (const slot of activeFutureSlots) {
      const maxBookings = Number(slot.maxBookings || 1);
      const slotBookings = existingBookings.filter((booking) => booking.availabilityId === slot.id);
      const openSpots = Math.max(0, maxBookings - slotBookings.length);
      if (!openSpots) continue;

      for (let i = 0; i < openSpots; i += 1) {
        const entry = waiting.find((candidate) => {
          if (candidate.status !== "waiting") return false;
          if (!candidate.preferredDate) return true;
          return dateKey(candidate.preferredDate) === dateKey(slot.startAt);
        });
        if (!entry) break;

        const duplicateForSlot = existingBookings.some(
          (booking) => booking.availabilityId === slot.id && booking.patientId === entry.patientId
        );
        if (duplicateForSlot) {
          entry.status = "skipped_duplicate";
          // eslint-disable-next-line no-await-in-loop
          await entry.save();
          // eslint-disable-next-line no-continue
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const booking = await Appointment.create({
          availabilityId: slot.id,
          doctorId: req.user.id,
          patientId: entry.patientId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          mode: slot.mode || "in-person",
          location: slot.location || null,
          reason: entry.reason || "Auto-filled from waitlist",
          triageTags: Array.isArray(entry.triageTags)
            ? entry.triageTags
            : triageTagsFromReason(entry.reason),
          source: "waitlist_autofill",
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
          feeCurrency: normalizeFeeCurrency(slot.feeCurrency),
          paymentStatus:
            Boolean(slot.feeRequired) && toMoney(slot.feeAmount || 0) > 0 ? "unpaid" : "not_required",
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
        existingBookings.push(booking);

        entry.status = "booked";
        entry.bookedAppointmentId = booking.id;
        entry.bookedAt = new Date().toISOString();
        // eslint-disable-next-line no-await-in-loop
        await entry.save();
        filled.push({ waitlistId: entry.id, bookingId: booking.id, startAt: booking.startAt });
      }
    }

    return res.json({
      filled,
      filledCount: filled.length,
      remainingWaitlistCount: waiting.filter((entry) => entry.status === "waiting").length,
    });
  }
);

router.get(
  "/appointments/intelligence",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const now = new Date();
    const bookings = await Appointment.findAll({ where: { doctorId: req.user.id } });
    const waitlist = await AppointmentWaitlist.findAll({
      where: { doctorId: req.user.id, status: "waiting" },
    });
    const predictions = [];

    for (const booking of bookings) {
      if (!["pending", "approved"].includes(booking.status)) continue;
      const startAt = toValidDate(booking.startAt);
      if (!startAt || startAt <= now) continue;

      const history = bookings.filter(
        (entry) =>
          entry.patientId === booking.patientId &&
          toValidDate(entry.startAt) &&
          new Date(entry.startAt) < startAt
      );
      const completed = history.filter((entry) => entry.status === "completed").length;
      const noShows = history.filter((entry) => entry.status === "no_show").length;
      const rejected = history.filter((entry) => entry.status === "rejected").length;
      let riskScore = 0.12;
      const reasons = [];
      if (noShows >= 1) {
        riskScore += 0.25;
        reasons.push("prior_no_show");
      }
      if (noShows >= 2) {
        riskScore += 0.2;
        reasons.push("repeated_no_show");
      }
      if (completed === 0 && history.length >= 2) {
        riskScore += 0.15;
        reasons.push("low_completion_history");
      }
      if (rejected >= 2) {
        riskScore += 0.1;
        reasons.push("multiple_rejections");
      }
      if (/(resched|maybe|not sure|late)/i.test(String(booking.reason || ""))) {
        riskScore += 0.08;
        reasons.push("uncertain_reason_text");
      }
      riskScore = Math.max(0, Math.min(0.95, Number(riskScore.toFixed(2))));

      // eslint-disable-next-line no-await-in-loop
      const patient = await User.findByPk(booking.patientId);
      predictions.push({
        bookingId: booking.id,
        availabilityId: booking.availabilityId || null,
        patientId: booking.patientId,
        patientName: patient?.fullName || booking.patientId,
        startAt: booking.startAt,
        reason: booking.reason || null,
        triageTags: Array.isArray(booking.triageTags) ? booking.triageTags : [],
        noShowRiskScore: riskScore,
        riskLabel: riskScore >= 0.65 ? "high" : riskScore >= 0.4 ? "medium" : "low",
        riskReasons: reasons,
      });
    }

    predictions.sort((a, b) => b.noShowRiskScore - a.noShowRiskScore);
    const highRiskByAvailability = new Map();
    for (const prediction of predictions) {
      if (!prediction.availabilityId) continue;
      if (prediction.noShowRiskScore < 0.65) continue;
      highRiskByAvailability.set(prediction.availabilityId, prediction);
    }

    const slots = await AppointmentAvailability.findAll({ where: { doctorId: req.user.id } });
    const overbookSuggestions = slots
      .filter((slot) => slot.isActive !== false && toValidDate(slot.startAt) > now)
      .flatMap((slot) => {
        const topRisk = highRiskByAvailability.get(slot.id);
        if (!topRisk) return [];
        const sameDateWaitlist = waitlist.filter(
          (entry) => !entry.preferredDate || dateKey(entry.preferredDate) === dateKey(slot.startAt)
        ).length;
        if (!sameDateWaitlist) return [];
        return [
          {
            availabilityId: slot.id,
            startAt: slot.startAt,
            location: slot.location || null,
            overbookBy: 1,
            reason: `High no-show risk (${Math.round(
              topRisk.noShowRiskScore * 100
            )}%) and waitlist demand (${sameDateWaitlist}).`,
            basedOnBookingId: topRisk.bookingId,
          },
        ];
      });

    return res.json({
      predictions,
      overbookSuggestions,
      waitlistCount: waitlist.length,
    });
  }
);

router.post(
  "/appointments/bookings/:id/visit-charge",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const consultationFee = toMoney(req.body?.consultationFee ?? booking.consultationFee ?? booking.feeAmount ?? 0);
    const additionalCharges = toMoney(req.body?.additionalCharges ?? booking.additionalCharges ?? 0);
    const nhfDeductionAmount = toMoney(req.body?.nhfDeductionAmount ?? booking.nhfDeductionAmount ?? 0);
    const feeCurrency = normalizeFeeCurrency(req.body?.feeCurrency || booking.feeCurrency || "JMD");
    const markReadyForCollection = req.body?.markReadyForCollection !== false;
    const chargeNotes = String(req.body?.chargeNotes || "").trim() || null;

    if (consultationFee < 0) {
      return res.status(400).json({ error: "consultationFee must be 0 or greater" });
    }
    if (additionalCharges < 0) {
      return res.status(400).json({ error: "additionalCharges must be 0 or greater" });
    }
    const feeAmount = toMoney(consultationFee + additionalCharges);
    if (nhfDeductionAmount < 0) {
      return res.status(400).json({ error: "nhfDeductionAmount must be 0 or greater" });
    }
    if (nhfDeductionAmount > feeAmount) {
      return res.status(400).json({ error: "nhfDeductionAmount cannot exceed total visit fee" });
    }

    const paidAmount = toMoney(booking.paymentCollectedAmount || 0);
    const balance = Math.max(0, feeAmount - nhfDeductionAmount - paidAmount);
    let nextPaymentStatus = "not_required";
    if (feeAmount > 0) {
      if (String(booking.paymentStatus || "").toLowerCase() === "waived") {
        nextPaymentStatus = "waived";
      } else if (balance <= 0) {
        nextPaymentStatus = "paid";
      } else if (paidAmount > 0) {
        nextPaymentStatus = "partial";
      } else {
        nextPaymentStatus = "unpaid";
      }
    }

    booking.consultationFee = consultationFee;
    booking.additionalCharges = additionalCharges;
    booking.feeRequired = feeAmount > 0;
    booking.feeAmount = feeAmount;
    booking.feeCurrency = feeCurrency;
    booking.nhfDeductionAmount = nhfDeductionAmount;
    booking.paymentStatus = nextPaymentStatus;
    booking.chargeNotes = chargeNotes;
    booking.visitChargeUpdatedAt = new Date().toISOString();
    booking.visitChargeUpdatedBy = req.user.id;
    booking.billingReadyForCollection = Boolean(markReadyForCollection);
    if (markReadyForCollection) {
      booking.billingReadyAt = new Date().toISOString();
    }
    await booking.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.appointment.visit_charge.save",
      entityType: "appointment",
      entityId: booking.id,
      metadata: {
        patientId: booking.patientId,
        consultationFee,
        additionalCharges,
        feeAmount,
        feeCurrency,
        nhfDeductionAmount,
        paymentStatus: nextPaymentStatus,
        markReadyForCollection: Boolean(markReadyForCollection),
      },
    });

    return res.json({ booking });
  }
);

router.post(
  "/appointments/bookings/:id/send-to-reception",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const now = new Date().toISOString();
    const handoffNote = String(req.body?.handoffNote || "").trim() || null;
    booking.billingReadyForCollection = true;
    booking.billingReadyAt = now;
    booking.receptionHandoffAt = now;
    booking.receptionHandoffBy = req.user.id;
    booking.receptionHandoffNote = handoffNote;
    await booking.save();

    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.appointment.send_to_reception",
      entityType: "appointment",
      entityId: booking.id,
      metadata: {
        patientId: booking.patientId,
        status: booking.status,
        feeAmount: toMoney(booking.feeAmount || 0),
        feeCurrency: normalizeFeeCurrency(booking.feeCurrency),
      },
    });

    return res.json({ booking });
  }
);

router.post(
  "/appointments/bookings/:id/decision",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }
    const decision = req.body?.decision;
    if (!["approved", "rejected", "completed", "no_show"].includes(decision)) {
      return res
        .status(400)
        .json({ error: "decision must be approved, rejected, completed, or no_show" });
    }
    if (decision === "approved" && booking.status !== "pending") {
      return res
        .status(409)
        .json({ error: "Only pending bookings can be approved" });
    }
    if (decision === "rejected" && booking.status !== "pending") {
      return res
        .status(409)
        .json({ error: "Only pending bookings can be rejected" });
    }
    if (decision === "completed" && booking.status !== "approved") {
      return res
        .status(409)
        .json({ error: "Only approved bookings can be marked completed" });
    }
    if (decision === "no_show" && booking.status !== "approved") {
      return res
        .status(409)
        .json({ error: "Only approved bookings can be marked no_show" });
    }
    booking.status = decision;
    if (decision === "completed" && booking.billingReadyForCollection !== true) {
      booking.billingReadyForCollection = true;
      booking.billingReadyAt = new Date().toISOString();
    }
    if (req.body?.doctorNotes) {
      booking.doctorNotes = req.body.doctorNotes;
    }
    await booking.save();
    return res.json({ booking });
  }
);

router.post(
  "/appointments/bookings/:id/reminder-config",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const body = req.body || {};
    const resolvedChannel = body.channel || booking.reminderChannel || "email";
    if (!REMINDER_CHANNELS.has(resolvedChannel)) {
      return res.status(400).json({ error: "channel must be email, whatsapp, or sms" });
    }
    booking.reminderChannel = resolvedChannel;

    if (typeof body.default24h === "boolean") {
      booking.reminderDefault24h = body.default24h;
      if (!body.default24h) {
        booking.reminderDefaultSentAt = null;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "customAlertAt")) {
      if (!body.customAlertAt) {
        booking.reminderCustomAlertAt = null;
        booking.reminderCustomSentAt = null;
      } else {
        const customDate = toValidDate(body.customAlertAt);
        const startAt = toValidDate(booking.startAt);
        if (!customDate) {
          return res.status(400).json({ error: "customAlertAt is invalid" });
        }
        if (startAt && customDate >= startAt) {
          return res.status(400).json({ error: "customAlertAt must be before appointment startAt" });
        }
        booking.reminderCustomAlertAt = customDate.toISOString();
        booking.reminderCustomSentAt = null;
      }
    }

    await booking.save();
    return res.json({ booking, reminder: getReminderSummary(booking) });
  }
);

router.post(
  "/appointments/bookings/:id/reminder-send",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const booking = await Appointment.findByPk(req.params.id);
    if (!booking || booking.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Booking not found" });
    }

    const kind = req.body?.kind || "manual";
    if (!["manual", "default24h", "custom"].includes(kind)) {
      return res.status(400).json({ error: "kind must be manual, default24h, or custom" });
    }
    if (kind === "custom" && !booking.reminderCustomAlertAt) {
      return res.status(400).json({ error: "custom reminder is not configured for this booking" });
    }

    const sent = await sendBookingReminder({
      booking,
      channel: req.body?.channel,
      kind,
      actorDoctorId: req.user.id,
      actorLabel: "doctor",
    });
    if (!sent.ok) {
      return res.status(sent.status).json({ error: sent.error });
    }

    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.appointment.reminder.send",
      entityType: "appointment",
      entityId: booking.id,
    });
    return res.json({
      booking,
      reminder: sent.reminder,
      reminderSummary: getReminderSummary(booking),
    });
  }
);

router.post(
  "/prescription",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.meds) || !body.meds.length) {
        return res.status(400).json({ error: "meds are required" });
      }
      const normalizedMeds = [];
      for (const med of body.meds) {
        const approved = findApprovedDrug({
          code: med.ndcCode,
          name: med.name,
          strength: med.strength,
        });
        if (!approved) {
          return res.status(400).json({
            error: `Medication ${med.name || med.ndcCode || "unknown"} is not MOH-approved`,
          });
        }
        normalizedMeds.push({
          ...med,
          ndcCode: approved.code || med.ndcCode || null,
          name: approved.name || med.name || null,
          medicationType: med.medicationType || approved.medicationType || null,
          usedFor: med.usedFor || approved.usedFor || null,
        });
      }
      const patientId = body.patientId || null;
      if (!patientId) {
        return res.status(400).json({ error: "patientId is required. Select a patient first." });
      }
      const patient = await User.findByPk(patientId);
      if (!patient || patient.role !== "patient") {
        return res.status(404).json({ error: "Patient not found" });
      }
      const doctor = await User.findByPk(req.user.id);
      const doctorName = doctor?.fullName || req.user.fullName || "Doctor";
      const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
      if (!allowed) {
        await ensureDoctorConnection(req.user.id, patientId, "doctor_prescribe_access");
      }
      const patientProfile = await PatientProfile.findOne({ where: { userId: patientId } });
      const profileWeightKg = toNumberOrNull(patientProfile?.weightKg);
      const profileWeightLbs = toNumberOrNull(patientProfile?.weightLbs);
      const derivedProfileWeightKg =
        profileWeightKg || (profileWeightLbs ? weightLbsToKg(profileWeightLbs) : null);
      const requestWeightKg = toNumberOrNull(body.patientWeightKg);
      const effectivePatientWeightKg = requestWeightKg || derivedProfileWeightKg || null;
      const allergyList = decodeAllergyListFromProfile(patientProfile);
      const existingPrescriptions = await Prescription.findAll({ where: { patientId } });
      const activeMeds = existingPrescriptions
        .filter((entry) => {
          if (!entry.expiryDate) return true;
          const expiry = toValidDate(entry.expiryDate);
          return !expiry || expiry >= new Date();
        })
        .flatMap((entry) => entry.meds || []);
      const warnings = findMedicationSafetyWarnings({
        prescribedMeds: normalizedMeds,
        activeMeds,
        allergies: allergyList,
      });
      warnings.push(
        ...findIntraPrescriptionDuplicateWarnings(normalizedMeds),
        ...findDoseSafetyWarnings({
          prescribedMeds: normalizedMeds,
          patientDob: body.patientDob || patientProfile?.dob || null,
          patientWeightKg: effectivePatientWeightKg,
        })
      );

      const approvedMeds = normalizedMeds.map((med) =>
        findApprovedDrug({ code: med.ndcCode, name: med.name, strength: med.strength })
      );
      const hasControlledDrug = approvedMeds.some((med) => med?.controlledSubstance);
      const requiresControlledJustification =
        hasControlledDrug || Boolean(body.controlledSubstance);
      const controlledSubstanceJustification = String(
        body.controlledSubstanceJustification || ""
      ).trim();
      if (
        requiresControlledJustification &&
        controlledSubstanceJustification.length < MIN_CONTROLLED_JUSTIFICATION_LENGTH
      ) {
        warnings.push({
          type: "controlled_substance",
          severity: "high",
          hardStop: true,
          message: `Controlled medication requires justification of at least ${MIN_CONTROLLED_JUSTIFICATION_LENGTH} characters.`,
        });
      }

      const hasHardStop = warnings.some((entry) => entry.hardStop === true);
      if (hasHardStop) {
        return res.status(422).json({
          error: "Hard-stop safety rule triggered. Prescription cannot be created for this combination.",
          warnings,
        });
      }
      const hasHighRisk = warnings.some((entry) => entry.severity === "high");
      if (hasHighRisk && !body.overrideSafety) {
        return res.status(409).json({
          error: "High-risk safety warning detected. Review and override to continue.",
          warnings,
        });
      }
      const linkCode = randomCode();
      const prescription = await Prescription.create({
        doctorId: req.user.id,
        doctorName,
        patientId,
        patientFullName: patient.fullName || null,
        patientDob: body.patientDob || null,
        patientContact: body.patientContact || patient.email || null,
        meds: normalizedMeds,
        allowedRefills: Number(body.allowedRefills || 0),
        expiryDate: body.expiryDate || null,
        allowSubstitution: Boolean(body.allowSubstitution),
        controlledSubstance: requiresControlledJustification,
        controlledSubstanceJustification:
          requiresControlledJustification ? controlledSubstanceJustification : null,
        diagnosis: String(body.diagnosis || "").trim() || null,
        patientWeightKg: effectivePatientWeightKg,
        linkCode,
        linked: false,
      });
      const qrPayload = buildPrescriptionQrPayload(prescription);
      const qrContent = toCompactPrescriptionLink(qrPayload) || JSON.stringify(qrPayload);
      const qrDataUrl = await generatePrescriptionQrDataUrl(qrPayload);
      prescription.qrPayload = qrPayload;
      prescription.qrContent = qrContent;
      prescription.qrDataUrl = qrDataUrl;
      await prescription.save();
      await writeAudit({
        actorUserId: req.user.id,
        action: "doctor.prescription.create",
        entityType: "prescription",
        entityId: prescription.id,
      });
      const shareText = [
        `Refillit Prescription`,
        `Prescription ID: ${prescription.id}`,
        `Doctor: ${doctorName} (${req.user.id})`,
        `Patient: ${patient.fullName}`,
        `Link Code: ${linkCode}`,
        `Expiry: ${prescription.expiryDate || "N/A"}`,
      ].join("\n");
      return res.status(201).json({
        prescription,
        doctor: { id: req.user.id, name: doctorName },
        safety: {
          overrideApplied: Boolean(body.overrideSafety),
          hardStopBlocked: false,
          warnings,
        },
        linkCode,
        qrPayload,
        qrContent,
        qrDataUrl,
        patientShare: {
          contact: body.patientContact || patient.email || null,
          text: shareText,
        },
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  "/verify-prescription",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const body = req.body || {};
    let prescId = body.prescId;
    let decodedQr = null;
    if (!prescId && body.qrContent) {
      decodedQr = parsePrescriptionQr(body.qrContent);
      if (!decodedQr) {
        return res.status(400).json({ error: "Invalid or tampered QR content" });
      }
      prescId = decodedQr.prescId;
    }
    const prescription = await Prescription.findByPk(prescId);
    if (!prescription) {
      return res.status(404).json({ error: "Prescription not found" });
    }
    if (decodedQr?.linkCode && prescription.linkCode !== decodedQr.linkCode) {
      return res.status(400).json({ error: "QR link code mismatch" });
    }
    if (prescription.doctorId !== req.user.id) {
      const allowed = await ensureDoctorCanAccessPatient(req.user.id, prescription.patientId);
      if (!allowed) {
        return res.status(403).json({ error: "Not allowed to access this prescription" });
      }
    }
    return res.json({
      verified: true,
      prescription: {
        ...prescription,
        doctorName: prescription.doctorName || decodedQr?.doctorName || null,
      },
      decodedQr,
    });
  }
);

router.post("/prescriptions/:id/sign", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const prescription = await Prescription.findByPk(req.params.id);
  if (!prescription || prescription.doctorId !== req.user.id) {
    return res.status(404).json({ error: "Prescription not found" });
  }
  if (prescription.signedAt) {
    return res.status(409).json({ error: "Prescription is already signed and locked." });
  }
  const signature = String(req.body?.signature || "").trim();
  if (!signature) {
    return res.status(400).json({ error: "signature is required" });
  }
  prescription.signedAt = new Date().toISOString();
  prescription.signedBy = req.user.id;
  prescription.signature = signature;
  prescription.locked = true;
  await prescription.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.prescription.sign",
    entityType: "prescription",
    entityId: prescription.id,
    metadata: { patientId: prescription.patientId },
  });
  return res.json({ prescription });
});

router.post("/referrals", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  const referralType = String(body.referralType || "").trim().toLowerCase();
  const priority = String(body.priority || "routine").trim().toLowerCase();
  const targetName = String(body.targetName || "").trim();
  const reason = String(body.reason || "").trim();
  const allowedTypes = new Set(["specialist", "lab", "imaging"]);
  const allowedPriorities = new Set(["routine", "urgent", "stat"]);

  if (!body.patientId || !referralType || !targetName) {
    return res.status(400).json({
      error: "patientId, referralType (specialist/lab/imaging), and targetName are required",
    });
  }
  if (!allowedTypes.has(referralType)) {
    return res.status(400).json({ error: "referralType must be specialist, lab, or imaging" });
  }
  if (!allowedPriorities.has(priority)) {
    return res.status(400).json({ error: "priority must be routine, urgent, or stat" });
  }
  if (reason.length < 10) {
    return res.status(400).json({ error: "reason must be at least 10 characters" });
  }
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, body.patientId);
  if (!allowed) {
    return res.status(403).json({ error: "Doctor cannot create referral for this patient" });
  }
  const attachmentUrls = Array.isArray(body.attachmentUrls)
    ? body.attachmentUrls
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, 10)
    : [];
  const requestedByDate = String(body.requestedByDate || "").trim() || null;
  const clinicalQuestion = String(body.clinicalQuestion || "").trim() || null;
  const targetSpecialty = String(body.targetSpecialty || "").trim() || null;
  const targetContact = String(body.targetContact || "").trim() || null;
  const referral = await Referral.create({
    doctorId: req.user.id,
    patientId: body.patientId,
    referralType,
    targetName,
    reason,
    priority,
    status: "pending",
    requestedByDate,
    clinicalQuestion,
    targetSpecialty,
    targetContact,
    referralReference: `RF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    attachmentUrls,
    statusTimeline: [
      {
        status: "pending",
        at: new Date().toISOString(),
        by: req.user.id,
        note: "Referral created",
      },
    ],
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.referral.create",
    entityType: "referral",
    entityId: referral.id,
    metadata: { patientId: referral.patientId },
  });
  return res.status(201).json({ referral });
});

router.get("/referrals", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const all = await Referral.findAll({ where: { doctorId: req.user.id } });
  const patientId = req.query.patientId || "";
  const status = String(req.query.status || "").trim().toLowerCase();
  const filtered = all.filter((entry) => {
    if (patientId && entry.patientId !== patientId) return false;
    if (status && String(entry.status || "").toLowerCase() !== status) return false;
    return true;
  });
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ referrals: filtered });
});

router.post("/referrals/:id/status", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const referral = await Referral.findByPk(req.params.id);
  if (!referral || String(referral.doctorId || "") !== String(req.user.id || "")) {
    return res.status(404).json({ error: "Referral not found" });
  }
  const nextStatus = String(req.body?.status || "").trim().toLowerCase();
  const note = String(req.body?.note || "").trim() || null;
  const allowedStatuses = new Set(["pending", "sent", "accepted", "scheduled", "completed", "cancelled"]);
  if (!allowedStatuses.has(nextStatus)) {
    return res.status(400).json({ error: "status must be pending, sent, accepted, scheduled, completed, or cancelled" });
  }
  referral.status = nextStatus;
  const timeline = Array.isArray(referral.statusTimeline) ? referral.statusTimeline : [];
  timeline.push({
    status: nextStatus,
    at: new Date().toISOString(),
    by: req.user.id,
    note,
  });
  referral.statusTimeline = timeline.slice(-50);
  if (nextStatus === "completed") referral.completedAt = new Date().toISOString();
  if (nextStatus === "cancelled") referral.cancelledAt = new Date().toISOString();
  await referral.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.referral.status_update",
    entityType: "referral",
    entityId: referral.id,
    metadata: { patientId: referral.patientId, status: nextStatus },
  });
  return res.json({ referral });
});

router.get("/pharmacy-interventions", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const all = await PharmacyIntervention.findAll({ where: { doctorId: req.user.id } });
  const patientId = req.query.patientId || "";
  const filtered = patientId ? all.filter((entry) => entry.patientId === patientId) : all;
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ interventions: filtered });
});

router.post(
  "/pharmacy-interventions/:id/decision",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const intervention = await PharmacyIntervention.findByPk(req.params.id);
    if (!intervention || intervention.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Intervention not found" });
    }
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["approved", "rejected", "needs_info"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved, rejected, or needs_info" });
    }
    intervention.status = decision;
    intervention.doctorDecisionNotes = String(req.body?.notes || "").trim() || null;
    intervention.decidedAt = new Date().toISOString();
    await intervention.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.pharmacy_intervention.decision",
      entityType: "pharmacy_intervention",
      entityId: intervention.id,
      metadata: { decision, patientId: intervention.patientId },
    });
    return res.json({ intervention });
  }
);

router.post("/shared-care-notes", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  if (!body.patientId || !body.text) {
    return res.status(400).json({ error: "patientId and text are required" });
  }
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, body.patientId);
  if (!allowed) return res.status(403).json({ error: "No access to patient" });
  const visibility = Array.isArray(body.visibilityRoles) ? body.visibilityRoles : ["doctor"];
  const note = await SharedCareNote.create({
    doctorId: req.user.id,
    patientId: body.patientId,
    text: String(body.text).trim(),
    visibilityRoles: visibility.slice(0, 6),
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 8) : [],
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.shared_care_note.create",
    entityType: "shared_care_note",
    entityId: note.id,
    metadata: { patientId: note.patientId },
  });
  return res.status(201).json({ note });
});

router.get("/shared-care-notes", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = req.query.patientId || "";
  const all = await SharedCareNote.findAll({});
  const filtered = all.filter(
    (entry) =>
      entry.doctorId === req.user.id &&
      (!patientId || entry.patientId === patientId) &&
      (entry.visibilityRoles || []).includes("doctor")
  );
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ notes: filtered });
});

router.post("/soap-notes/extract", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const extracted = buildSimpleStructuredSoapFromText(text);
  return res.json({ extracted });
});

router.post("/soap-notes/objective-assist", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const subjective = String(req.body?.subjective || "").trim();
  const diagnosis = String(req.body?.diagnosis || "").trim();
  if (!subjective) return res.status(400).json({ error: "subjective is required" });
  const objectiveAssist = buildObjectiveAssistFromSubjective(subjective, diagnosis);
  return res.json({ objectiveAssist });
});

router.post("/soap-notes/assessment-assist", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const subjective = String(req.body?.subjective || "").trim();
  const objective = String(req.body?.objective || "").trim();
  const diagnosis = String(req.body?.diagnosis || "").trim();
  if (!subjective && !objective) {
    return res.status(400).json({ error: "subjective or objective is required" });
  }
  const assessmentAssist = buildAssessmentAssist({ subjective, objective, diagnosis });
  return res.json({ assessmentAssist });
});

router.post("/soap-notes/plan-assist", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const subjective = String(req.body?.subjective || "").trim();
  const objective = String(req.body?.objective || "").trim();
  const assessment = String(req.body?.assessment || "").trim();
  const diagnosis = String(req.body?.diagnosis || "").trim();
  if (!assessment && !objective && !subjective) {
    return res.status(400).json({ error: "assessment, objective, or subjective is required" });
  }
  const planAssist = buildPlanAssist({ subjective, objective, assessment, diagnosis });
  return res.json({ planAssist });
});

router.post("/soap-notes", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  if (!body.patientId) return res.status(400).json({ error: "patientId is required" });
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, body.patientId);
  if (!allowed) return res.status(403).json({ error: "No access to patient" });
  const note = await SoapNote.create({
    doctorId: req.user.id,
    patientId: body.patientId,
    subjective: body.subjective || "",
    objective: body.objective || "",
    assessment: body.assessment || "",
    plan: body.plan || "",
    diagnosisCodes: Array.isArray(body.diagnosisCodes) ? body.diagnosisCodes.slice(0, 10) : [],
    procedureCodes: Array.isArray(body.procedureCodes) ? body.procedureCodes.slice(0, 10) : [],
    signedAt: null,
    locked: false,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.soap_note.create",
    entityType: "soap_note",
    entityId: note.id,
    metadata: { patientId: note.patientId },
  });
  return res.status(201).json({ note });
});

router.get("/soap-notes", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = req.query.patientId || "";
  const all = await SoapNote.findAll({ where: { doctorId: req.user.id } });
  const filtered = patientId ? all.filter((entry) => entry.patientId === patientId) : all;
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ notes: filtered });
});

router.post("/soap-notes/:id/sign", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const note = await SoapNote.findByPk(req.params.id);
  if (!note || note.doctorId !== req.user.id) return res.status(404).json({ error: "Note not found" });
  if (note.locked) return res.status(409).json({ error: "SOAP note already signed and locked" });
  const signature = String(req.body?.signature || "").trim();
  if (!signature) return res.status(400).json({ error: "signature is required" });
  note.signature = signature;
  note.signedBy = req.user.id;
  note.signedAt = new Date().toISOString();
  note.locked = true;
  await note.save();
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.soap_note.sign",
    entityType: "soap_note",
    entityId: note.id,
    metadata: { patientId: note.patientId },
  });
  return res.json({ note });
});

router.get("/coding/icd10", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const query = String(req.query.query || "").trim().toLowerCase();
  const items = ICD10_CODES.filter(
    (entry) => !query || entry.code.toLowerCase().includes(query) || entry.label.toLowerCase().includes(query)
  );
  return res.json({ items });
});

router.get("/coding/cpt", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const query = String(req.query.query || "").trim().toLowerCase();
  const items = CPT_CODES.filter(
    (entry) => !query || entry.code.toLowerCase().includes(query) || entry.label.toLowerCase().includes(query)
  );
  return res.json({ items });
});

router.get("/instruction-templates", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const language = String(req.query.language || "").trim().toLowerCase();
  const templates = INSTRUCTION_TEMPLATES.filter(
    (entry) => !language || entry.language.toLowerCase() === language
  );
  return res.json({ templates });
});

router.post("/instructions/broadcast", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const body = req.body || {};
  const cohort = body.cohort || "all";
  const customPatientIds = Array.isArray(body.patientIds) ? body.patientIds : [];
  const language = String(body.language || "en").toLowerCase();
  const text = String(body.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });

  const allowedIds = await listDoctorApprovedPatientIds(req.user.id);
  const allPatients = await User.findAll({ where: { role: "patient" } });
  const patientProfiles = await PatientProfile.findAll({});
  const appointments = await Appointment.findAll({ where: { doctorId: req.user.id } });
  const orders = await Order.findAll({});
  const selectedPatients = [];
  for (const patient of allPatients) {
    if (!allowedIds.has(patient.id)) continue;
    if (customPatientIds.length && !customPatientIds.includes(patient.id)) continue;
    const patientAppointments = appointments.filter((entry) => entry.patientId === patient.id);
    const noShows = patientAppointments.filter((entry) => entry.status === "no_show").length;
    const patientOrders = orders.filter((entry) => entry.patientId === patient.id);
    const failedOrders = patientOrders.filter((entry) => entry.orderStatus === "failed").length;
    const riskFlags = [];
    if (noShows >= 2) riskFlags.push({ type: "repeated_no_show", severity: "high" });
    if (failedOrders >= 2) riskFlags.push({ type: "non_adherence", severity: "high" });
    if (!isPatientInCohort({ patient, riskFlags, cohort })) continue;
    // eslint-disable-next-line no-await-in-loop
    const profile = patientProfiles.find((entry) => entry.userId === patient.id);
    selectedPatients.push({
      id: patient.id,
      contact: profile?.phone || patient.email || null,
      riskFlags,
    });
  }

  const records = [];
  for (const patient of selectedPatients) {
    // eslint-disable-next-line no-await-in-loop
    const broadcast = await CareInstructionBroadcast.create({
      doctorId: req.user.id,
      patientId: patient.id,
      language,
      text,
      cohort,
      deliveredAt: new Date().toISOString(),
      readAt: null,
      escalatedAt: null,
      contact: patient.contact,
      escalationLevel: 0,
    });
    records.push(broadcast);
  }
  return res.status(201).json({ sent: records.length, records });
});

router.get("/instructions/broadcasts", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const all = await CareInstructionBroadcast.findAll({ where: { doctorId: req.user.id } });
  const now = new Date();
  for (const item of all) {
    if (item.readAt || item.escalationLevel >= 2) continue;
    const delivered = toValidDate(item.deliveredAt);
    if (!delivered) continue;
    const ageHours = (now.getTime() - delivered.getTime()) / (60 * 60 * 1000);
    if (ageHours >= 24) {
      item.escalationLevel = Number(item.escalationLevel || 0) + 1;
      item.escalatedAt = now.toISOString();
      // eslint-disable-next-line no-await-in-loop
      await item.save();
    }
  }
  const refreshed = await CareInstructionBroadcast.findAll({ where: { doctorId: req.user.id } });
  refreshed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ broadcasts: refreshed });
});

router.post("/patients/:id/consents", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = req.params.id;
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
  if (!allowed) return res.status(403).json({ error: "No access to patient" });
  const body = req.body || {};
  const consentType = String(body.consentType || "").trim();
  if (!consentType) return res.status(400).json({ error: "consentType is required" });
  const consent = await ConsentRecord.create({
    doctorId: req.user.id,
    patientId,
    consentType,
    grantedAt: body.grantedAt || new Date().toISOString(),
    expiresAt: body.expiresAt || null,
    status: "active",
    notes: body.notes || null,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "doctor.consent.create",
    entityType: "consent_record",
    entityId: consent.id,
    metadata: { patientId: consent.patientId },
  });
  return res.status(201).json({ consent });
});

router.get("/patients/:id/consents", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = req.params.id;
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
  if (!allowed) return res.status(403).json({ error: "No access to patient" });
  const consents = await ConsentRecord.findAll({ where: { doctorId: req.user.id, patientId } });
  const now = new Date();
  for (const consent of consents) {
    if (consent.status !== "active" || !consent.expiresAt) continue;
    if (new Date(consent.expiresAt) < now) {
      consent.status = "expired";
      // eslint-disable-next-line no-await-in-loop
      await consent.save();
    }
  }
  const refreshed = await ConsentRecord.findAll({ where: { doctorId: req.user.id, patientId } });
  refreshed.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ consents: refreshed });
});

router.get("/patients/:id/audit", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const patientId = req.params.id;
  const allowed = await ensureDoctorCanAccessPatient(req.user.id, patientId);
  if (!allowed) return res.status(403).json({ error: "No access to patient" });
  const records = await AuditLog.findAll({});
  const filtered = records.filter((entry) => {
    if (entry.entityId === patientId) return true;
    if (entry.metadata?.patientId === patientId) return true;
    return false;
  });
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ audit: filtered.slice(0, 300) });
});

router.get("/daily-agenda", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const date = String(req.query.date || dateKey(new Date().toISOString()));
  const bookings = await Appointment.findAll({ where: { doctorId: req.user.id } });
  const today = bookings
    .filter((entry) => dateKey(entry.startAt) === date)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const enriched = [];
  for (const booking of today) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(booking.patientId);
    enriched.push({
      ...booking,
      patientName: patient?.fullName || booking.patientId,
    });
  }
  return res.json({ date, agenda: enriched });
});

router.get("/kpi", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const bookings = await Appointment.findAll({ where: { doctorId: req.user.id } });
  const orders = await Order.findAll({});
  const doctorOrderIds = new Set(
    (await Prescription.findAll({ where: { doctorId: req.user.id } })).map((p) => p.id)
  );
  const relatedOrders = orders.filter((order) => doctorOrderIds.has(order.prescId));
  const completedBookings = bookings.filter((entry) => entry.status === "completed");
  const noShows = bookings.filter((entry) => entry.status === "no_show");
  const noShowRate = bookings.length ? Number((noShows.length / bookings.length).toFixed(2)) : 0;
  const refillSuccessDenominator = relatedOrders.length || 1;
  const refillSuccess = Number(
    (
      relatedOrders.filter((entry) => ["ready", "assigned", "completed"].includes(entry.orderStatus))
        .length / refillSuccessDenominator
    ).toFixed(2)
  );

  const turnaroundSamples = relatedOrders
    .filter((entry) => entry.createdAt && entry.updatedAt)
    .map((entry) => new Date(entry.updatedAt).getTime() - new Date(entry.createdAt).getTime())
    .filter((diff) => Number.isFinite(diff) && diff >= 0);
  const avgTurnaroundHours = turnaroundSamples.length
    ? Number(
        (
          turnaroundSamples.reduce((sum, value) => sum + value, 0) /
          turnaroundSamples.length /
          (60 * 60 * 1000)
        ).toFixed(2)
      )
    : 0;

  const today = dateKey(new Date().toISOString());
  let paymentsCollectedToday = 0;
  let paymentTransactionsToday = 0;
  for (const booking of bookings) {
    const history = Array.isArray(booking.paymentHistory) ? booking.paymentHistory : [];
    for (const entry of history) {
      if (dateKey(entry?.at) !== today) continue;
      const amount = Number(entry?.amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      paymentsCollectedToday += amount;
      paymentTransactionsToday += 1;
    }
  }

  return res.json({
    kpi: {
      avgTurnaroundHours,
      noShowRate,
      refillSuccessRate: refillSuccess,
      completedVisits: completedBookings.length,
      totalVisits: bookings.length,
      paymentsCollectedToday: Number(paymentsCollectedToday.toFixed(2)),
      paymentTransactionsToday,
    },
  });
});

router.get("/refill-requests", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const requests = await RefillRequest.findAll({ where: { doctorId: req.user.id } });
  requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ requests });
});

router.post(
  "/refill-requests/:id/decision",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const request = await RefillRequest.findByPk(req.params.id);
    if (!request || request.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Refill request not found" });
    }
    const decision = String(req.body?.decision || "").toLowerCase();
    if (!["approved", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approved or rejected" });
    }
    request.status = decision;
    request.decidedAt = new Date().toISOString();
    request.decisionNotes = String(req.body?.notes || "").trim() || null;
    await request.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "doctor.refill_request.decision",
      entityType: "refill_request",
      entityId: request.id,
      metadata: { patientId: request.patientId, decision },
    });
    return res.json({ request });
  }
);

router.get(
  "/connection-requests",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const status = req.query.status;
    const where = { doctorId: req.user.id };
    if (status) where.status = status;
    const connections = await DoctorConnection.findAll({ where });
    const enriched = [];
    for (const entry of connections) {
      // eslint-disable-next-line no-await-in-loop
      const patient = await User.findByPk(entry.patientId);
      enriched.push({
        ...entry,
        patientName: patient?.fullName || null,
        patientEmail: patient?.email || null,
      });
    }
    enriched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ connections: enriched });
  }
);

router.post(
  "/connection-requests/:id/approve",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const connection = await DoctorConnection.findByPk(req.params.id);
    if (!connection || connection.doctorId !== req.user.id) {
      return res.status(404).json({ error: "Connection request not found" });
    }
    connection.status = "approved";
    await connection.save();
    const existing = await ChatThread.findOne({
      where: { doctorId: connection.doctorId, patientId: connection.patientId },
    });
    if (!existing) {
      await ChatThread.create({
        doctorId: connection.doctorId,
        patientId: connection.patientId,
      });
    }
    return res.json({ connection });
  }
);

router.get("/installment-proposals", requireAuth, requireRoles(["doctor"]), async (req, res) => {
  const status = String(req.query.status || "").trim().toLowerCase();
  const where = { doctorId: req.user.id };
  if (status) where.status = status;
  const proposals = await InstallmentProposal.findAll({ where });
  proposals.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const patientIds = Array.from(new Set(proposals.map((entry) => String(entry.patientId || "")).filter(Boolean)));
  const patientNameMap = new Map();
  for (const patientId of patientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patient = await User.findByPk(patientId);
    if (patient && patient.role === "patient") patientNameMap.set(patientId, patient.fullName || null);
  }

  return res.json({
    proposals: proposals.map((entry) => ({
      ...entry,
      patientName: patientNameMap.get(String(entry.patientId || "")) || null,
    })),
  });
});

router.post(
  "/installment-proposals/:id/decision",
  requireAuth,
  requireRoles(["doctor"]),
  async (req, res) => {
    const proposal = await InstallmentProposal.findByPk(req.params.id);
    if (!proposal || String(proposal.doctorId || "") !== String(req.user.id)) {
      return res.status(404).json({ error: "Installment proposal not found" });
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
      action: "doctor.installment_proposal.decision",
      entityType: "installment_proposal",
      entityId: proposal.id,
      metadata: {
        patientId: proposal.patientId,
        appointmentId: proposal.appointmentId,
        decision,
      },
    });

    return res.json({ proposal });
  }
);

module.exports = router;

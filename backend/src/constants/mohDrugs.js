const MOH_DRUGS = [
  {
    code: "M001",
    name: "Amlodipine",
    strengths: ["5mg", "10mg"],
    medicationType: "Antihypertensive",
    usedFor: "High blood pressure and angina",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 5, max: 10 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M002",
    name: "Metformin",
    strengths: ["500mg", "850mg", "1000mg"],
    medicationType: "Antidiabetic",
    usedFor: "Type 2 diabetes",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 500, max: 1000 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M003",
    name: "Losartan",
    strengths: ["50mg", "100mg"],
    medicationType: "Antihypertensive",
    usedFor: "Hypertension and kidney protection",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 25, max: 100 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M004",
    name: "Atorvastatin",
    strengths: ["10mg", "20mg", "40mg"],
    medicationType: "Lipid-lowering",
    usedFor: "High cholesterol and cardiovascular risk reduction",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 10, max: 80 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M005",
    name: "Salbutamol",
    strengths: ["100mcg inhaler", "2mg tablet", "4mg tablet"],
    medicationType: "Bronchodilator",
    usedFor: "Asthma and bronchospasm",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 2, max: 4 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M006",
    name: "Amoxicillin",
    strengths: ["250mg", "500mg"],
    medicationType: "Antibiotic",
    usedFor: "Bacterial infections",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 250, max: 1000 },
      pediatricMgPerKgPerDose: { min: 10, max: 25 },
    },
    approved: true,
  },
  {
    code: "M007",
    name: "Omeprazole",
    strengths: ["20mg", "40mg"],
    medicationType: "Proton pump inhibitor",
    usedFor: "Acid reflux and peptic ulcer disease",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 20, max: 40 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M008",
    name: "Hydrochlorothiazide",
    strengths: ["12.5mg", "25mg"],
    medicationType: "Diuretic",
    usedFor: "Hypertension and fluid retention",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 12.5, max: 50 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M009",
    name: "Insulin NPH",
    strengths: ["100IU/mL"],
    medicationType: "Insulin",
    usedFor: "Diabetes mellitus",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: null,
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
  {
    code: "M010",
    name: "Paracetamol",
    strengths: ["500mg"],
    medicationType: "Analgesic/Antipyretic",
    usedFor: "Pain and fever",
    controlledSubstance: false,
    doseGuide: {
      adultMgPerDose: { min: 325, max: 1000 },
      pediatricMgPerKgPerDose: { min: 10, max: 15 },
    },
    approved: true,
  },
  {
    code: "M011",
    name: "Codeine",
    strengths: ["15mg", "30mg"],
    medicationType: "Analgesic Opioid",
    usedFor: "Moderate pain",
    controlledSubstance: true,
    doseGuide: {
      adultMgPerDose: { min: 15, max: 60 },
      pediatricMgPerKgPerDose: null,
    },
    approved: true,
  },
];

const searchMohDrugs = (query) => {
  const q = String(query || "").trim().toLowerCase();
  return MOH_DRUGS.filter((drug) => {
    if (!drug.approved) return false;
    if (!q) return true;
    return (
      drug.name.toLowerCase().includes(q) ||
      drug.code.toLowerCase().includes(q) ||
      drug.medicationType.toLowerCase().includes(q)
    );
  }).slice(0, 25);
};

const findApprovedDrug = ({ code, name, strength }) => {
  const target = MOH_DRUGS.find(
    (drug) =>
      drug.approved &&
      ((code && drug.code === code) || (!code && name && drug.name === name))
  );
  if (!target) return null;
  if (strength && !target.strengths.includes(strength)) return null;
  return target;
};

module.exports = {
  MOH_DRUGS,
  searchMohDrugs,
  findApprovedDrug,
};

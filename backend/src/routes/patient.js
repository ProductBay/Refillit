const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const {
  DoctorConnection,
  DoctorProfile,
  Order,
  Prescription,
  AppointmentAvailability,
  Appointment,
  AppointmentWaitlist,
  CareInstructionBroadcast,
  RefillRequest,
  PatientMedicationReminder,
  PatientVisitPrepItem,
  PatientCareTask,
  PatientProfile,
  PatientProxyAccess,
  PharmacyProfile,
  InstallmentProposal,
  Referral,
  PaymentIntent,
  WalletLedger,
  NhfCreditLedger,
  ChatThread,
  ChatMessage,
  User,
  OtcProduct,
  PharmacyOtcInventory,
  OtcOrderItem,
} = require("../models");
const { writeAudit } = require("../utils/audit");
const { parsePrescriptionQr } = require("../utils/prescriptionQr");
const { hashPassword } = require("../utils/password");
const { normalizeEmail } = require("../utils/crypto");
const { decryptValue, encryptValue } = require("../utils/fieldCrypto");
const { MOH_DRUGS } = require("../constants/mohDrugs");

const router = express.Router();
const CAREGIVER_ROLES = new Set(["caregiver", "patient_proxy"]);
const PATIENT_CARE_CONTEXT_ROLES = ["patient", "caregiver", "patient_proxy"];

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
const toMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};
const PAYMENT_METHODS = new Set(["card", "nhf_credit", "rx_card", "split"]);
const PAYMENT_FINAL_STATUSES = new Set(["authorized", "paid"]);
const normalizeFeeCurrency = (value) =>
  (String(value || "JMD").trim().toUpperCase().slice(0, 8) || "JMD");
const toNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const toDateKey = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};
const toIsoFromDateAndTime = (dateValue, timeValue) => {
  const dateKey = toDateKey(dateValue);
  if (!dateKey) return "";
  const timeRaw = String(timeValue || "").trim();
  if (/^\d{2}:\d{2}$/.test(timeRaw)) {
    const parsed = new Date(`${dateKey}T${timeRaw}:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const parsedDate = new Date(dateValue);
  if (!Number.isNaN(parsedDate.getTime())) return parsedDate.toISOString();
  return "";
};

const resolvePharmacyParish = (profile = {}) => {
  const metadata = profile?.metadata && typeof profile.metadata === "object" ? profile.metadata : {};
  return String(metadata.parish || metadata.serviceParish || profile.town || profile.city || "").trim() || null;
};
const randomCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const maskIdNumber = (value) => {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.length <= 4) return `***${text}`;
  return `${"*".repeat(Math.max(3, text.length - 4))}${text.slice(-4)}`;
};
const normalizeVerificationStatus = (value) => {
  const status = String(value || "").trim().toLowerCase();
  if (status === "verified") return "verified";
  if (status === "declined") return "declined";
  return "pending";
};

const normalizeDeliveryAddressInput = (payload = {}) => {
  const addressLine = String(
    payload.addressLine
    || payload.address
    || payload.street
    || ""
  ).trim();
  const city = String(payload.city || "").trim() || null;
  const parish = String(payload.parish || "").trim() || null;
  const postalCode = String(payload.postalCode || "").trim() || null;
  const lat = toNum(payload.lat ?? payload.latitude);
  const lng = toNum(payload.lng ?? payload.longitude);
  const hasText = Boolean(addressLine || city || parish || postalCode);
  const hasCoords = lat !== null && lng !== null;
  if (!hasText && !hasCoords) return null;
  return {
    addressLine: addressLine || null,
    city,
    parish,
    postalCode,
    lat,
    lng,
    updatedAt: new Date().toISOString(),
  };
};
const resolveOrderDestinationText = (order) => {
  const snap = order?.deliveryAddressSnapshot || {};
  const prefAddress = order?.deliveryPreferences?.deliveryAddress || {};
  const addressLine = String(
    snap.addressLine
    || snap.address
    || prefAddress.addressLine
    || prefAddress.address
    || ""
  ).trim();
  const city = String(snap.city || prefAddress.city || "").trim();
  const parish = String(snap.parish || prefAddress.parish || "").trim();
  const postalCode = String(snap.postalCode || prefAddress.postalCode || "").trim();
  const parts = [addressLine, city, parish, postalCode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};
const validateCaregiverIdFormat = (idType, idNumberRaw) => {
  const text = String(idNumberRaw || "").trim();
  if (!text) return "idNumber is required";
  const normalizedType = String(idType || "").trim().toLowerCase();
  switch (normalizedType) {
    case "national_id":
      return /^\d{9,12}$/.test(text)
        ? null
        : "National ID must be 9 to 12 digits";
    case "passport":
      return /^[A-Z0-9]{6,9}$/i.test(text)
        ? null
        : "Passport number must be 6 to 9 alphanumeric characters";
    case "driver_license":
      return /^[A-Z0-9-]{6,20}$/i.test(text)
        ? null
        : "Driver license must be 6 to 20 characters (letters, numbers, hyphen)";
    case "employee_id":
      return /^[A-Z0-9-]{4,20}$/i.test(text)
        ? null
        : "Employee ID must be 4 to 20 characters (letters, numbers, hyphen)";
    case "company_registration":
      return /^[A-Z0-9-]{5,25}$/i.test(text)
        ? null
        : "Company registration must be 5 to 25 characters (letters, numbers, hyphen)";
    case "other":
      return /^.{4,30}$/.test(text) ? null : "ID must be 4 to 30 characters";
    default:
      return "Unsupported idType";
  }
};
const parseStringList = (value) => {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((entry) => String(entry || "").trim())
          .filter(Boolean)
      )
    ).slice(0, 20);
  }
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ).slice(0, 20);
};
const decodeEncryptedStringList = (raw) => {
  const decrypted = decryptValue(raw);
  if (!decrypted) return [];
  try {
    const parsed = JSON.parse(decrypted);
    return parseStringList(Array.isArray(parsed) ? parsed : []);
  } catch (_err) {
    return parseStringList(String(decrypted || ""));
  }
};
const encodeStringList = (value) => {
  const normalized = parseStringList(value);
  if (!normalized.length) return null;
  return encryptValue(JSON.stringify(normalized));
};
const toStableStockStatus = (seed) => {
  const text = String(seed || "").toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash + text.charCodeAt(i) * (i + 3)) % 97;
  if (hash % 5 === 0) return "out_of_stock";
  if (hash % 3 === 0) return "low_stock";
  return "in_stock";
};
const getRequestedPatientId = (req) =>
  String(req.body?.patientId || req.query?.patientId || req.params?.patientId || "").trim();
const normalizeDispatchStatus = (order) => {
  const key = String(order?.dispatchStatus || "").trim().toLowerCase();
  if (key) return key;
  const orderStatus = String(order?.orderStatus || "").trim().toLowerCase();
  if (orderStatus === "assigned") return "assigned";
  if (orderStatus === "completed") return "delivered";
  if (orderStatus === "failed") return "failed";
  if (String(order?.deliveryOption || "").trim().toLowerCase() === "delivery") return "queued";
  return "none";
};
const isDeliveryOrderLike = (order) => {
  if (!order) return false;
  if (String(order?.deliveryOption || "").trim().toLowerCase() === "delivery") return true;
  if (Boolean(order?.deliveryAddressSnapshot)) return true;
  if (Boolean(order?.deliveryPreferences?.deliveryAddress || order?.deliveryPreferences?.instructions)) return true;
  if (Boolean(order?.courierId)) return true;
  if (Array.isArray(order?.dispatchTimeline) && order.dispatchTimeline.length > 0) return true;
  const dispatchStatus = normalizeDispatchStatus(order);
  if (dispatchStatus && dispatchStatus !== "none") return true;
  return false;
};

const resolveDefaultPharmacyId = async () => {
  const seededPharmacy = await User.findOne({ where: { role: "pharmacy", email: "pharmacy@refillit.dev" } });
  if (seededPharmacy?.id) return seededPharmacy.id;
  const anyPharmacyUser = await User.findOne({ where: { role: "pharmacy" } });
  if (anyPharmacyUser?.id) return anyPharmacyUser.id;
  const anyPharmacyProfile = await PharmacyProfile.findOne({});
  if (anyPharmacyProfile?.userId) return anyPharmacyProfile.userId;
  if (anyPharmacyProfile?.id) return anyPharmacyProfile.id;
  return null;
};

const DEFAULT_OTC_PRODUCTS = [
  {
    sku: "OTC-PAR-500",
    name: "Paracetamol 500mg",
    category: "pain_fever",
    dosageForm: "tablet",
    strength: "500mg",
    activeIngredient: "paracetamol",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-IBU-200",
    name: "Ibuprofen 200mg",
    category: "pain_inflammation",
    dosageForm: "tablet",
    strength: "200mg",
    activeIngredient: "ibuprofen",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-CET-10",
    name: "Cetirizine 10mg",
    category: "allergy",
    dosageForm: "tablet",
    strength: "10mg",
    activeIngredient: "cetirizine",
    maxQtyPerOrder: 2,
  },
  {
    sku: "OTC-ORS-500",
    name: "Oral Rehydration Salts",
    category: "hydration",
    dosageForm: "sachet",
    strength: "500ml",
    activeIngredient: "electrolytes",
    maxQtyPerOrder: 6,
  },
  {
    sku: "OTC-PSE-60",
    name: "Pseudoephedrine 60mg",
    category: "cold_flu",
    dosageForm: "tablet",
    strength: "60mg",
    activeIngredient: "pseudoephedrine",
    maxQtyPerOrder: 1,
  },
];

const ensureDefaultOtcProducts = async () => {
  for (const seed of DEFAULT_OTC_PRODUCTS) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await OtcProduct.findOne({ where: { sku: seed.sku } });
    if (exists) continue;
    // eslint-disable-next-line no-await-in-loop
    await OtcProduct.create({
      ...seed,
      requiresAgeCheck: seed.sku === "OTC-PSE-60",
      isActive: true,
      metadata: { source: "default_seed" },
    });
  }
};

const ensureDefaultOtcInventoryForDemo = async () => {
  await ensureDefaultOtcProducts();
  const seedPharmacyUser = await User.findOne({ where: { role: "pharmacy", email: "pharmacy@refillit.dev" } });
  const anyPharmacyUser = seedPharmacyUser || (await User.findOne({ where: { role: "pharmacy" } }));
  if (!anyPharmacyUser?.id) return;
  const profile = await PharmacyProfile.findOne({ where: { userId: anyPharmacyUser.id } });
  const targetPharmacyId = profile?.id || anyPharmacyUser.id;
  const products = await OtcProduct.findAll({});
  for (const product of products) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await PharmacyOtcInventory.findOne({
      where: { pharmacyId: targetPharmacyId, productId: product.id },
    });
    if (existing) continue;
    // eslint-disable-next-line no-await-in-loop
    await PharmacyOtcInventory.create({
      pharmacyId: targetPharmacyId,
      productId: product.id,
      onHand: 24,
      unitPrice: Number(
        {
          "OTC-PAR-500": 180,
          "OTC-IBU-200": 220,
          "OTC-CET-10": 260,
          "OTC-ORS-500": 140,
          "OTC-PSE-60": 320,
        }[String(product.sku || "").trim()] || 200
      ),
      maxPerOrder: Math.max(1, Number(product.maxQtyPerOrder || 1)),
      isListed: true,
      metadata: { source: "default_seed_inventory", seededBy: "system" },
    });
  }
};

const resolvePharmacyInventoryScope = async (pharmacyIdRaw) => {
  const pharmacyId = String(pharmacyIdRaw || "").trim();
  if (!pharmacyId) return new Set();
  const ids = new Set([pharmacyId]);
  const user = await User.findByPk(pharmacyId);
  if (user && String(user.role || "").toLowerCase() === "pharmacy") {
    const profile = await PharmacyProfile.findOne({ where: { userId: user.id } });
    if (profile?.id) ids.add(String(profile.id));
    return ids;
  }
  const profile = await PharmacyProfile.findByPk(pharmacyId);
  if (profile?.userId) ids.add(String(profile.userId));
  return ids;
};

const OTC_INGREDIENT_QTY_CAPS = {
  paracetamol: 2,
  ibuprofen: 2,
  cetirizine: 2,
  pseudoephedrine: 1,
};

const OTC_INTERACTION_RULES = {
  ibuprofen: ["ulcer", "kidney", "renal", "pregnan", "asthma"],
  paracetamol: ["liver", "hepat"],
  cetirizine: ["glaucoma"],
  pseudoephedrine: ["hypertension", "blood pressure", "heart", "cardiac"],
};

const calculateAgeYears = (dobValue) => {
  const dob = new Date(dobValue || "");
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
};

const prepareOtcCart = async ({ pharmacyId, items }) => {
  const scopeIds = await resolvePharmacyInventoryScope(pharmacyId);
  if (!scopeIds.size) {
    return { ok: false, status: 400, error: "Invalid pharmacyId" };
  }
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, status: 400, error: "items are required" };
  }
  if (items.length > 30) {
    return { ok: false, status: 400, error: "items cannot exceed 30" };
  }

  const products = await OtcProduct.findAll({});
  const productsById = new Map(products.map((entry) => [String(entry.id), entry]));
  const inventoryRows = await PharmacyOtcInventory.findAll({});
  const matchingInventory = inventoryRows.filter((entry) => scopeIds.has(String(entry.pharmacyId || "")));
  const inventoryByProductId = new Map(
    matchingInventory.map((entry) => [String(entry.productId || ""), entry])
  );

  const normalizedItems = [];
  let subtotal = 0;
  for (const item of items) {
    const productId = String(item?.productId || "").trim();
    const qty = Math.max(1, Number(item?.qty || 1));
    if (!productId || !Number.isFinite(qty)) {
      return { ok: false, status: 400, error: "Each item requires productId and qty" };
    }
    const product = productsById.get(productId);
    const inv = inventoryByProductId.get(productId);
    if (!product || product.isActive === false || !inv || inv.isListed === false) {
      return { ok: false, status: 409, error: `Item unavailable for product ${productId}` };
    }
    if (Number(inv.onHand || 0) < qty) {
      return { ok: false, status: 409, error: `${product.name || "Item"} has insufficient stock` };
    }
    const maxQty = Math.max(1, Number(inv.maxPerOrder || product.maxQtyPerOrder || 1));
    if (qty > maxQty) {
      return { ok: false, status: 409, error: `${product.name || "Item"} max quantity is ${maxQty}` };
    }
    const unitPrice = toMoney(inv.unitPrice || 0);
    const lineTotal = toMoney(unitPrice * qty);
    subtotal = toMoney(subtotal + lineTotal);
    normalizedItems.push({
      productId: product.id,
      sku: product.sku || null,
      productName: product.name || "OTC Item",
      qty,
      unitPrice,
      lineTotal,
      inventoryId: inv.id,
      pharmacyId: inv.pharmacyId,
      activeIngredient: String(product.activeIngredient || "").trim().toLowerCase() || null,
      requiresAgeCheck: Boolean(product.requiresAgeCheck),
    });
  }
  return { ok: true, normalizedItems, subtotal, scopeIds };
};

const assessOtcSafety = ({ patientProfile, normalizedItems = [] }) => {
  const blockers = [];
  const warnings = [];
  const conditions = decodeEncryptedStringList(patientProfile?.conditions)
    .map((entry) => String(entry || "").toLowerCase());
  const allergies = decodeEncryptedStringList(patientProfile?.allergies)
    .map((entry) => String(entry || "").toLowerCase());
  const ageYears = calculateAgeYears(patientProfile?.dob);

  const ingredientQty = new Map();
  for (const item of normalizedItems) {
    const ingredient = String(item.activeIngredient || "").trim().toLowerCase();
    if (!ingredient) continue;
    ingredientQty.set(ingredient, Number(ingredientQty.get(ingredient) || 0) + Number(item.qty || 0));
  }

  for (const item of normalizedItems) {
    const ingredient = String(item.activeIngredient || "").trim().toLowerCase();
    if (!ingredient) continue;

    if (item.requiresAgeCheck) {
      const minAge = Math.max(0, Number(process.env.OTC_AGE_GATE_MIN_YEARS || 18));
      if (ageYears === null) {
        blockers.push(`${item.productName}: date of birth is required for age-restricted OTC item`);
      } else if (ageYears < minAge) {
        blockers.push(`${item.productName}: patient age ${ageYears} is below minimum ${minAge}`);
      }
    }

    if (allergies.some((entry) => entry.includes(ingredient))) {
      blockers.push(`${item.productName}: blocked due to allergy match (${ingredient})`);
    }

    const cap = Number(OTC_INGREDIENT_QTY_CAPS[ingredient] || 0);
    if (cap > 0 && Number(ingredientQty.get(ingredient) || 0) > cap) {
      blockers.push(`Ingredient cap exceeded for ${ingredient}: max ${cap} units per order`);
    }

    const ruleKeywords = OTC_INTERACTION_RULES[ingredient] || [];
    if (ruleKeywords.length) {
      const matchedKeyword = ruleKeywords.find((keyword) =>
        conditions.some((condition) => condition.includes(String(keyword).toLowerCase()))
      );
      if (matchedKeyword) {
        warnings.push(
          `${item.productName}: caution due to condition keyword '${matchedKeyword}'. Pharmacist review advised.`
        );
      }
    }
  }

  return {
    blockers: Array.from(new Set(blockers)),
    warnings: Array.from(new Set(warnings)),
    ageYears,
  };
};

const requireSettledOtcPaymentIntent = async ({ patientId, paymentIntentId }) => {
  const intentId = String(paymentIntentId || "").trim();
  if (!intentId) {
    return { ok: false, status: 400, error: "paymentIntentId is required" };
  }
  const intent = await PaymentIntent.findByPk(intentId);
  if (!intent) return { ok: false, status: 404, error: "Payment intent not found" };
  if (String(intent.patientId || "") !== String(patientId || "")) {
    return { ok: false, status: 403, error: "Payment intent does not belong to patient" };
  }
  if (String(intent.paymentScope || "").toLowerCase() !== "otc") {
    return { ok: false, status: 409, error: "Payment intent is not an OTC intent" };
  }
  const paymentStatus = String(intent.status || "").toLowerCase();
  if (!PAYMENT_FINAL_STATUSES.has(paymentStatus)) {
    return { ok: false, status: 409, error: "Payment must be authorized or paid before order creation" };
  }
  return { ok: true, intent };
};

const sumLedgerBalance = (rows = []) =>
  Number(
    rows.reduce((sum, entry) => sum + toMoney(entry.amount || 0), 0).toFixed(2)
  );

const getPatientWalletSummary = async (patientId) => {
  const [walletRows, nhfRows] = await Promise.all([
    WalletLedger.findAll({ where: { patientId } }),
    NhfCreditLedger.findAll({ where: { patientId } }),
  ]);
  return {
    walletBalance: sumLedgerBalance(walletRows),
    nhfCreditBalance: sumLedgerBalance(nhfRows),
  };
};

const requireSettledPaymentIntent = async ({ patientId, prescId, paymentIntentId }) => {
  const intentId = String(paymentIntentId || "").trim();
  if (!intentId) {
    return { ok: false, status: 400, error: "paymentIntentId is required" };
  }
  const intent = await PaymentIntent.findByPk(intentId);
  if (!intent) return { ok: false, status: 404, error: "Payment intent not found" };
  if (String(intent.patientId || "") !== String(patientId || "")) {
    return { ok: false, status: 403, error: "Payment intent does not belong to patient" };
  }
  if (String(intent.prescId || "") !== String(prescId || "")) {
    return { ok: false, status: 409, error: "Payment intent does not match prescription" };
  }
  const paymentStatus = String(intent.status || "").toLowerCase();
  if (!PAYMENT_FINAL_STATUSES.has(paymentStatus)) {
    return { ok: false, status: 409, error: "Payment must be authorized or paid before order creation" };
  }
  return { ok: true, intent };
};
const buildPatientOtpState = (order) => {
  const otp = order?.deliveryOtp || null;
  if (!otp?.issuedAt || !otp?.expiresAt) {
    return {
      status: "not_issued",
      issuedAt: null,
      expiresAt: null,
      attempts: 0,
      maxAttempts: 0,
      locked: false,
    };
  }
  const issuedDate = new Date(otp.issuedAt);
  const expiresDate = new Date(otp.expiresAt);
  const issuedAt = Number.isNaN(issuedDate.getTime()) ? null : issuedDate.toISOString();
  const expiresAt = Number.isNaN(expiresDate.getTime()) ? null : expiresDate.toISOString();
  const attempts = Math.max(0, Number(otp.attempts || 0));
  const maxAttempts = Math.max(1, Number(process.env.DISPATCH_OTP_MAX_ATTEMPTS || 5));
  const locked = attempts >= maxAttempts;
  const expired = expiresAt ? Date.now() > new Date(expiresAt).getTime() : false;
  const consumed = Boolean(otp.consumedAt);
  const fallbackCode = String(decryptValue(otp.patientCodeCipher) || "").trim();
  const status = locked
    ? "locked"
    : consumed
      ? "verified"
      : expired
        ? "expired"
        : "issued";
  return {
    status,
    issuedAt,
    expiresAt,
    attempts,
    maxAttempts,
    locked,
    qrToken:
      status === "issued" && String(otp.qrToken || "").trim()
        ? String(otp.qrToken).trim()
        : null,
    fallbackCode: status === "issued" && fallbackCode ? fallbackCode : null,
  };
};

const buildPatientOrderTimeline = (order) => {
  const base = typeof order?.toJSON === "function" ? order.toJSON() : order || {};
  const createdAt = base?.createdAt || null;
  const events = [];
  if (createdAt) {
    events.push({
      id: `${String(base.id || "order")}-created`,
      at: createdAt,
      type: "order_created",
      stage: "submitted",
      source: "order",
      label: "Order submitted",
      detail: "Your order was created and sent to the pharmacy.",
    });
  }

  const statusHistory = Array.isArray(base?.statusHistory) ? base.statusHistory : [];
  const statusLabels = {
    submitted: { label: "Order submitted", detail: "Waiting for pharmacy review." },
    processing: { label: "Pharmacy accepted order", detail: "Your pharmacy is preparing the prescription." },
    ready: {
      label:
        String(base?.deliveryOption || "").toLowerCase() === "delivery"
          ? "Prescription ready for dispatch"
          : "Prescription ready for pickup",
      detail:
        String(base?.deliveryOption || "").toLowerCase() === "delivery"
          ? "The pharmacy finished preparation and the order is ready for courier handoff."
          : "The pharmacy finished preparation and the order is ready for you.",
    },
    assigned: { label: "Courier assignment recorded", detail: "A courier is now responsible for delivery." },
    completed: { label: "Order completed", detail: "The prescription order reached its final completed state." },
    failed: { label: "Order failed", detail: "The order encountered an exception and needs attention." },
  };
  for (const entry of statusHistory) {
    const status = String(entry?.status || "").toLowerCase();
    const meta = statusLabels[status] || {
      label: `Order ${status || "updated"}`,
      detail: entry?.by ? `Updated by ${entry.by}` : "Order status changed.",
    };
    events.push({
      id: entry?.id || `${String(base.id || "order")}-status-${status}-${entry?.at || Math.random()}`,
      at: entry?.at || null,
      type: `status_${status || "updated"}`,
      stage: status || null,
      source: "pharmacy",
      label: meta.label,
      detail: meta.detail,
    });
  }

  const dispatchTimeline = Array.isArray(base?.dispatchTimeline) ? base.dispatchTimeline : [];
  const dispatchLabels = {
    queued: { label: "Queued for courier assignment", detail: "Waiting for an available courier." },
    assigned: { label: "Courier assigned", detail: "A courier has been assigned to your order." },
    accepted: { label: "Courier accepted job", detail: "The courier confirmed the delivery route." },
    picked_up: { label: "Prescription picked up", detail: "The courier has the order in hand." },
    arrived: { label: "Courier arrived", detail: "The courier has reached the delivery area." },
    delivered: { label: "Delivered", detail: "Delivery was completed successfully." },
    failed: { label: "Dispatch issue", detail: "Delivery encountered a dispatch exception." },
    otp_issued: { label: "Secure delivery QR issued", detail: "Your one-time QR handoff token is ready." },
    otp_delivery_attempt: { label: "Delivery code sent", detail: "A secure delivery code was sent to you." },
    otp_failed: { label: "Delivery code validation failed", detail: "A previous QR or OTP attempt did not validate." },
    geofence_warning: { label: "Location verification warning", detail: "Delivery location check raised a warning." },
    auto_assigned: { label: "Courier auto-assigned", detail: "Dispatch assigned a courier automatically." },
    batch_assigned: { label: "Courier assigned by dispatch batch", detail: "Dispatch assigned a courier in batch ops." },
  };
  for (const entry of dispatchTimeline) {
    const type = String(entry?.type || "").toLowerCase();
    const meta = dispatchLabels[type] || {
      label: `Dispatch ${type || "updated"}`,
      detail: "Delivery workflow advanced.",
    };
    events.push({
      id: entry?.id || `${String(base.id || "order")}-dispatch-${type}-${entry?.at || Math.random()}`,
      at: entry?.at || null,
      type: type || "dispatch_update",
      stage: type || null,
      source: "dispatch",
      label: meta.label,
      detail: meta.detail,
      meta: entry?.meta || null,
    });
  }

  return events
    .filter((entry) => entry.at)
    .sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
};

const resolvePatientAccessContext = async (req, { scopeKey = null } = {}) => {
  if (req.user?.role === "patient") {
    return { ok: true, patientId: req.user.id, proxyLink: null, isProxy: false };
  }
  if (!CAREGIVER_ROLES.has(String(req.user?.role || "").toLowerCase())) {
    return { ok: false, status: 403, error: "Unsupported role for patient context access" };
  }
  const patientId = getRequestedPatientId(req);
  if (!patientId) {
    return { ok: false, status: 400, error: "patientId is required for caregiver access" };
  }
  const proxyLink = await PatientProxyAccess.findOne({
    where: {
      patientId,
      proxyUserId: req.user.id,
      active: true,
    },
  });
  if (!proxyLink) {
    return { ok: false, status: 403, error: "No active proxy access for requested patient" };
  }
  if (scopeKey && proxyLink[scopeKey] !== true) {
    return {
      ok: false,
      status: 403,
      error: `Proxy access does not include required permission: ${scopeKey}`,
    };
  }
  return { ok: true, patientId, proxyLink, isProxy: true };
};

router.get("/proxy-patients", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  if (req.user?.role === "patient") {
    return res.json({
      patients: [
        {
          id: req.user.id,
          fullName: req.user.fullName || null,
          email: req.user.email || null,
          relationship: "self",
          permissions: {
            canViewEmergencyCard: true,
            canRequestRefills: true,
            canBookAppointments: true,
          },
          active: true,
        },
      ],
    });
  }
  const links = await PatientProxyAccess.findAll({
    where: {
      proxyUserId: req.user.id,
      active: true,
    },
  });
  const uniquePatientIds = Array.from(
    new Set(links.map((entry) => String(entry.patientId || "").trim()).filter(Boolean))
  );
  const userById = new Map();
  for (const patientId of uniquePatientIds) {
    // eslint-disable-next-line no-await-in-loop
    const patientUser = await User.findByPk(patientId);
    if (patientUser && patientUser.role === "patient") {
      userById.set(patientId, patientUser);
    }
  }
  const patients = links
    .map((entry) => {
      const patientId = String(entry.patientId || "").trim();
      const patientUser = userById.get(patientId);
      if (!patientId || !patientUser) return null;
      return {
        id: patientId,
        fullName: patientUser.fullName || null,
        email: patientUser.email || null,
        relationship: entry.relationship || "caregiver",
        permissions: {
          canViewEmergencyCard: entry.canViewEmergencyCard !== false,
          canRequestRefills: entry.canRequestRefills !== false,
          canBookAppointments: entry.canBookAppointments !== false,
        },
        active: entry.active !== false,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.fullName || "").localeCompare(String(b.fullName || "")));
  return res.json({ patients });
});

router.post(
  "/prescriptions/:id/link",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const normalizeLinkCode = (value) =>
      String(value || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "")
        .replace(/O/g, "0")
        .replace(/I/g, "1")
        .replace(/L/g, "1");

    const prescription = await Prescription.findByPk(req.params.id);
    if (!prescription) {
      return res.status(404).json({ error: "Prescription not found" });
    }
    const submittedCode = normalizeLinkCode((req.body || {}).code);
    const storedCode = normalizeLinkCode(prescription.linkCode);
    if (!submittedCode || submittedCode !== storedCode) {
      return res.status(400).json({ error: "Invalid link code" });
    }
    prescription.patientId = req.user.id;
    prescription.linked = true;
    await prescription.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "patient.prescription.link",
      entityType: "prescription",
      entityId: prescription.id,
    });
    return res.json({ prescription });
  }
);

router.get("/prescriptions", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const prescriptions = await Prescription.findAll({ where: { patientId: ctx.patientId } });
  prescriptions.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({
    prescriptions: prescriptions.map((entry) => ({
      id: entry.id,
      doctorId: entry.doctorId,
      doctorName: entry.doctorName || null,
      meds: entry.meds || [],
      allowedRefills: Number(entry.allowedRefills || 0),
      linkCode: entry.linkCode,
      expiryDate: entry.expiryDate || null,
      linked: Boolean(entry.linked),
      qrDataUrl: entry.qrDataUrl || null,
      qrPayload: entry.qrPayload || null,
      createdAt: entry.createdAt,
    })),
  });
});

router.get("/referrals", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const status = String(req.query.status || "").trim().toLowerCase();
  const referrals = await Referral.findAll({ where: { patientId: ctx.patientId } });
  referrals.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const doctorCache = new Map();
  const items = [];
  for (const entry of referrals) {
    const entryStatus = String(entry.status || "pending").toLowerCase();
    if (status && entryStatus !== status) continue;
    const doctorId = String(entry.doctorId || "").trim();
    let doctorName = null;
    if (doctorId) {
      if (!doctorCache.has(doctorId)) {
        // eslint-disable-next-line no-await-in-loop
        const doctor = await User.findByPk(doctorId);
        doctorCache.set(doctorId, doctor?.fullName || null);
      }
      doctorName = doctorCache.get(doctorId) || null;
    }
    items.push({
      id: entry.id,
      referralReference:
        String(entry.referralReference || "").trim()
        || `RF-${String(entry.id || "").slice(0, 8).toUpperCase()}`,
      referralType: entry.referralType || null,
      targetName: entry.targetName || null,
      targetSpecialty: entry.targetSpecialty || null,
      targetContact: entry.targetContact || null,
      reason: entry.reason || null,
      clinicalQuestion: entry.clinicalQuestion || null,
      requestedByDate: entry.requestedByDate || null,
      priority: entry.priority || "routine",
      status: entryStatus,
      attachmentUrls: Array.isArray(entry.attachmentUrls) ? entry.attachmentUrls : [],
      doctorId: doctorId || null,
      doctorName,
      statusTimeline: Array.isArray(entry.statusTimeline) ? entry.statusTimeline : [],
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
    });
  }
  return res.json({ referrals: items });
});

router.get("/referrals/:id/packet", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const referral = await Referral.findByPk(req.params.id);
  if (!referral || String(referral.patientId || "") !== String(ctx.patientId || "")) {
    return res.status(404).json({ error: "Referral not found" });
  }
  const doctor = referral.doctorId ? await User.findByPk(referral.doctorId) : null;
  const patient = await User.findByPk(ctx.patientId);
  const reference =
    String(referral.referralReference || "").trim()
    || `RF-${String(referral.id || "").slice(0, 8).toUpperCase()}`;
  const lines = [
    "REFILLIT REFERRAL PACKET",
    `Reference: ${reference}`,
    `Created: ${referral.createdAt ? new Date(referral.createdAt).toLocaleString() : "n/a"}`,
    `Status: ${String(referral.status || "pending")}`,
    "",
    "PATIENT",
    `Name: ${patient?.fullName || ctx.patientId}`,
    `Patient ID: ${ctx.patientId}`,
    "",
    "REFERRING DOCTOR",
    `Name: ${doctor?.fullName || referral.doctorId || "n/a"}`,
    `Doctor ID: ${referral.doctorId || "n/a"}`,
    "",
    "REFERRAL DETAILS",
    `Type: ${referral.referralType || "n/a"}`,
    `Priority: ${referral.priority || "routine"}`,
    `Target: ${referral.targetName || "n/a"}`,
    `Specialty/Service: ${referral.targetSpecialty || "n/a"}`,
    `Target Contact: ${referral.targetContact || "n/a"}`,
    `Requested By: ${referral.requestedByDate || "n/a"}`,
    "",
    "REASON",
    String(referral.reason || "n/a"),
    "",
    "CLINICAL QUESTION",
    String(referral.clinicalQuestion || "n/a"),
    "",
    "ATTACHMENTS",
    ...(Array.isArray(referral.attachmentUrls) && referral.attachmentUrls.length
      ? referral.attachmentUrls.map((entry, idx) => `${idx + 1}. ${entry}`)
      : ["none"]),
    "",
    "Take this packet and reference code to the receiving lab/specialist.",
  ];
  return res.json({
    referral: {
      id: referral.id,
      referralReference: reference,
      status: referral.status || "pending",
      referralType: referral.referralType || null,
      targetName: referral.targetName || null,
      priority: referral.priority || "routine",
      requestedByDate: referral.requestedByDate || null,
    },
    packetText: lines.join("\n"),
  });
});

router.get("/caregiver-proxies", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const links = await PatientProxyAccess.findAll({ where: { patientId: req.user.id } });
  links.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const proxies = [];
  for (const link of links) {
    // eslint-disable-next-line no-await-in-loop
    const proxyUser = await User.findByPk(link.proxyUserId);
    if (!proxyUser) continue;
    proxies.push({
      id: link.id,
      proxyUserId: link.proxyUserId,
      fullName: proxyUser.fullName || null,
      email: proxyUser.email || null,
      relationship: link.relationship || "caregiver",
      phone: link.phone || null,
      idType: link.idType || null,
      idNumberMasked: link.idNumberMasked || null,
      organizationName: link.organizationName || null,
      verificationStatus: normalizeVerificationStatus(link.verificationStatus),
      verificationVerifiedAt: link.verificationVerifiedAt || null,
      verificationNote: link.verificationNote || null,
      active: link.active !== false,
      permissions: {
        canViewEmergencyCard: link.canViewEmergencyCard !== false,
        canRequestRefills: link.canRequestRefills !== false,
        canBookAppointments: link.canBookAppointments !== false,
      },
      notes: link.notes || null,
      createdAt: link.createdAt || null,
      updatedAt: link.updatedAt || null,
    });
  }
  return res.json({ proxies });
});

router.post("/caregiver-proxies", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const fullName = String(req.body?.fullName || "").trim();
  const emailRaw = String(req.body?.email || "").trim();
  const relationship = String(req.body?.relationship || "caregiver").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim() || null;
  const idType = String(req.body?.idType || "").trim().toLowerCase();
  const idNumberRaw = String(req.body?.idNumber || "").trim();
  const organizationName = String(req.body?.organizationName || "").trim() || null;
  const allowedIdTypes = new Set([
    "national_id",
    "passport",
    "driver_license",
    "employee_id",
    "company_registration",
    "other",
  ]);
  if (!fullName || !emailRaw) {
    return res.status(400).json({ error: "fullName and email are required" });
  }
  if (!allowedIdTypes.has(idType)) {
    return res.status(400).json({ error: "idType is required and must be a supported value" });
  }
  const idFormatError = validateCaregiverIdFormat(idType, idNumberRaw);
  if (idFormatError) {
    return res.status(400).json({ error: idFormatError });
  }
  const email = normalizeEmail(emailRaw);
  let proxyUser = await User.findOne({ where: { email } });
  let issuedCredentials = null;
  if (!proxyUser) {
    const temporaryPassword = String(req.body?.password || "").trim() || `Proxy-${randomCode()}!`;
    proxyUser = await User.create({
      fullName,
      email,
      role: "caregiver",
      passwordHash: await hashPassword(temporaryPassword),
      createdByDoctorId: null,
    });
    issuedCredentials = {
      email: proxyUser.email,
      temporaryPassword,
    };
  } else if (!["caregiver", "patient_proxy"].includes(String(proxyUser.role || "").toLowerCase())) {
    return res.status(409).json({ error: "Email belongs to an existing non-caregiver account" });
  } else if (fullName && proxyUser.fullName !== fullName) {
    proxyUser.fullName = fullName;
    await proxyUser.save();
  }

  let link = await PatientProxyAccess.findOne({
    where: {
      patientId: req.user.id,
      proxyUserId: proxyUser.id,
    },
  });
  const permissions = req.body?.permissions || {};
  const requestedVerificationStatus = String(req.body?.verificationStatus || "").trim().toLowerCase();
  const currentVerificationStatus = normalizeVerificationStatus(link?.verificationStatus);
  const nextVerificationStatus =
    requestedVerificationStatus === "verified" || requestedVerificationStatus === "declined" || requestedVerificationStatus === "pending"
      ? requestedVerificationStatus
      : currentVerificationStatus;
  const nextValues = {
    relationship: relationship || "caregiver",
    phone,
    idType,
    idNumber: encryptValue(idNumberRaw),
    idNumberMasked: maskIdNumber(idNumberRaw),
    organizationName,
    verificationStatus: nextVerificationStatus,
    verificationVerifiedAt: nextVerificationStatus === "verified" ? new Date().toISOString() : null,
    verificationNote:
      nextVerificationStatus === "pending"
        ? null
        : String(req.body?.verificationNote || "").trim() || null,
    active: req.body?.active !== false,
    canViewEmergencyCard: permissions.canViewEmergencyCard !== false,
    canRequestRefills: permissions.canRequestRefills !== false,
    canBookAppointments: permissions.canBookAppointments !== false,
    notes: String(req.body?.notes || "").trim() || null,
  };
  if (!link) {
    link = await PatientProxyAccess.create({
      patientId: req.user.id,
      proxyUserId: proxyUser.id,
      ...nextValues,
    });
  } else {
    Object.assign(link, nextValues);
    await link.save();
  }

  await writeAudit({
    actorUserId: req.user.id,
    action: "patient.proxy_access.upsert",
    entityType: "patient_proxy_access",
    entityId: link.id,
    metadata: {
      patientId: req.user.id,
      proxyUserId: proxyUser.id,
    },
  });

  return res.status(201).json({
    proxy: {
      id: link.id,
      proxyUserId: proxyUser.id,
      fullName: proxyUser.fullName || null,
      email: proxyUser.email || null,
      relationship: link.relationship || "caregiver",
      phone: link.phone || null,
      idType: link.idType || null,
      idNumberMasked: link.idNumberMasked || null,
      organizationName: link.organizationName || null,
      verificationStatus: normalizeVerificationStatus(link.verificationStatus),
      verificationVerifiedAt: link.verificationVerifiedAt || null,
      verificationNote: link.verificationNote || null,
      active: link.active !== false,
      permissions: {
        canViewEmergencyCard: link.canViewEmergencyCard !== false,
        canRequestRefills: link.canRequestRefills !== false,
        canBookAppointments: link.canBookAppointments !== false,
      },
      notes: link.notes || null,
      createdAt: link.createdAt || null,
      updatedAt: link.updatedAt || null,
    },
    credentialsIssued: issuedCredentials,
  });
});

router.post(
  "/caregiver-proxies/:id/toggle",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const link = await PatientProxyAccess.findByPk(req.params.id);
    if (!link || link.patientId !== req.user.id) {
      return res.status(404).json({ error: "Proxy link not found" });
    }
    link.active = req.body?.active !== false;
    await link.save();
    return res.json({ proxy: link });
  }
);

router.post(
  "/caregiver-proxies/:id/verification",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const link = await PatientProxyAccess.findByPk(req.params.id);
    if (!link || link.patientId !== req.user.id) {
      return res.status(404).json({ error: "Proxy link not found" });
    }
    const requestedStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!["verified", "declined", "pending"].includes(requestedStatus)) {
      return res.status(400).json({ error: "status must be verified, declined, or pending" });
    }
    const status = normalizeVerificationStatus(requestedStatus);
    link.verificationStatus = status;
    link.verificationVerifiedAt = status === "verified" ? new Date().toISOString() : null;
    link.verificationNote = status === "pending" ? null : String(req.body?.note || "").trim() || null;
    await link.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "patient.proxy_access.verification",
      entityType: "patient_proxy_access",
      entityId: link.id,
      metadata: { status },
    });
    const proxyUser = await User.findByPk(link.proxyUserId);
    return res.json({
      proxy: {
        id: link.id,
        proxyUserId: link.proxyUserId,
        fullName: proxyUser?.fullName || null,
        email: proxyUser?.email || null,
        relationship: link.relationship || "caregiver",
        phone: link.phone || null,
        idType: link.idType || null,
        idNumberMasked: link.idNumberMasked || null,
        organizationName: link.organizationName || null,
        verificationStatus: normalizeVerificationStatus(link.verificationStatus),
        verificationVerifiedAt: link.verificationVerifiedAt || null,
        verificationNote: link.verificationNote || null,
        active: link.active !== false,
        permissions: {
          canViewEmergencyCard: link.canViewEmergencyCard !== false,
          canRequestRefills: link.canRequestRefills !== false,
          canBookAppointments: link.canBookAppointments !== false,
        },
        notes: link.notes || null,
        createdAt: link.createdAt || null,
        updatedAt: link.updatedAt || null,
      },
    });
  }
);

router.get("/emergency-card", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canViewEmergencyCard" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const profile = await PatientProfile.findOne({ where: { userId: ctx.patientId } });
  const prescriptions = await Prescription.findAll({ where: { patientId: ctx.patientId } });
  const doctorConnections = await DoctorConnection.findAll({
    where: { patientId: ctx.patientId, status: "approved" },
  });
  const doctorContacts = [];
  for (const connection of doctorConnections) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(connection.doctorId);
    if (!doctor || doctor.role !== "doctor") continue;
    doctorContacts.push({
      doctorId: doctor.id,
      fullName: doctor.fullName || null,
      email: doctor.email || null,
    });
  }
  const card = {
    patient: {
      id: ctx.patientId,
      fullName: null,
      email: null,
      dob: profile?.dob || null,
      phone: profile?.phone || null,
      emergencyContactName: decryptValue(profile?.emergencyContactName) || null,
      emergencyContactPhone: decryptValue(profile?.emergencyContactPhone) || null,
    },
    allergies: decodeEncryptedStringList(profile?.allergies),
    conditions: decodeEncryptedStringList(profile?.conditions),
    meds: prescriptions
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .flatMap((prescription) =>
        (prescription.meds || []).map((med) => ({
          prescriptionId: prescription.id,
          name: med.name || med.ndcCode || "Medication",
          strength: med.strength || null,
          qty: Number(med.qty || 0),
          allowedRefills: Number(prescription.allowedRefills || 0),
          expiryDate: prescription.expiryDate || null,
        }))
      )
      .slice(0, 25),
    doctorContacts,
    insurance: {
      provider: decryptValue(profile?.insuranceProvider) || null,
      policyNumber: decryptValue(profile?.insurancePolicyNumber) || null,
      nhfNumber: decryptValue(profile?.nhfNumber) || null,
    },
    updatedAt: profile?.updatedAt || profile?.createdAt || null,
  };
  const patientUser = await User.findByPk(ctx.patientId);
  card.patient.id = patientUser?.id || ctx.patientId;
  card.patient.fullName = patientUser?.fullName || null;
  card.patient.email = patientUser?.email || null;
  return res.json({ card });
});

router.post("/emergency-card", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canViewEmergencyCard" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  let profile = await PatientProfile.findOne({ where: { userId: ctx.patientId } });
  if (!profile) {
    profile = await PatientProfile.create({ userId: ctx.patientId });
  }
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, "allergies")) {
    profile.allergies = encodeStringList(body.allergies);
  }
  if (Object.prototype.hasOwnProperty.call(body, "conditions")) {
    profile.conditions = encodeStringList(body.conditions);
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
  if (Object.prototype.hasOwnProperty.call(body, "insuranceProvider")) {
    profile.insuranceProvider = body.insuranceProvider ? encryptValue(body.insuranceProvider) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "insurancePolicyNumber")) {
    profile.insurancePolicyNumber = body.insurancePolicyNumber
      ? encryptValue(body.insurancePolicyNumber)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "nhfNumber")) {
    profile.nhfNumber = body.nhfNumber ? encryptValue(body.nhfNumber) : null;
  }
  await profile.save();
  return res.status(201).json({ updated: true });
});

router.get("/smart-refill-assistant", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const prescriptions = await Prescription.findAll({ where: { patientId: ctx.patientId } });
  const orders = await Order.findAll({ where: { patientId: ctx.patientId } });
  const now = Date.now();
  const items = [];
  for (const prescription of prescriptions) {
    const prescriptionOrders = orders
      .filter((order) => order.prescId === prescription.id)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const lastCompletedFill = prescriptionOrders.find((order) => order.orderStatus === "completed") || null;
    const baseDate = new Date(lastCompletedFill?.createdAt || prescription.createdAt || Date.now());
    const cycleMs = 30 * 24 * 60 * 60 * 1000;
    const cycleDueAt = new Date(baseDate.getTime() + cycleMs);
    const cycleDueInDays = Math.ceil((cycleDueAt.getTime() - now) / (24 * 60 * 60 * 1000));
    const remainingRefills = Math.max(0, Number(prescription.allowedRefills || 0));
    let expiryAt = null;
    if (prescription.expiryDate) {
      const rawExpiry = String(prescription.expiryDate).trim();
      // Treat YYYY-MM-DD as end-of-day so "today" does not look already expired at midnight.
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry)) {
        expiryAt = new Date(`${rawExpiry}T23:59:59`);
      } else {
        expiryAt = new Date(rawExpiry);
      }
    }
    const expiryInDays =
      expiryAt && !Number.isNaN(expiryAt.getTime())
        ? Math.ceil((expiryAt.getTime() - now) / (24 * 60 * 60 * 1000))
        : null;
    const useExpiryForDue =
      expiryAt &&
      !Number.isNaN(expiryAt.getTime()) &&
      (expiryInDays <= cycleDueInDays);
    const dueAt = useExpiryForDue ? expiryAt : cycleDueAt;
    const refillDueInDays = useExpiryForDue ? expiryInDays : cycleDueInDays;
    const meds = Array.isArray(prescription.meds) ? prescription.meds : [];
    const alternatives = meds.flatMap((med) => {
      const match = MOH_DRUGS.find(
        (entry) =>
          String(entry.name || "").toLowerCase() === String(med.name || "").toLowerCase() ||
          String(entry.code || "").toLowerCase() === String(med.ndcCode || "").toLowerCase()
      );
      if (!match) return [];
      return MOH_DRUGS.filter(
        (candidate) => candidate.approved && candidate.medicationType === match.medicationType && candidate.code !== match.code
      )
        .slice(0, 2)
        .map((candidate) => ({
          code: candidate.code,
          name: candidate.name,
          strength: candidate.strengths?.[0] || null,
          usedFor: candidate.usedFor || null,
          stockStatus: toStableStockStatus(`${candidate.code}-${ctx.patientId}`),
        }));
    });
    const uniqueAlternatives = [];
    const seenAlternativeCodes = new Set();
    for (const alt of alternatives) {
      if (seenAlternativeCodes.has(alt.code)) continue;
      seenAlternativeCodes.add(alt.code);
      uniqueAlternatives.push(alt);
    }
    items.push({
      prescId: prescription.id,
      doctorId: prescription.doctorId || null,
      doctorName: prescription.doctorName || null,
      meds,
      remainingRefills,
      refillDueInDays,
      dueAt: dueAt.toISOString(),
      expiryDate: prescription.expiryDate || null,
      expiryInDays,
      oneClickEligible: remainingRefills > 0 && refillDueInDays <= 7,
      alternatives: uniqueAlternatives.slice(0, 4),
    });
  }
  items.sort((a, b) => a.refillDueInDays - b.refillDueInDays);
  return res.json({ items });
});

router.get(
  "/payment/wallet-summary",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const summary = await getPatientWalletSummary(ctx.patientId);
    return res.json({
      patientId: ctx.patientId,
      currency: "JMD",
      walletBalance: summary.walletBalance,
      nhfCreditBalance: summary.nhfCreditBalance,
    });
  }
);

router.post(
  "/payment-intents",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const prescId = String(req.body?.prescId || "").trim();
    if (!prescId) return res.status(400).json({ error: "prescId is required" });
    const prescription = await Prescription.findByPk(prescId);
    if (!prescription || String(prescription.patientId || "") !== String(ctx.patientId || "")) {
      return res.status(404).json({ error: "Prescription not found for patient" });
    }
    const method = String(req.body?.method || "card").trim().toLowerCase();
    if (!PAYMENT_METHODS.has(method)) {
      return res.status(400).json({ error: "method must be card, nhf_credit, rx_card, or split" });
    }
    const refillAmount = toMoney(req.body?.refillAmount || 3000);
    const deliveryFee = toMoney(req.body?.deliveryFee || 600);
    const totalAmount = toMoney(refillAmount + deliveryFee);
    const intent = await PaymentIntent.create({
      patientId: ctx.patientId,
      prescId,
      method,
      currency: "JMD",
      refillAmount,
      deliveryFee,
      totalAmount,
      allocations: req.body?.allocations || null,
      status: "requires_action",
      orderId: null,
      authorizedAt: null,
      paidAt: null,
    });
    return res.status(201).json({ intent });
  }
);

router.post(
  "/payment-intents/:id/authorize",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const intent = await PaymentIntent.findByPk(req.params.id);
    if (!intent || String(intent.patientId || "") !== String(ctx.patientId || "")) {
      return res.status(404).json({ error: "Payment intent not found" });
    }
    if (PAYMENT_FINAL_STATUSES.has(String(intent.status || "").toLowerCase())) {
      return res.json({ intent, idempotent: true });
    }
    const nowIso = new Date().toISOString();
    const method = String(intent.method || "").toLowerCase();
    const totalAmount = toMoney(intent.totalAmount || 0);
    const balances = await getPatientWalletSummary(ctx.patientId);
    if (method === "nhf_credit") {
      if (balances.nhfCreditBalance < totalAmount) {
        return res.status(409).json({ error: "Insufficient NHF credit balance" });
      }
      await NhfCreditLedger.create({
        patientId: ctx.patientId,
        amount: toMoney(-totalAmount),
        currency: "JMD",
        type: "debit",
        reason: "refill_payment",
        paymentIntentId: intent.id,
      });
      intent.status = "paid";
      intent.paidAt = nowIso;
    } else if (method === "rx_card") {
      if (balances.walletBalance < totalAmount) {
        return res.status(409).json({ error: "Insufficient Refillit RX card balance" });
      }
      await WalletLedger.create({
        patientId: ctx.patientId,
        amount: toMoney(-totalAmount),
        currency: "JMD",
        type: "debit",
        reason: "refill_payment",
        paymentIntentId: intent.id,
      });
      intent.status = "paid";
      intent.paidAt = nowIso;
    } else if (method === "split") {
      const split = intent.allocations || {};
      const nhfPart = toMoney(split.nhfCredit || 0);
      const rxPart = toMoney(split.rxCard || 0);
      const cardPart = toMoney(split.card || 0);
      const allocated = toMoney(nhfPart + rxPart + cardPart);
      if (allocated < totalAmount) {
        return res.status(409).json({ error: "Split allocations must cover total amount" });
      }
      if (nhfPart > balances.nhfCreditBalance) {
        return res.status(409).json({ error: "Insufficient NHF credit for split allocation" });
      }
      if (rxPart > balances.walletBalance) {
        return res.status(409).json({ error: "Insufficient RX card balance for split allocation" });
      }
      if (nhfPart > 0) {
        await NhfCreditLedger.create({
          patientId: ctx.patientId,
          amount: toMoney(-nhfPart),
          currency: "JMD",
          type: "debit",
          reason: "refill_payment_split",
          paymentIntentId: intent.id,
        });
      }
      if (rxPart > 0) {
        await WalletLedger.create({
          patientId: ctx.patientId,
          amount: toMoney(-rxPart),
          currency: "JMD",
          type: "debit",
          reason: "refill_payment_split",
          paymentIntentId: intent.id,
        });
      }
      intent.status = cardPart > 0 ? "authorized" : "paid";
      intent.authorizedAt = nowIso;
      if (cardPart <= 0) intent.paidAt = nowIso;
    } else {
      intent.status = "authorized";
      intent.authorizedAt = nowIso;
    }
    await intent.save();
    return res.json({ intent });
  }
);

router.post(
  "/otc/payment-intents",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    await ensureDefaultOtcInventoryForDemo();
    const pharmacyId = String(req.body?.pharmacyId || "").trim();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!pharmacyId) return res.status(400).json({ error: "pharmacyId is required" });
    const method = String(req.body?.method || "card").trim().toLowerCase();
    if (!PAYMENT_METHODS.has(method)) {
      return res.status(400).json({ error: "method must be card, nhf_credit, rx_card, or split" });
    }
    const cart = await prepareOtcCart({ pharmacyId, items });
    if (!cart.ok) return res.status(cart.status).json({ error: cart.error });

    const deliveryFee = Math.max(0, toMoney(req.body?.deliveryFee || 600));
    const totalAmount = toMoney(cart.subtotal + deliveryFee);
    const intent = await PaymentIntent.create({
      patientId: req.user.id,
      paymentScope: "otc",
      pharmacyId,
      method,
      currency: "JMD",
      subtotal: cart.subtotal,
      deliveryFee,
      totalAmount,
      allocations: req.body?.allocations || null,
      otcItems: cart.normalizedItems.map((entry) => ({
        productId: entry.productId,
        qty: Number(entry.qty || 0),
      })),
      status: "requires_action",
      orderId: null,
      authorizedAt: null,
      paidAt: null,
    });
    return res.status(201).json({ intent });
  }
);

router.post(
  "/otc/payment-intents/:id/authorize",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const intent = await PaymentIntent.findByPk(req.params.id);
    if (!intent || String(intent.patientId || "") !== String(req.user.id || "")) {
      return res.status(404).json({ error: "Payment intent not found" });
    }
    if (String(intent.paymentScope || "").toLowerCase() !== "otc") {
      return res.status(409).json({ error: "Payment intent is not an OTC intent" });
    }
    if (PAYMENT_FINAL_STATUSES.has(String(intent.status || "").toLowerCase())) {
      return res.json({ intent, idempotent: true });
    }
    const nowIso = new Date().toISOString();
    const method = String(intent.method || "").toLowerCase();
    const totalAmount = toMoney(intent.totalAmount || 0);
    const balances = await getPatientWalletSummary(req.user.id);
    if (method === "nhf_credit") {
      if (balances.nhfCreditBalance < totalAmount) {
        return res.status(409).json({ error: "Insufficient NHF credit balance" });
      }
      await NhfCreditLedger.create({
        patientId: req.user.id,
        amount: toMoney(-totalAmount),
        currency: "JMD",
        type: "debit",
        reason: "otc_payment",
        paymentIntentId: intent.id,
      });
      intent.status = "paid";
      intent.paidAt = nowIso;
    } else if (method === "rx_card") {
      if (balances.walletBalance < totalAmount) {
        return res.status(409).json({ error: "Insufficient Refillit RX card balance" });
      }
      await WalletLedger.create({
        patientId: req.user.id,
        amount: toMoney(-totalAmount),
        currency: "JMD",
        type: "debit",
        reason: "otc_payment",
        paymentIntentId: intent.id,
      });
      intent.status = "paid";
      intent.paidAt = nowIso;
    } else if (method === "split") {
      const split = intent.allocations || {};
      const nhfPart = toMoney(split.nhfCredit || 0);
      const rxPart = toMoney(split.rxCard || 0);
      const cardPart = toMoney(split.card || 0);
      const allocated = toMoney(nhfPart + rxPart + cardPart);
      if (allocated < totalAmount) {
        return res.status(409).json({ error: "Split allocations must cover total amount" });
      }
      if (nhfPart > balances.nhfCreditBalance) {
        return res.status(409).json({ error: "Insufficient NHF credit for split allocation" });
      }
      if (rxPart > balances.walletBalance) {
        return res.status(409).json({ error: "Insufficient RX card balance for split allocation" });
      }
      if (nhfPart > 0) {
        await NhfCreditLedger.create({
          patientId: req.user.id,
          amount: toMoney(-nhfPart),
          currency: "JMD",
          type: "debit",
          reason: "otc_payment_split",
          paymentIntentId: intent.id,
        });
      }
      if (rxPart > 0) {
        await WalletLedger.create({
          patientId: req.user.id,
          amount: toMoney(-rxPart),
          currency: "JMD",
          type: "debit",
          reason: "otc_payment_split",
          paymentIntentId: intent.id,
        });
      }
      intent.status = cardPart > 0 ? "authorized" : "paid";
      intent.authorizedAt = nowIso;
      if (cardPart <= 0) intent.paidAt = nowIso;
    } else {
      intent.status = "authorized";
      intent.authorizedAt = nowIso;
    }
    await intent.save();
    return res.json({ intent });
  }
);

router.post(
  "/smart-refill-assistant/:id/request",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const prescription = await Prescription.findByPk(req.params.id);
    if (!prescription || prescription.patientId !== ctx.patientId) {
      return res.status(404).json({ error: "Prescription not found for patient" });
    }
    if (!prescription.doctorId) {
      return res.status(400).json({ error: "Prescription is missing doctor context for refill request" });
    }
    const paymentGate = await requireSettledPaymentIntent({
      patientId: ctx.patientId,
      prescId: prescription.id,
      paymentIntentId: req.body?.paymentIntentId,
    });
    if (!paymentGate.ok) return res.status(paymentGate.status).json({ error: paymentGate.error });
    const paymentIntent = paymentGate.intent;
    const allOrders = await Order.findAll({ where: { patientId: ctx.patientId, prescId: prescription.id } });
    const existingActiveOrder =
      allOrders.find((entry) =>
        ["submitted", "processing", "ready", "assigned"].includes(
          String(entry.orderStatus || "").toLowerCase()
        )
      ) || null;

    const existingPending = await RefillRequest.findOne({
      where: {
        patientId: ctx.patientId,
        doctorId: prescription.doctorId,
        prescId: prescription.id,
        status: "pending",
      },
    });
    const patientProfile = await PatientProfile.findOne({ where: { userId: ctx.patientId } });
    const fallbackAddress = String(decryptValue(patientProfile?.address) || "").trim();
    const addressSnapshot =
      normalizeDeliveryAddressInput(req.body?.deliveryAddress || req.body || {})
      || (fallbackAddress
        ? {
          addressLine: fallbackAddress,
          city: null,
          parish: null,
          postalCode: null,
          lat: null,
          lng: null,
          updatedAt: new Date().toISOString(),
        }
        : null);
    const pharmacyId =
      String(req.body?.pharmacyId || "").trim()
      || (await resolveDefaultPharmacyId());
    if (!pharmacyId) {
      return res.status(409).json({ error: "No pharmacy is configured for one-click refill routing" });
    }

    let order = existingActiveOrder;
    let orderCreated = false;
    if (!order) {
      order = await Order.create({
        patientId: ctx.patientId,
        prescId: prescription.id,
        pharmacyId,
        deliveryOption:
          String(req.body?.deliveryOption || "").trim().toLowerCase() === "delivery"
            ? "delivery"
            : "pickup",
        payment: req.body?.payment || null,
        paymentIntentId: paymentIntent.id,
        paymentStatus: String(paymentIntent.status || "").toLowerCase(),
        paymentMethod: paymentIntent.method || null,
        paymentCurrency: paymentIntent.currency || "JMD",
        paymentAmount: toMoney(paymentIntent.totalAmount || 0),
        deliveryAddressSnapshot: addressSnapshot,
        deliveryPreferences: {
          instructions: String(req.body?.instructions || "").trim() || null,
          recipientName: String(req.body?.recipientName || "").trim() || null,
          recipientPhone: String(req.body?.recipientPhone || "").trim() || null,
          allowProxyReceive: req.body?.allowProxyReceive === true,
          deliveryAddress: addressSnapshot,
          updatedAt: new Date().toISOString(),
          updatedBy: req.user.id,
        },
        orderStatus: "submitted",
        substitutionStatus: "none",
        prescriptionSnapshot: {
          doctorId: prescription.doctorId || null,
          doctorName: prescription.doctorName || null,
          meds: Array.isArray(prescription.meds) ? prescription.meds : [],
          diagnosis: prescription.diagnosis || null,
          allowedRefills: Number(prescription.allowedRefills || 0),
          expiryDate: prescription.expiryDate || null,
        },
      });
      orderCreated = true;
      await writeAudit({
        actorUserId: req.user.id,
        action: "patient.smart_refill.order_create",
        entityType: "order",
        entityId: order.id,
        metadata: {
          prescId: prescription.id,
          doctorId: prescription.doctorId,
          pharmacyId: order.pharmacyId || pharmacyId,
          paymentIntentId: paymentIntent.id,
          paymentStatus: paymentIntent.status || null,
        },
      });
    }
    if (paymentIntent && String(paymentIntent.orderId || "").trim() !== String(order.id || "").trim()) {
      paymentIntent.orderId = order.id;
      await paymentIntent.save();
    }

    let request = existingPending;
    if (!request) {
      request = await RefillRequest.create({
        patientId: ctx.patientId,
        doctorId: prescription.doctorId,
        prescId: prescription.id,
        reason: String(req.body?.reason || "").trim() || "One-click smart refill request",
        status: "pending",
      });
    }

    return res.status(orderCreated || !existingPending ? 201 : 200).json({
      request,
      order,
      existed: Boolean(existingPending),
      orderCreated,
    });
  }
);

router.post("/scan-prescription", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const qrContent = req.body?.qrContent;
  const decoded = parsePrescriptionQr(qrContent);
  if (!decoded) {
    return res.status(400).json({ error: "Invalid QR content" });
  }

  const prescription = await Prescription.findByPk(decoded.prescId);
  if (!prescription) {
    return res.status(404).json({ error: "Prescription not found" });
  }

  if (prescription.patientId && prescription.patientId !== req.user.id) {
    return res.status(403).json({ error: "Prescription is assigned to another patient" });
  }

  return res.json({
    decodedQr: decoded,
    prescription: {
      id: prescription.id,
      patientId: prescription.patientId || null,
      patientFullName: prescription.patientFullName || null,
      meds: prescription.meds || [],
      allowedRefills: Number(prescription.allowedRefills || 0),
      expiryDate: prescription.expiryDate || null,
      linkCode: prescription.linkCode || null,
      linked: Boolean(prescription.linked),
      doctorId: prescription.doctorId || null,
      doctorName: prescription.doctorName || decoded.doctorName || null,
      createdAt: prescription.createdAt,
    },
  });
});

router.get("/orders", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

  const deliveryOnly = String(req.query.deliveryOnly || "").trim().toLowerCase() === "true";
  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 80) || 80));
  const orders = await Order.findAll({ where: { patientId: ctx.patientId } });
  const rows = [];

  for (const order of orders) {
    if (deliveryOnly && !isDeliveryOrderLike(order)) continue;
    if (statusFilter && String(order.orderStatus || "").toLowerCase() !== statusFilter) continue;
    // eslint-disable-next-line no-await-in-loop
    const pharmacy = order.pharmacyId ? await User.findByPk(order.pharmacyId) : null;
    // eslint-disable-next-line no-await-in-loop
    const courier = order.courierId ? await User.findByPk(order.courierId) : null;
    const baseOrder = typeof order?.toJSON === "function" ? order.toJSON() : order;
    rows.push({
      ...baseOrder,
      dispatchStatus: normalizeDispatchStatus(order),
      pharmacyName: pharmacy?.fullName || null,
      courierName: courier?.fullName || null,
      dispatchEtaStart: order.dispatchEtaStart || null,
      dispatchEtaEnd: order.dispatchEtaEnd || null,
      dispatchPriority: order.dispatchPriority || "normal",
      dispatchFailureReason: order.dispatchFailureReason || order.failureReason || null,
      destinationAddress: resolveOrderDestinationText(order),
      deliveryInstructions: String(order?.deliveryPreferences?.instructions || "").trim() || null,
    });
  }

  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ orders: rows.slice(0, limit) });
});

router.get("/pharmacies", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

  const query = String(req.query.q || "").trim().toLowerCase();
  const parishFilter = String(req.query.parish || "").trim().toLowerCase();
  const profiles = await PharmacyProfile.findAll({});
  const users = await User.findAll({ where: { role: "pharmacy" } });
  const userById = new Map(users.map((entry) => [String(entry.id), entry]));

  const rows = profiles
    .map((profile) => {
      const user = userById.get(String(profile.userId || "")) || null;
      const parish = resolvePharmacyParish(profile);
      const city = String(profile.city || "").trim() || null;
      const address = String(profile.address || "").trim() || null;
      const registeredName = String(profile.registeredName || user?.fullName || "").trim() || null;
      if (!registeredName) return null;
      return {
        id: String(profile.id || profile.userId || ""),
        userId: String(profile.userId || "") || null,
        name: registeredName,
        parish,
        city,
        address,
        pharmacistInCharge: String(profile.pharmacistInCharge || "").trim() || null,
        councilReg: String(profile.councilReg || "").trim() || null,
        phone: String(user?.phone || "").trim() || null,
        email: String(user?.email || "").trim() || null,
      };
    })
    .filter(Boolean)
    .filter((entry) => {
      if (parishFilter && String(entry.parish || "").toLowerCase() !== parishFilter) return false;
      if (!query) return true;
      return [entry.name, entry.parish, entry.city, entry.address, entry.pharmacistInCharge]
        .map((value) => String(value || "").toLowerCase())
        .some((value) => value.includes(query));
    })
    .sort((a, b) => {
      const parishCompare = String(a.parish || "").localeCompare(String(b.parish || ""));
      if (parishCompare !== 0) return parishCompare;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

  const parishes = Array.from(new Set(rows.map((entry) => String(entry.parish || "").trim()).filter(Boolean))).sort();
  return res.json({ pharmacies: rows, parishes });
});

router.get("/orders/:id/tracking", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

  const order = await Order.findByPk(req.params.id);
  if (!order || String(order.patientId || "") !== String(ctx.patientId || "")) {
    return res.status(404).json({ error: "Order not found" });
  }

  const courier = order.courierId ? await User.findByPk(order.courierId) : null;
  const pharmacy = order.pharmacyId ? await User.findByPk(order.pharmacyId) : null;
  const baseOrder = typeof order?.toJSON === "function" ? order.toJSON() : order;
  const timeline = buildPatientOrderTimeline(order);

  return res.json({
    order: {
      ...baseOrder,
      dispatchStatus: normalizeDispatchStatus(order),
      pharmacyName: pharmacy?.fullName || null,
      courier: courier
        ? {
            id: courier.id,
            fullName: courier.fullName || null,
          }
        : null,
      dispatchEtaStart: order.dispatchEtaStart || null,
      dispatchEtaEnd: order.dispatchEtaEnd || null,
      dispatchFailureReason: order.dispatchFailureReason || order.failureReason || null,
      otpState: buildPatientOtpState(order),
      deliveryPreferences: order.deliveryPreferences || null,
      deliveryConfirmation: order.deliveryConfirmation || null,
    },
    timeline,
  });
});

router.post(
  "/orders/:id/delivery-preferences",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

    const order = await Order.findByPk(req.params.id);
    if (!order || String(order.patientId || "") !== String(ctx.patientId || "")) {
      return res.status(404).json({ error: "Order not found" });
    }
    const body = req.body || {};
    const addressSnapshot = normalizeDeliveryAddressInput(body.deliveryAddress || body);
    order.deliveryPreferences = {
      instructions: String(body.instructions || "").trim() || null,
      recipientName: String(body.recipientName || "").trim() || null,
      recipientPhone: String(body.recipientPhone || "").trim() || null,
      allowProxyReceive: body.allowProxyReceive === true,
      deliveryAddress: addressSnapshot || order.deliveryPreferences?.deliveryAddress || null,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id,
    };
    if (addressSnapshot) {
      order.deliveryAddressSnapshot = {
        ...(order.deliveryAddressSnapshot || {}),
        ...addressSnapshot,
      };
    }
    await order.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "patient.order.delivery_preferences",
      entityType: "order",
      entityId: order.id,
    });
    return res.json({ order });
  }
);

router.post(
  "/orders/:id/confirm-delivery",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

    const order = await Order.findByPk(req.params.id);
    if (!order || String(order.patientId || "") !== String(ctx.patientId || "")) {
      return res.status(404).json({ error: "Order not found" });
    }
    const confirmed = req.body?.confirmed !== false;
    order.deliveryConfirmation = {
      confirmed,
      note: String(req.body?.note || "").trim() || null,
      confirmedAt: new Date().toISOString(),
      confirmedBy: req.user.id,
    };
    await order.save();
    await writeAudit({
      actorUserId: req.user.id,
      action: "patient.order.confirm_delivery",
      entityType: "order",
      entityId: order.id,
      metadata: { confirmed },
    });
    return res.json({ order });
  }
);

router.get("/otc/catalog", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  await ensureDefaultOtcInventoryForDemo();
  const q = String(req.query?.q || "").trim().toLowerCase();
  const category = String(req.query?.category || "").trim().toLowerCase();
  const pharmacyId = String(req.query?.pharmacyId || "").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 60)));

  const scopeIds = pharmacyId ? await resolvePharmacyInventoryScope(pharmacyId) : null;
  const allInventory = await PharmacyOtcInventory.findAll({});
  const listedInventory = allInventory.filter((entry) => {
    if (entry.isListed === false) return false;
    if (Number(entry.onHand || 0) <= 0) return false;
    if (scopeIds && !scopeIds.has(String(entry.pharmacyId || ""))) return false;
    return true;
  });
  const products = await OtcProduct.findAll({});
  const productsById = new Map(products.map((entry) => [String(entry.id), entry]));
  const pharmacyProfiles = await PharmacyProfile.findAll({});
  const profileById = new Map(pharmacyProfiles.map((entry) => [String(entry.id), entry]));
  const userIds = Array.from(
    new Set(
      listedInventory.map((entry) => {
        const profile = profileById.get(String(entry.pharmacyId || ""));
        return String(profile?.userId || entry.pharmacyId || "");
      }).filter(Boolean)
    )
  );
  const pharmacyUserById = new Map();
  for (const id of userIds) {
    // eslint-disable-next-line no-await-in-loop
    const user = await User.findByPk(id);
    if (user) pharmacyUserById.set(String(user.id), user);
  }

  const rows = listedInventory.map((entry) => {
    const product = productsById.get(String(entry.productId || ""));
    if (!product || product.isActive === false) return null;
    const profile = profileById.get(String(entry.pharmacyId || "")) || null;
    const pharmacyUser = pharmacyUserById.get(String(profile?.userId || entry.pharmacyId || "")) || null;
    return {
      inventoryId: entry.id,
      pharmacyId: entry.pharmacyId,
      pharmacyName: profile?.registeredName || pharmacyUser?.fullName || null,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category || "general",
      dosageForm: product.dosageForm || null,
      strength: product.strength || null,
      activeIngredient: product.activeIngredient || null,
      unitPrice: toMoney(entry.unitPrice || 0),
      onHand: Number(entry.onHand || 0),
      maxPerOrder: Number(entry.maxPerOrder || product.maxQtyPerOrder || 1),
      requiresAgeCheck: Boolean(product.requiresAgeCheck),
    };
  }).filter(Boolean);

  const filtered = rows.filter((entry) => {
    if (category && String(entry.category || "").toLowerCase() !== category) return false;
    if (!q) return true;
    return [entry.name, entry.sku, entry.activeIngredient, entry.category]
      .map((value) => String(value || "").toLowerCase())
      .some((value) => value.includes(q));
  });

  return res.json({
    items: filtered.slice(0, limit),
    meta: {
      total: filtered.length,
      pharmacyFilter: pharmacyId || null,
      generatedAt: new Date().toISOString(),
    },
  });
});

router.post("/otc/preflight", requireAuth, requireRoles(["patient"]), async (req, res) => {
  await ensureDefaultOtcInventoryForDemo();
  const pharmacyId = String(req.body?.pharmacyId || "").trim();
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!pharmacyId) return res.status(400).json({ error: "pharmacyId is required" });
  if (!items.length) return res.status(400).json({ error: "items are required" });

  const cart = await prepareOtcCart({ pharmacyId, items });
  if (!cart.ok) {
    return res.status(cart.status).json({
      error: cart.error,
      state: "blocked",
      blockers: [cart.error],
      warnings: [],
    });
  }
  const patientProfile = await PatientProfile.findOne({ where: { userId: req.user.id } });
  const safety = assessOtcSafety({ patientProfile, normalizedItems: cart.normalizedItems });
  const state = safety.blockers.length ? "blocked" : safety.warnings.length ? "warning" : "ready";
  return res.json({
    state,
    blockers: safety.blockers,
    warnings: safety.warnings,
    totals: {
      subtotal: cart.subtotal,
      itemCount: cart.normalizedItems.reduce((sum, entry) => sum + Number(entry.qty || 0), 0),
    },
  });
});

router.post("/otc/orders", requireAuth, requireRoles(["patient"]), async (req, res) => {
  await ensureDefaultOtcInventoryForDemo();
  const body = req.body || {};
  const pharmacyId = String(body.pharmacyId || "").trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!pharmacyId) return res.status(400).json({ error: "pharmacyId is required" });
  const cart = await prepareOtcCart({ pharmacyId, items });
  if (!cart.ok) return res.status(cart.status).json({ error: cart.error });
  const normalizedItems = cart.normalizedItems;
  const subtotal = cart.subtotal;

  const paymentGate = await requireSettledOtcPaymentIntent({
    patientId: req.user.id,
    paymentIntentId: body.paymentIntentId,
  });
  if (!paymentGate.ok) return res.status(paymentGate.status).json({ error: paymentGate.error });
  const paymentIntent = paymentGate.intent;
  if (String(paymentIntent.pharmacyId || "") !== pharmacyId) {
    return res.status(409).json({ error: "Payment intent pharmacy does not match order pharmacy" });
  }
  const intentItems = Array.isArray(paymentIntent.otcItems)
    ? paymentIntent.otcItems.map((entry) => ({
      productId: String(entry?.productId || ""),
      qty: Number(entry?.qty || 0),
    }))
    : [];
  const orderItems = normalizedItems.map((entry) => ({
    productId: String(entry.productId || ""),
    qty: Number(entry.qty || 0),
  }));
  if (JSON.stringify(intentItems) !== JSON.stringify(orderItems)) {
    return res.status(409).json({ error: "Payment intent items do not match OTC order items" });
  }
  const expectedDeliveryFee = Math.max(0, toMoney(paymentIntent.deliveryFee || 0));
  const expectedTotal = toMoney(subtotal + expectedDeliveryFee);
  if (toMoney(paymentIntent.totalAmount || 0) !== expectedTotal) {
    return res.status(409).json({ error: "Payment intent total does not match OTC cart total" });
  }

  const deliveryFee = expectedDeliveryFee;
  const totalAmount = toMoney(subtotal + deliveryFee);
  const patientProfile = await PatientProfile.findOne({ where: { userId: req.user.id } });
  const safety = assessOtcSafety({ patientProfile, normalizedItems });
  if (safety.blockers.length) {
    return res.status(409).json({
      error: "OTC safety checks failed",
      blockers: safety.blockers,
      warnings: safety.warnings,
    });
  }
  if (safety.warnings.length && body.acknowledgeInteractionWarnings !== true) {
    return res.status(409).json({
      error: "OTC interaction warnings require acknowledgement before checkout",
      warnings: safety.warnings,
    });
  }
  const fallbackAddress = String(decryptValue(patientProfile?.address) || "").trim();
  const addressSnapshot =
    normalizeDeliveryAddressInput(body.deliveryAddress || body)
    || (fallbackAddress
      ? {
        addressLine: fallbackAddress,
        city: null,
        parish: null,
        postalCode: null,
        lat: null,
        lng: null,
        updatedAt: new Date().toISOString(),
      }
      : null);

  const order = await Order.create({
    patientId: req.user.id,
    pharmacyId,
    orderType: "otc",
    orderStatus: "submitted",
    paymentIntentId: paymentIntent.id,
    paymentStatus: String(paymentIntent.status || "").toLowerCase(),
    paymentMethod: paymentIntent.method || null,
    paymentCurrency: paymentIntent.currency || "JMD",
    paymentAmount: toMoney(paymentIntent.totalAmount || totalAmount),
    deliveryOption: String(body.deliveryOption || "delivery").trim().toLowerCase() === "pickup" ? "pickup" : "delivery",
    payment: {
      method: String(paymentIntent.method || body?.payment?.method || "cash").trim().toLowerCase() || "cash",
      currency: paymentIntent.currency || "JMD",
      subtotal,
      deliveryFee,
      totalAmount,
      status: String(paymentIntent.status || body?.payment?.status || "pending").trim().toLowerCase() || "pending",
    },
    otcSummary: {
      subtotal,
      deliveryFee,
      totalAmount,
      itemCount: normalizedItems.reduce((sum, entry) => sum + Number(entry.qty || 0), 0),
    },
    otcSafety: {
      warnings: safety.warnings,
      blockers: [],
      acknowledgedWarnings: safety.warnings.length ? true : null,
      checkedAt: new Date().toISOString(),
    },
    deliveryAddressSnapshot: addressSnapshot,
    deliveryPreferences: {
      instructions: String(body.instructions || "").trim() || null,
      recipientName: String(body.recipientName || "").trim() || null,
      recipientPhone: String(body.recipientPhone || "").trim() || null,
      allowProxyReceive: body.allowProxyReceive === true,
      deliveryAddress: addressSnapshot,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id,
    },
    substitutionStatus: "none",
  });

  for (const item of normalizedItems) {
    // eslint-disable-next-line no-await-in-loop
    await OtcOrderItem.create({
      orderId: order.id,
      productId: item.productId,
      sku: item.sku,
      productName: item.productName,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      metadata: { inventoryId: item.inventoryId, pharmacyId: item.pharmacyId },
    });
  }

  await writeAudit({
    actorUserId: req.user.id,
    action: "patient.otc_order.create",
    entityType: "order",
    entityId: order.id,
    metadata: {
      orderType: "otc",
      pharmacyId,
      totalAmount,
      itemCount: normalizedItems.length,
      safetyWarnings: safety.warnings.length,
    },
  });
  if (String(paymentIntent.orderId || "").trim() !== String(order.id || "").trim()) {
    paymentIntent.orderId = order.id;
    await paymentIntent.save();
  }

  return res.status(201).json({
    order,
    items: normalizedItems,
    totals: { subtotal, deliveryFee, totalAmount },
    warnings: safety.warnings,
  });
});

router.post("/orders", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const body = req.body || {};
  const prescription = await Prescription.findByPk(body.prescId);
  if (!prescription || prescription.patientId !== req.user.id) {
    return res.status(400).json({ error: "Prescription unavailable to patient" });
  }
  const paymentGate = await requireSettledPaymentIntent({
    patientId: req.user.id,
    prescId: prescription.id,
    paymentIntentId: body.paymentIntentId,
  });
  if (!paymentGate.ok) return res.status(paymentGate.status).json({ error: paymentGate.error });
  const paymentIntent = paymentGate.intent;
  const patientProfile = await PatientProfile.findOne({ where: { userId: req.user.id } });
  const fallbackAddress = String(decryptValue(patientProfile?.address) || "").trim();
  const addressSnapshot =
    normalizeDeliveryAddressInput(body.deliveryAddress || body)
    || (fallbackAddress
      ? {
        addressLine: fallbackAddress,
        city: null,
        parish: null,
        postalCode: null,
        lat: null,
        lng: null,
        updatedAt: new Date().toISOString(),
      }
      : null);
  const order = await Order.create({
    patientId: req.user.id,
    prescId: body.prescId,
    pharmacyId: body.pharmacyId,
    deliveryOption: body.deliveryOption || "pickup",
    payment: body.payment || null,
    paymentIntentId: paymentIntent.id,
    paymentStatus: String(paymentIntent.status || "").toLowerCase(),
    paymentMethod: paymentIntent.method || null,
    paymentCurrency: paymentIntent.currency || "JMD",
    paymentAmount: toMoney(paymentIntent.totalAmount || 0),
    prescriptionSnapshot: {
      id: prescription.id,
      doctorId: prescription.doctorId || null,
      doctorName: prescription.doctorName || null,
      patientId: prescription.patientId || null,
      patientFullName: prescription.patientFullName || null,
      meds: Array.isArray(prescription.meds) ? prescription.meds : [],
      allowedRefills: Number(prescription.allowedRefills || 0),
      expiryDate: prescription.expiryDate || null,
    },
    deliveryAddressSnapshot: addressSnapshot,
    deliveryPreferences: {
      instructions: String(body.instructions || "").trim() || null,
      recipientName: String(body.recipientName || "").trim() || null,
      recipientPhone: String(body.recipientPhone || "").trim() || null,
      allowProxyReceive: body.allowProxyReceive === true,
      deliveryAddress: addressSnapshot,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id,
    },
    orderStatus: "submitted",
    substitutionStatus: "none",
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "patient.order.create",
    entityType: "order",
    entityId: order.id,
    metadata: {
      prescId: prescription.id,
      doctorId: prescription.doctorId || null,
      pharmacyId: body.pharmacyId || null,
      paymentIntentId: paymentIntent.id,
    },
  });
  if (String(paymentIntent.orderId || "").trim() !== String(order.id || "").trim()) {
    paymentIntent.orderId = order.id;
    await paymentIntent.save();
  }
  return res.status(201).json({ order });
});

router.get(
  "/appointments/doctors/:doctorId/availability",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const slots = await AppointmentAvailability.findAll({
      where: { doctorId: req.params.doctorId },
    });
    const availability = [];
    for (const slot of slots.filter((entry) => entry.isActive !== false)) {
      // eslint-disable-next-line no-await-in-loop
      const booked = await Appointment.count({
        where: { availabilityId: slot.id },
      });
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
    res.json({ availability });
  }
);

router.post("/appointments/bookings", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const body = req.body || {};
  if (!body.availabilityId || !body.doctorId) {
    return res.status(400).json({ error: "availabilityId and doctorId are required" });
  }
  const slot = await AppointmentAvailability.findByPk(body.availabilityId);
  if (!slot || slot.doctorId !== body.doctorId || slot.isActive === false) {
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
    patientId: ctx.patientId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    mode: slot.mode || "in-person",
    location: slot.location || null,
    reason: body.reason || null,
    triageTags: triageTagsFromReason(body.reason),
    source: "patient_booking",
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
  return res.status(201).json({ booking });
});

router.post("/appointments/waitlist", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const body = req.body || {};
  if (!body.doctorId) {
    return res.status(400).json({ error: "doctorId is required" });
  }
  const doctor = await User.findByPk(body.doctorId);
  if (!doctor || doctor.role !== "doctor") {
    return res.status(400).json({ error: "Invalid doctorId" });
  }
  const waitlist = await AppointmentWaitlist.create({
    doctorId: body.doctorId,
    patientId: ctx.patientId,
    preferredDate: body.preferredDate || null,
    reason: body.reason || null,
    triageTags: triageTagsFromReason(body.reason),
    status: "waiting",
  });
  return res.status(201).json({ waitlist });
});

router.get("/appointments/waitlist", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const entries = await AppointmentWaitlist.findAll({ where: { patientId: ctx.patientId } });
  const waitlist = entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ waitlist });
});

router.get("/instructions", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const broadcasts = await CareInstructionBroadcast.findAll({ where: { patientId: req.user.id } });
  broadcasts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ broadcasts });
});

router.post("/instructions/:id/read", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const broadcast = await CareInstructionBroadcast.findByPk(req.params.id);
  if (!broadcast || broadcast.patientId !== req.user.id) {
    return res.status(404).json({ error: "Instruction not found" });
  }
  if (!broadcast.readAt) {
    broadcast.readAt = new Date().toISOString();
    await broadcast.save();
  }
  return res.json({ broadcast });
});

router.post("/refill-requests", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canRequestRefills" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const body = req.body || {};
  if (!body.prescId || !body.doctorId) {
    return res.status(400).json({ error: "prescId and doctorId are required" });
  }
  const prescription = await Prescription.findByPk(body.prescId);
  if (!prescription || prescription.patientId !== ctx.patientId || prescription.doctorId !== body.doctorId) {
    return res.status(400).json({ error: "Invalid prescription for refill request" });
  }
  const request = await RefillRequest.create({
    patientId: ctx.patientId,
    doctorId: body.doctorId,
    prescId: body.prescId,
    reason: body.reason || null,
    status: "pending",
  });
  return res.status(201).json({ request });
});

router.get("/appointments/bookings", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const appointments = await Appointment.findAll({ where: { patientId: ctx.patientId } });
  const bookings = [];
  for (const entry of appointments.sort((a, b) => new Date(a.startAt) - new Date(b.startAt))) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(entry.doctorId);
    bookings.push({
      ...(typeof entry?.toJSON === "function" ? entry.toJSON() : entry),
      doctorName: doctor?.fullName || null,
    });
  }
  res.json({ bookings });
});

router.post(
  "/orders/:id/substitution",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const order = await Order.findByPk(req.params.id);
    if (!order || order.patientId !== req.user.id) {
      return res.status(404).json({ error: "Order not found" });
    }
    const decision = (req.body || {}).decision;
    if (!["accepted", "rejected"].includes(decision)) {
      return res.status(400).json({ error: "decision must be accepted or rejected" });
    }
    order.substitutionStatus = decision;
    await order.save();
    return res.json({ order });
  }
);

router.get("/doctors", requireAuth, requireRoles(PATIENT_CARE_CONTEXT_ROLES), async (req, res) => {
  const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const profiles = await DoctorProfile.findAll({ where: { mohVerified: true } });
  const doctorById = new Map();
  const connections = await DoctorConnection.findAll({
    where: { patientId: ctx.patientId },
  });
  const connectionByDoctorId = new Map(
    connections.map((entry) => [String(entry.doctorId), String(entry.status || "pending").toLowerCase()])
  );

  for (const profile of profiles) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(profile.userId);
    if (doctor) {
      doctorById.set(String(doctor.id), {
        id: doctor.id,
        fullName: doctor.fullName,
        licenseNumber: profile.licenseNumber || null,
        mohVerified: true,
        connectionStatus: connectionByDoctorId.get(String(doctor.id)) || "none",
      });
    }
  }

  for (const connection of connections) {
    const doctorId = String(connection.doctorId || "");
    if (!doctorId || doctorById.has(doctorId)) continue;
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor && doctor.role === "doctor") {
      doctorById.set(doctorId, {
        id: doctor.id,
        fullName: doctor.fullName,
        licenseNumber: null,
        mohVerified: false,
        connectionStatus: String(connection.status || "pending").toLowerCase(),
      });
    }
  }

  const doctors = Array.from(doctorById.values()).sort((a, b) =>
    String(a.fullName || "").localeCompare(String(b.fullName || ""))
  );
  res.json({ doctors });
});

router.post(
  "/doctor-requests",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const doctorId = (req.body || {}).doctorId;
    const doctor = await User.findByPk(doctorId);
    if (!doctor || doctor.role !== "doctor") {
      return res.status(400).json({ error: "Invalid doctorId" });
    }
    let connection = await DoctorConnection.findOne({
      where: { doctorId, patientId: req.user.id },
    });
    if (!connection) {
      connection = await DoctorConnection.create({
        doctorId,
        patientId: req.user.id,
        status: "pending",
      });
    }
    return res.status(201).json({ connection });
  }
);

router.get("/medication-reminders", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const reminders = await PatientMedicationReminder.findAll({ where: { patientId: req.user.id } });
  reminders.sort((a, b) => new Date(a.timeOfDay || 0) - new Date(b.timeOfDay || 0));
  return res.json({ reminders });
});

router.post("/medication-reminders", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  const reminder = await PatientMedicationReminder.create({
    patientId: req.user.id,
    title,
    note: String(req.body?.note || "").trim() || null,
    dosage: String(req.body?.dosage || "").trim() || null,
    timeOfDay: String(req.body?.timeOfDay || "").trim() || null,
    active: req.body?.active !== false,
    lastAction: null,
    lastActionAt: null,
  });
  await writeAudit({
    actorUserId: req.user.id,
    action: "patient.medication_reminder.create",
    entityType: "patient_medication_reminder",
    entityId: reminder.id,
  });
  return res.status(201).json({ reminder });
});

router.post(
  "/medication-reminders/:id/toggle",
  requireAuth,
  requireRoles(["patient"]),
  async (req, res) => {
    const reminder = await PatientMedicationReminder.findByPk(req.params.id);
    if (!reminder || reminder.patientId !== req.user.id) {
      return res.status(404).json({ error: "Reminder not found" });
    }
    const action = String(req.body?.action || "").toLowerCase();
    if (!["taken", "skipped", "active", "inactive"].includes(action)) {
      return res.status(400).json({ error: "action must be taken, skipped, active, or inactive" });
    }
    if (action === "active") reminder.active = true;
    if (action === "inactive") reminder.active = false;
    reminder.lastAction = action === "active" || action === "inactive" ? null : action;
    reminder.lastActionAt = new Date().toISOString();
    await reminder.save();
    return res.json({ reminder });
  }
);

router.get("/visit-prep", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const items = await PatientVisitPrepItem.findAll({ where: { patientId: req.user.id } });
  const doctorIds = Array.from(
    new Set(items.map((entry) => String(entry.sharedDoctorId || "").trim()).filter(Boolean))
  );
  const doctorById = new Map();
  for (const doctorId of doctorIds) {
    // eslint-disable-next-line no-await-in-loop
    const doctor = await User.findByPk(doctorId);
    if (doctor && doctor.role === "doctor") doctorById.set(doctorId, doctor);
  }
  const enriched = items.map((entry) => ({
    ...entry,
    sharedDoctorName: entry.sharedDoctorId ? doctorById.get(String(entry.sharedDoctorId))?.fullName || null : null,
  }));
  enriched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.json({ items: enriched });
});

router.post("/visit-prep", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const category = String(req.body?.category || "question").trim().toLowerCase();
  const symptomName = String(req.body?.symptomName || "").trim();
  const symptomExplanation = String(req.body?.symptomExplanation || "").trim();
  const textRaw = String(req.body?.text || "").trim();
  if (category === "symptom" && !symptomName) {
    return res.status(400).json({ error: "symptomName is required for symptom entries" });
  }
  const text = textRaw || symptomName;
  if (!text) return res.status(400).json({ error: "text is required" });
  const occurredAt =
    toIsoFromDateAndTime(req.body?.occurredDate, req.body?.occurredTime)
    || (toIsoFromDateAndTime(req.body?.occurredAt, "") || null);
  const severityRaw = String(req.body?.symptomSeverity || "").trim().toLowerCase();
  const symptomSeverity = ["mild", "moderate", "severe", "urgent"].includes(severityRaw)
    ? severityRaw
    : null;
  const item = await PatientVisitPrepItem.create({
    patientId: req.user.id,
    text,
    category,
    visitDate: toDateKey(req.body?.visitDate || occurredAt || "") || null,
    symptomName: symptomName || null,
    symptomExplanation: symptomExplanation || null,
    symptomSeverity,
    occurredAt,
    sharedWithDoctor: false,
    sharedDoctorId: null,
    sharedAt: null,
    sharedForVirtualDiagnosis: false,
    reviewedByDoctorAt: null,
    reviewedByDoctorId: null,
    doctorReviewNote: null,
    completed: false,
  });
  return res.status(201).json({ item });
});

router.post("/visit-prep/:id/toggle", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const item = await PatientVisitPrepItem.findByPk(req.params.id);
  if (!item || item.patientId !== req.user.id) return res.status(404).json({ error: "Prep item not found" });
  item.completed = !Boolean(item.completed);
  await item.save();
  return res.json({ item });
});

router.post("/visit-prep/:id/share-to-doctor", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const item = await PatientVisitPrepItem.findByPk(req.params.id);
  if (!item || item.patientId !== req.user.id) {
    return res.status(404).json({ error: "Prep item not found" });
  }
  const doctorId = String(req.body?.doctorId || "").trim();
  if (!doctorId) return res.status(400).json({ error: "doctorId is required" });
  const doctor = await User.findByPk(doctorId);
  if (!doctor || doctor.role !== "doctor") {
    return res.status(400).json({ error: "Invalid doctorId" });
  }
  const connection = await DoctorConnection.findOne({
    where: { doctorId, patientId: req.user.id, status: "approved" },
  });
  if (!connection) {
    return res.status(403).json({ error: "Doctor connection must be approved before sharing prep reports" });
  }

  item.sharedWithDoctor = true;
  item.sharedDoctorId = doctorId;
  item.sharedAt = new Date().toISOString();
  item.sharedForVirtualDiagnosis = req.body?.virtualReview !== false;
  item.sharedNote = String(req.body?.note || "").trim() || null;
  await item.save();

  let thread = await ChatThread.findOne({
    where: { doctorId, patientId: req.user.id },
  });
  if (!thread) {
    thread = await ChatThread.create({ doctorId, patientId: req.user.id });
  }
  const summaryBits = [
    `Symptom report shared by patient: ${item.symptomName || item.text}`,
    item.occurredAt ? `Occurred: ${new Date(item.occurredAt).toLocaleString()}` : null,
    item.symptomSeverity ? `Severity: ${item.symptomSeverity}` : null,
    item.symptomExplanation ? `Details: ${item.symptomExplanation}` : null,
    item.sharedForVirtualDiagnosis ? "Requested for virtual diagnosis review." : "For next visit review.",
  ].filter(Boolean);
  await ChatMessage.create({
    threadId: thread.id,
    senderId: req.user.id,
    message: summaryBits.join(" | "),
  });

  await writeAudit({
    actorUserId: req.user.id,
    action: "patient.visit_prep.share_to_doctor",
    entityType: "patient_visit_prep_item",
    entityId: item.id,
    metadata: {
      doctorId,
      sharedForVirtualDiagnosis: Boolean(item.sharedForVirtualDiagnosis),
    },
  });

  return res.json({
    item: {
      ...item,
      sharedDoctorName: doctor.fullName || null,
    },
  });
});

router.get("/care-tasks", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const tasks = await PatientCareTask.findAll({ where: { patientId: req.user.id } });
  tasks.sort((a, b) => new Date(a.dueDate || 0) - new Date(b.dueDate || 0));
  return res.json({ tasks });
});

router.post("/care-tasks", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const task = await PatientCareTask.create({
    patientId: req.user.id,
    text,
    dueDate: toDateKey(req.body?.dueDate || "") || null,
    source: String(req.body?.source || "patient").trim().toLowerCase(),
    completed: false,
    completedAt: null,
  });
  return res.status(201).json({ task });
});

router.post("/care-tasks/:id/toggle", requireAuth, requireRoles(["patient"]), async (req, res) => {
  const task = await PatientCareTask.findByPk(req.params.id);
  if (!task || task.patientId !== req.user.id) return res.status(404).json({ error: "Care task not found" });
  task.completed = !Boolean(task.completed);
  task.completedAt = task.completed ? new Date().toISOString() : null;
  await task.save();
  return res.json({ task });
});

router.get(
  "/installment-proposals",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
    const proposals = await InstallmentProposal.findAll({ where: { patientId: ctx.patientId } });
    proposals.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.json({ proposals });
  }
);

router.post(
  "/installment-proposals",
  requireAuth,
  requireRoles(PATIENT_CARE_CONTEXT_ROLES),
  async (req, res) => {
    const ctx = await resolvePatientAccessContext(req, { scopeKey: "canBookAppointments" });
    if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });

    const appointmentId = String(req.body?.appointmentId || "").trim();
    if (!appointmentId) return res.status(400).json({ error: "appointmentId is required" });
    const appointment = await Appointment.findByPk(appointmentId);
    if (!appointment || String(appointment.patientId) !== String(ctx.patientId)) {
      return res.status(404).json({ error: "Appointment not found for patient" });
    }

    const feeAmount = toMoney(appointment.feeAmount || 0);
    const nhfDeduction = toMoney(appointment.nhfDeductionAmount || 0);
    const paid = toMoney(appointment.paymentCollectedAmount || 0);
    const balance = Math.max(0, toMoney(feeAmount - nhfDeduction - paid));
    if (balance <= 0) {
      return res.status(400).json({ error: "No open balance available for installment proposal" });
    }

    const installments = Math.max(2, Number(req.body?.installments || 2));
    if (!Number.isFinite(installments) || installments > 24) {
      return res.status(400).json({ error: "installments must be between 2 and 24" });
    }
    const startDate = toDateKey(req.body?.startDate || "");
    if (!startDate) {
      return res.status(400).json({ error: "startDate is required in YYYY-MM-DD format" });
    }

    const amountEach = toMoney(balance / installments);
    const proposal = await InstallmentProposal.create({
      appointmentId: appointment.id,
      patientId: ctx.patientId,
      doctorId: appointment.doctorId,
      proposedByUserId: req.user.id,
      proposedByRole: req.user.role,
      installments,
      amountEach,
      totalAmount: balance,
      currency: normalizeFeeCurrency(appointment.feeCurrency),
      startDate,
      status: "pending",
      reviewNote: null,
      reviewedByUserId: null,
      reviewedByRole: null,
      reviewedAt: null,
      metadata: {
        source: ctx.isProxy ? "caregiver" : "patient",
      },
    });

    await writeAudit({
      actorUserId: req.user.id,
      action: "patient.installment_proposal.create",
      entityType: "installment_proposal",
      entityId: proposal.id,
      metadata: {
        appointmentId: appointment.id,
        patientId: ctx.patientId,
        doctorId: appointment.doctorId,
        installments,
      },
    });

    return res.status(201).json({ proposal });
  }
);

module.exports = router;

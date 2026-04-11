const crypto = require("node:crypto");
const QRCode = require("qrcode");

const secret = () => process.env.QR_SIGNING_SECRET || process.env.JWT_SECRET || "dev_qr_secret";

const canonicalize = (obj) =>
  JSON.stringify(
    Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        acc[key] = obj[key];
        return acc;
      }, {})
  );

const signPayload = (core) =>
  crypto.createHmac("sha256", secret()).update(canonicalize(core)).digest("hex");

const toCompactPrescriptionLink = ({ prescId, linkCode }) => {
  if (!prescId || !linkCode) return "";
  return `refillit://link/${prescId}/${linkCode}`;
};

const buildPrescriptionQrPayload = (prescription) => {
  const core = {
    type: "refillit_prescription_v1",
    prescId: prescription.id,
    patientId: prescription.patientId || null,
    doctorId: prescription.doctorId || null,
    doctorName: prescription.doctorName || null,
    linkCode: prescription.linkCode || null,
    expiryDate: prescription.expiryDate || null,
    issuedAt: prescription.createdAt || new Date().toISOString(),
    meds: Array.isArray(prescription.meds)
      ? prescription.meds.map((med) => ({
        ndcCode: med.ndcCode || null,
        name: med.name || null,
        strength: med.strength || null,
        qty: med.qty || null,
      }))
      : [],
  };
  return { ...core, sig: signPayload(core) };
};

const generatePrescriptionQrDataUrl = async (payload) => {
  const compactContent = toCompactPrescriptionLink(payload);
  const rawContent = compactContent || JSON.stringify(payload);
  return QRCode.toDataURL(rawContent, {
    margin: 1,
    errorCorrectionLevel: compactContent ? "H" : "M",
  });
};

const parsePrescriptionQr = (raw) => {
  const value = String(raw || "").trim();
  if (!value) return null;

  if (value.startsWith("refillit://link/")) {
    const parts = value.replace("refillit://link/", "").split("/");
    if (parts.length >= 2) {
      return { type: "legacy_link", prescId: parts[0], linkCode: parts[1] };
    }
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(value);
  } catch (_error) {
    return null;
  }
  if (!parsed || parsed.type !== "refillit_prescription_v1") return null;
  const { sig, ...core } = parsed;
  if (!sig || sig !== signPayload(core)) return null;
  return parsed;
};

module.exports = {
  buildPrescriptionQrPayload,
  generatePrescriptionQrDataUrl,
  parsePrescriptionQr,
  toCompactPrescriptionLink,
};

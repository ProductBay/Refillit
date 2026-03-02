const crypto = require("node:crypto");
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { DemoNdaAcceptance } = require("../models");
const { writeAudit } = require("../utils/audit");

const router = express.Router();

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

const normalizeNewlines = (value) => String(value || "").replace(/\\n/g, "\n").trim();

const defaultAgreementText = [
  "CONFIDENTIAL DEMO ACCESS AGREEMENT",
  "",
  "This platform, including all architecture, workflows, features, business logic, and implementation details, is proprietary intellectual property of Refillit.",
  "",
  "By accessing this demo, you agree to:",
  "1. Keep all disclosed information strictly confidential.",
  "2. Not copy, reverse engineer, reuse, or reproduce any part of the platform logic, UX flows, or implementation concepts.",
  "3. Not use the disclosed concepts to build a competing product or derivative without written authorization.",
  "4. Acknowledge that all rights, title, and interest remain exclusively with Refillit.",
  "",
  "Unauthorized use or disclosure is prohibited and may result in legal action.",
].join("\n");

const buildAgreementConfig = () => {
  const enabled = isTruthy(process.env.DEMO_NDA_ENABLED || "true");
  const version = String(process.env.DEMO_NDA_VERSION || "2026-03-02").trim();
  const title = String(process.env.DEMO_NDA_TITLE || "Refillit Demo Confidentiality Agreement").trim();
  const text = normalizeNewlines(process.env.DEMO_NDA_TEXT || defaultAgreementText);
  const requireTypedName = isTruthy(process.env.DEMO_NDA_REQUIRE_TYPED_NAME || "true");
  const companyName = String(process.env.DEMO_NDA_COMPANY_NAME || "Refillit").trim();
  const hash = crypto
    .createHash("sha256")
    .update(`${version}\n${title}\n${text}`)
    .digest("hex");
  return {
    enabled,
    version,
    title,
    text,
    hash,
    requireTypedName,
    companyName,
  };
};

const getLatestAcceptance = async ({ userId }) => {
  const entries = await DemoNdaAcceptance.findAll({ where: { userId } });
  if (!entries.length) return null;
  return entries
    .slice()
    .sort((a, b) => new Date(b.acceptedAt || b.createdAt || 0) - new Date(a.acceptedAt || a.createdAt || 0))[0];
};

router.get("/current", requireAuth, async (_req, res) => {
  const agreement = buildAgreementConfig();
  return res.json({
    agreement: {
      enabled: agreement.enabled,
      version: agreement.version,
      title: agreement.title,
      text: agreement.text,
      hash: agreement.hash,
      requireTypedName: agreement.requireTypedName,
      companyName: agreement.companyName,
    },
  });
});

router.get("/status", requireAuth, async (req, res) => {
  const agreement = buildAgreementConfig();
  if (!agreement.enabled) {
    return res.json({
      nda: {
        required: false,
        accepted: true,
        acceptedAt: null,
        version: agreement.version,
      },
    });
  }
  const latest = await getLatestAcceptance({ userId: req.user.id });
  const accepted =
    Boolean(latest) &&
    String(latest.agreementVersion || "") === agreement.version &&
    String(latest.agreementHash || "") === agreement.hash;
  return res.json({
    nda: {
      required: true,
      accepted,
      acceptedAt: accepted ? latest.acceptedAt || latest.createdAt || null : null,
      acceptedName: accepted ? latest.acceptedName || null : null,
      version: agreement.version,
      hash: agreement.hash,
    },
  });
});

router.post("/accept", requireAuth, async (req, res) => {
  const agreement = buildAgreementConfig();
  if (!agreement.enabled) {
    return res.json({
      nda: {
        required: false,
        accepted: true,
        acceptedAt: null,
        version: agreement.version,
      },
    });
  }

  const agreed = req.body?.agreed === true;
  if (!agreed) {
    return res.status(400).json({ error: "agreed must be true" });
  }
  const acceptedName = String(req.body?.acceptedName || "").trim();
  if (agreement.requireTypedName && acceptedName.length < 2) {
    return res.status(400).json({ error: "acceptedName is required (min 2 chars)" });
  }

  const acceptedAt = new Date().toISOString();
  const ipAddress =
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null;
  const userAgent = String(req.headers["user-agent"] || "").trim() || null;
  const record = await DemoNdaAcceptance.create({
    userId: req.user.id,
    agreementVersion: agreement.version,
    agreementHash: agreement.hash,
    agreementTitle: agreement.title,
    agreementText: agreement.text,
    acceptedAt,
    acceptedName: acceptedName || req.user.fullName || null,
    acceptedByRole: req.user.role || null,
    ipAddress,
    userAgent,
    metadata: {
      companyName: agreement.companyName,
    },
  });

  await writeAudit({
    actorUserId: req.user.id,
    action: "demo_nda.accepted",
    entityType: "demo_nda_acceptance",
    entityId: record.id,
    metadata: {
      agreementVersion: agreement.version,
      agreementHash: agreement.hash,
      acceptedAt,
      acceptedName: record.acceptedName || null,
      ipAddress,
    },
  });

  return res.json({
    nda: {
      required: true,
      accepted: true,
      acceptedAt,
      acceptedName: record.acceptedName || null,
      version: agreement.version,
      hash: agreement.hash,
    },
  });
});

module.exports = router;

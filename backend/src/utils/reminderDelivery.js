const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
};

const normalizePhoneForWhatsApp = (value, defaultCountryCode = "") => {
  const digits = String(value || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits.slice(1);
  const numeric = digits.replace(/\D/g, "");
  if (!numeric) return "";
  const cc = String(defaultCountryCode || "").replace(/[^\d]/g, "");
  if (!cc) return numeric;
  if (numeric.startsWith(cc)) return numeric;
  return `${cc}${numeric}`;
};

let cachedTransporter = null;
let cachedTransporterKey = "";

const getSmtpTransporter = async () => {
  const enabled = toBool(process.env.SMTP_ENABLED, false);
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 0);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  if (!enabled || !host || !port || !user || !pass) {
    return { transporter: null, reason: "SMTP provider is not configured." };
  }
  const key = `${host}:${port}:${user}`;
  if (cachedTransporter && cachedTransporterKey === key) {
    return { transporter: cachedTransporter, reason: null };
  }
  try {
    // Optional runtime dependency. If missing, reminder dispatch returns provider-unavailable.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: toBool(process.env.SMTP_SECURE, port === 465),
      auth: { user, pass },
    });
    cachedTransporter = transporter;
    cachedTransporterKey = key;
    return { transporter, reason: null };
  } catch (_err) {
    return { transporter: null, reason: "nodemailer is not installed on the backend runtime." };
  }
};

const sendEmailReminder = async ({ to, subject, text, html }) => {
  const recipient = String(to || "").trim();
  if (!recipient) {
    return { status: "failed", provider: "smtp", error: "Missing recipient email." };
  }
  const from = String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();
  if (!from) {
    return { status: "failed", provider: "smtp", error: "SMTP_FROM or SMTP_USER is required." };
  }
  const { transporter, reason } = await getSmtpTransporter();
  if (!transporter) {
    return { status: "skipped", provider: "smtp", error: reason || "SMTP unavailable." };
  }
  await transporter.sendMail({
    from,
    to: recipient,
    subject: subject || "Appointment reminder",
    text: text || "",
    html: html || undefined,
  });
  return { status: "sent", provider: "smtp", error: null };
};

const sendWhatsAppReminder = async ({ phone, text }) => {
  const enabled = toBool(process.env.WHATSAPP_ENABLED, false);
  const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  if (!enabled || !accessToken || !phoneNumberId) {
    return {
      status: "skipped",
      provider: "whatsapp",
      error: "WhatsApp Business provider is not configured.",
    };
  }
  const to = normalizePhoneForWhatsApp(phone, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "");
  if (!to) {
    return { status: "failed", provider: "whatsapp", error: "Missing or invalid recipient phone." };
  }

  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        preview_url: false,
        body: String(text || "").slice(0, 4096),
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    return {
      status: "failed",
      provider: "whatsapp",
      error: `WhatsApp API error ${response.status}: ${body.slice(0, 240)}`,
    };
  }
  return { status: "sent", provider: "whatsapp", error: null };
};

const sendReminder = async ({ channel, recipient, subject, messageText, messageHtml }) => {
  const mode = String(channel || "").trim().toLowerCase();
  if (mode === "email") {
    return sendEmailReminder({
      to: recipient?.email || "",
      subject,
      text: messageText,
      html: messageHtml,
    });
  }
  if (mode === "whatsapp") {
    return sendWhatsAppReminder({
      phone: recipient?.phone || "",
      text: messageText,
    });
  }
  if (mode === "sms") {
    return {
      status: "skipped",
      provider: "sms",
      error: "SMS provider not configured in this integration.",
    };
  }
  return {
    status: "failed",
    provider: mode || "unknown",
    error: "Unsupported reminder channel.",
  };
};

module.exports = {
  sendReminder,
};


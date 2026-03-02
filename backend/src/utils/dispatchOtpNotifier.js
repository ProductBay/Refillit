const { sendReminder } = require("./reminderDelivery");

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

const buildOtpMessage = ({ otp, orderId, expiresAt }) => {
  const expiresLabel = expiresAt ? new Date(expiresAt).toLocaleString() : "soon";
  const text = [
    "Refillit Delivery OTP",
    `Order: ${orderId}`,
    `Code: ${otp}`,
    `Expires: ${expiresLabel}`,
    "Share this code only with your assigned courier at delivery.",
  ].join("\n");
  const html = `
    <p><strong>Refillit Delivery OTP</strong></p>
    <p>Order: <strong>${String(orderId || "")}</strong><br/>
    Code: <strong>${String(otp || "")}</strong><br/>
    Expires: <strong>${expiresLabel}</strong></p>
    <p>Share this code only with your assigned courier at delivery.</p>
  `;
  return { text, html };
};

const sendPushNotification = async ({ patientUserId, text }) => {
  const enabled = isTruthy(process.env.DISPATCH_PUSH_ENABLED || "true");
  if (!enabled) {
    return {
      status: "skipped",
      provider: "patient_app_push",
      error: "Patient app push provider is not configured.",
    };
  }
  if (!patientUserId) {
    return {
      status: "failed",
      provider: "patient_app_push",
      error: "Missing patient id for push notification.",
    };
  }
  return {
    status: "sent",
    provider: "patient_app_push",
    error: null,
    message: text,
  };
};

const attemptWithRetry = async ({ action, retries }) => {
  const attempts = Math.max(1, Number(retries || 0) + 1);
  let last = null;
  for (let idx = 0; idx < attempts; idx += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await action();
    last = result;
    if (result?.status === "sent") {
      return { ...result, attemptsUsed: idx + 1 };
    }
  }
  return { ...(last || {}), attemptsUsed: attempts };
};

const sendDispatchOtpWithFallback = async ({
  orderId,
  otp,
  expiresAt,
  patientUser,
  patientProfile,
}) => {
  const message = buildOtpMessage({ otp, orderId, expiresAt });
  const retries = Math.max(0, Number(process.env.DISPATCH_OTP_NOTIFY_RETRIES || 1));
  const channels = [];
  const chain = [
    {
      channel: "patient_app_push",
      send: () =>
        sendPushNotification({
          patientUserId: patientUser?.id || null,
          text: message.text,
        }),
    },
    {
      channel: "whatsapp",
      send: () =>
        sendReminder({
          channel: "whatsapp",
          recipient: { phone: patientProfile?.phone || "" },
          messageText: message.text,
        }),
    },
    {
      channel: "email",
      send: () =>
        sendReminder({
          channel: "email",
          recipient: { email: patientUser?.email || "" },
          subject: "Your Refillit delivery OTP",
          messageText: message.text,
          messageHtml: message.html,
        }),
    },
  ];

  let deliveredVia = null;
  for (const step of chain) {
    // eslint-disable-next-line no-await-in-loop
    const result = await attemptWithRetry({ action: step.send, retries });
    const payload = {
      channel: step.channel,
      status: String(result?.status || "failed"),
      provider: result?.provider || step.channel,
      error: result?.error || null,
      attemptsUsed: Number(result?.attemptsUsed || 1),
      at: new Date().toISOString(),
    };
    channels.push(payload);
    if (payload.status === "sent") {
      deliveredVia = step.channel;
      break;
    }
  }

  return {
    strategy: "fallback_push_whatsapp_email",
    success: Boolean(deliveredVia),
    deliveredVia,
    channels,
    attemptedAt: new Date().toISOString(),
  };
};

module.exports = {
  sendDispatchOtpWithFallback,
};


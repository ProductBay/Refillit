const { sendReminder } = require("./reminderDelivery");
const { ChatMessage, ChatThread } = require("../models");
const { emitToUser } = require("../chat/ws");

const toBool = (value, fallback = true) => {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
};

const nowIso = () => new Date().toISOString();

const ensureCourierPatientThread = async ({ courierId, patientId }) => {
  const allThreads = await ChatThread.findAll({});
  const target = allThreads.find((thread) => {
    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    return participants.includes(String(courierId || "")) && participants.includes(String(patientId || ""));
  });
  if (target) return target;
  return ChatThread.create({
    participants: [String(courierId || ""), String(patientId || "")].filter(Boolean),
    threadType: "multi_role",
  });
};

const sendPatientChatMessage = async ({ courierId, patientId, text }) => {
  if (!courierId || !patientId) {
    return {
      channel: "patient_chat",
      status: "failed",
      provider: "in_app_chat",
      error: "Missing courier or patient id for chat delivery.",
      at: nowIso(),
    };
  }
  try {
    const thread = await ensureCourierPatientThread({ courierId, patientId });
    const message = await ChatMessage.create({
      threadId: thread.id,
      senderId: courierId,
      message: String(text || "").trim(),
    });
    thread.lastMessageAt = message.createdAt;
    thread.lastMessageText = message.message;
    thread.lastMessageSenderId = message.senderId;
    await thread.save();
    emitToUser(patientId, { type: "message", message, threadId: thread.id });
    return {
      channel: "patient_chat",
      status: "sent",
      provider: "in_app_chat",
      error: null,
      at: nowIso(),
    };
  } catch (err) {
    return {
      channel: "patient_chat",
      status: "failed",
      provider: "in_app_chat",
      error: String(err?.message || "Unable to send patient chat message."),
      at: nowIso(),
    };
  }
};

const sendCourierMessageFanout = async ({
  orderId,
  text,
  courierUserId,
  patientUser,
  patientProfile,
  recipientPhone,
}) => {
  const messageText = String(text || "").trim();
  const at = nowIso();
  const subject = `Refillit delivery update for order ${String(orderId || "")}`;
  const html = `<p>${messageText.replace(/\n/g, "<br/>")}</p>`;
  const phone = String(recipientPhone || patientProfile?.phone || "").trim();
  const channels = [];

  if (toBool(process.env.DISPATCH_COURIER_CHAT_ENABLED, true)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendPatientChatMessage({
      courierId: courierUserId,
      patientId: patientUser?.id || null,
      text: messageText,
    });
    channels.push(result);
  }

  if (toBool(process.env.DISPATCH_COURIER_EMAIL_ENABLED, true)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendReminder({
      channel: "email",
      recipient: { email: patientUser?.email || "" },
      subject,
      messageText,
      messageHtml: html,
    });
    channels.push({
      channel: "email",
      status: String(result?.status || "failed"),
      provider: result?.provider || "smtp",
      error: result?.error || null,
      at,
    });
  }

  if (toBool(process.env.DISPATCH_COURIER_SMS_ENABLED, true)) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sendReminder({
      channel: "sms",
      recipient: { phone },
      messageText,
    });
    channels.push({
      channel: "sms",
      status: String(result?.status || "failed"),
      provider: result?.provider || "sms",
      error: result?.error || null,
      at,
    });
  }

  const deliveredChannels = channels
    .filter((entry) => String(entry.status || "").toLowerCase() === "sent")
    .map((entry) => entry.channel);

  return {
    strategy: "fanout_chat_email_sms",
    attemptedAt: at,
    channels,
    deliveredChannels,
    success: deliveredChannels.length > 0,
  };
};

module.exports = {
  sendCourierMessageFanout,
};


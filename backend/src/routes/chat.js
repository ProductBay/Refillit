const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { ChatMessage, ChatThread, DoctorConnection, User } = require("../models");
const { emitToUser } = require("../chat/ws");

const router = express.Router();

const canAccessThread = async (thread, user) => {
  if (!thread) return false;
  const participantIds = Array.isArray(thread.participants) ? thread.participants : [];
  if (participantIds.includes(user.id)) return true;
  if (user.role === "doctor" && thread.doctorId === user.id) return true;
  if (user.role === "patient" && thread.patientId === user.id) return true;
  if (user.role === "pharmacy" && thread.pharmacyId === user.id) return true;
  return user.role === "admin";
};

const threadParticipants = (thread) => {
  const participants = Array.isArray(thread.participants) ? thread.participants : [];
  return Array.from(
    new Set([...participants, thread.doctorId, thread.patientId, thread.pharmacyId].filter(Boolean))
  );
};

const getReadFieldForRole = (role) => {
  if (role === "doctor") return "doctorLastReadAt";
  if (role === "patient") return "patientLastReadAt";
  if (role === "pharmacy") return "pharmacyLastReadAt";
  return null;
};

const enrichThreadForUser = async (thread, viewer) => {
  const participantIds = Array.isArray(thread.participants) ? thread.participants : [];
  const nonViewer = participantIds.filter((id) => id && id !== viewer.id);
  const fallbackCounterpartId =
    viewer.role === "doctor"
      ? thread.patientId || thread.pharmacyId || null
      : thread.doctorId || null;
  const counterpartId =
    nonViewer.length === 1 ? nonViewer[0] : (nonViewer.length > 1 ? null : fallbackCounterpartId);
  const counterpart = counterpartId ? await User.findByPk(counterpartId) : null;
  const messages = await ChatMessage.findAll({ where: { threadId: thread.id } });
  messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  const readField = getReadFieldForRole(viewer.role);
  const lastReadAt =
    readField ? thread[readField] : (thread.readBy ? thread.readBy[viewer.id] : null);
  const unreadCount = messages.filter((message) => {
    if (message.senderId === viewer.id) return false;
    if (!lastReadAt) return true;
    return new Date(message.createdAt) > new Date(lastReadAt);
  }).length;
  return {
    ...thread,
    counterpartId,
    counterpartName:
      nonViewer.length > 1
        ? "Group chat"
        : counterpart?.fullName || null,
    counterpartRole:
      nonViewer.length > 1
        ? "group"
        : counterpart?.role || null,
    lastMessagePreview: lastMessage?.message || null,
    lastMessageAt: lastMessage?.createdAt || null,
    lastMessageSenderId: lastMessage?.senderId || null,
    unreadCount,
  };
};

router.get(
  "/threads",
  requireAuth,
  requireRoles(["doctor", "patient", "pharmacy", "admin", "moh", "nhf", "courier", "receptionist"]),
  async (req, res) => {
    const all = await ChatThread.findAll({});
    const visible = [];
    for (const thread of all) {
      // eslint-disable-next-line no-await-in-loop
      if (await canAccessThread(thread, req.user)) {
        // eslint-disable-next-line no-await-in-loop
        visible.push(await enrichThreadForUser(thread, req.user));
      }
    }
    visible.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json({ threads: visible });
  }
);

router.get(
  "/seeded-users",
  requireAuth,
  requireRoles(["doctor", "patient", "pharmacy", "admin", "moh", "nhf", "courier", "receptionist"]),
  async (_req, res) => {
    const users = await User.findAll({});
    const allow = new Set(["doctor", "patient", "pharmacy", "courier", "moh", "nhf", "receptionist", "admin"]);
    const rows = users
      .filter((user) => allow.has(String(user.role || "").toLowerCase()))
      .map((user) => ({
        id: user.id,
        fullName: user.fullName || "",
        role: user.role || "",
        email: user.email || "",
        platformStaffId: user.platformStaffId || null,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    return res.json({ users: rows });
  }
);

router.post(
  "/threads",
  requireAuth,
  requireRoles(["doctor", "patient", "pharmacy", "admin", "moh", "nhf", "courier", "receptionist"]),
  async (req, res) => {
    const doctorId = req.body?.doctorId || (req.user.role === "doctor" ? req.user.id : null);
    const patientId = req.body?.patientId || (req.user.role === "patient" ? req.user.id : null);
    const pharmacyId =
      req.body?.pharmacyId || (req.user.role === "pharmacy" ? req.user.id : null);
    const participantIds = Array.isArray(req.body?.participants)
      ? req.body.participants.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const uniqueParticipants = Array.from(new Set([req.user.id, ...participantIds]));

    const isDoctorPatient = Boolean(doctorId && patientId && !pharmacyId);
    const isDoctorPharmacy = Boolean(doctorId && pharmacyId && !patientId);
    if (!isDoctorPatient && !isDoctorPharmacy && uniqueParticipants.length < 2) {
      return res.status(400).json({
        error: "Create doctor+patient, doctor+pharmacy, or provide participants for a multi-role thread",
      });
    }
    if (req.user.role === "doctor" && doctorId !== req.user.id) {
      return res.status(403).json({ error: "doctorId must match authenticated doctor" });
    }
    if (req.user.role === "patient" && patientId !== req.user.id) {
      return res.status(403).json({ error: "patientId must match authenticated patient" });
    }
    if (req.user.role === "pharmacy" && pharmacyId !== req.user.id) {
      return res.status(403).json({ error: "pharmacyId must match authenticated pharmacy" });
    }

    if (isDoctorPatient && req.user.role === "patient") {
      const connection = await DoctorConnection.findOne({
        where: { doctorId, patientId, status: "approved" },
      });
      if (!connection) {
        return res.status(403).json({ error: "Doctor-patient connection not approved" });
      }
    }

    let thread = null;
    if (isDoctorPatient) {
      thread = await ChatThread.findOne({ where: { doctorId, patientId } });
    } else {
      thread = await ChatThread.findOne({ where: { doctorId, pharmacyId } });
    }
    if (!thread) {
      thread = await ChatThread.create({
        doctorId,
        patientId: patientId || null,
        pharmacyId: pharmacyId || null,
        participants: uniqueParticipants,
        threadType: isDoctorPatient ? "doctor_patient" : isDoctorPharmacy ? "doctor_pharmacy" : "multi_role",
      });
    }
    return res.status(201).json({ thread: await enrichThreadForUser(thread, req.user) });
  }
);

router.get("/threads/:id/messages", requireAuth, async (req, res) => {
  const thread = await ChatThread.findByPk(req.params.id);
  if (!(await canAccessThread(thread, req.user))) {
    return res.status(404).json({ error: "Thread not found" });
  }
  const messages = await ChatMessage.findAll({ where: { threadId: thread.id } });
  const readField = getReadFieldForRole(req.user.role);
  if (readField) {
    thread[readField] = new Date().toISOString();
    await thread.save();
  } else {
    const nextReadBy = { ...(thread.readBy || {}) };
    nextReadBy[req.user.id] = new Date().toISOString();
    thread.readBy = nextReadBy;
    await thread.save();
  }
  return res.json({ messages });
});

router.post("/threads/:id/messages", requireAuth, async (req, res) => {
  const thread = await ChatThread.findByPk(req.params.id);
  if (!(await canAccessThread(thread, req.user))) {
    return res.status(404).json({ error: "Thread not found" });
  }
  const message = await ChatMessage.create({
    threadId: thread.id,
    senderId: req.user.id,
    message: String(req.body?.message || "").trim(),
  });
  thread.lastMessageAt = message.createdAt;
  thread.lastMessageText = message.message;
  thread.lastMessageSenderId = message.senderId;
  await thread.save();
  for (const participantId of threadParticipants(thread)) {
    if (participantId !== req.user.id) {
      emitToUser(participantId, { type: "message", message, threadId: thread.id });
    }
  }
  return res.status(201).json({ message });
});

module.exports = router;

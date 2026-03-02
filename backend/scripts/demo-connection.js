require("../src/config/env");

const API = process.env.API_BASE || "http://localhost:4000";

const login = async (email, password) => {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Login failed ${res.status}: ${text}`);
  }
  return JSON.parse(text);
};

const apiCall = async (path, token, method = "GET", body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
};

const ensureDemoDoctorApproved = async () => {
  const { sequelize } = require("../src/db");
  const { User, DoctorProfile, initModels } = require("../src/models");
  initModels();
  await sequelize.authenticate();

  const doctor = await User.findOne({ where: { email: "doctor@refillit.dev" } });
  if (!doctor) return false;

  let profile = await DoctorProfile.findOne({ where: { userId: doctor.id } });
  if (!profile) {
    profile = await DoctorProfile.create({ userId: doctor.id, mohVerified: true });
  } else if (!profile.mohVerified) {
    profile.mohVerified = true;
    await profile.save();
  }
  return true;
};

const run = async () => {
  const doctorLogin = await login("doctor@refillit.dev", "Refillit123!");
  const patientLogin = await login("patient@refillit.dev", "Refillit123!");

  console.log("Logged in doctor:", doctorLogin.user?.fullName);
  console.log("Logged in patient:", patientLogin.user?.fullName);

  let directory = await apiCall("/api/patient/doctors", patientLogin.token);
  if (!directory.doctors?.length) {
    console.log("No approved doctors found, approving demo doctor profile...");
    await ensureDemoDoctorApproved();
    directory = await apiCall("/api/patient/doctors", patientLogin.token);
  }

  if (!directory.doctors?.length) {
    console.log("Still no approved doctors available. Check doctor profile data.");
    return;
  }

  const target = directory.doctors[0];
  console.log("Requesting doctor:", target.fullName, target.id);

  const request = await apiCall("/api/patient/doctor-requests", patientLogin.token, "POST", {
    doctorId: target.id,
  });
  console.log("Request status:", request.connection?.status || "unknown");

  const pending = await apiCall(
    "/api/doctor/connection-requests?status=pending",
    doctorLogin.token
  );
  const match = (pending.connections || []).find(
    (c) => c.patientId === patientLogin.user.id && c.doctorId === doctorLogin.user.id
  ) || pending.connections?.[0];

  if (!match) {
    console.log("No pending connection found.");
    return;
  }

  const approved = await apiCall(
    `/api/doctor/connection-requests/${match.id}/approve`,
    doctorLogin.token,
    "POST"
  );
  console.log("Approved connection:", approved.connection?.status || "unknown");

  const thread = await apiCall("/api/chat/threads", patientLogin.token, "POST", {
    doctorId: target.id,
  });
  console.log("Thread id:", thread.thread?.id);

  const msg1 = await apiCall(
    `/api/chat/threads/${thread.thread.id}/messages`,
    patientLogin.token,
    "POST",
    { message: "Hello doctor, this is a live demo message." }
  );
  console.log("Patient sent message id:", msg1.message?.id);

  const msg2 = await apiCall(
    `/api/chat/threads/${thread.thread.id}/messages`,
    doctorLogin.token,
    "POST",
    { message: "Received. Connection approved and chat is live." }
  );
  console.log("Doctor replied id:", msg2.message?.id);

  const messages = await apiCall(
    `/api/chat/threads/${thread.thread.id}/messages`,
    patientLogin.token
  );
  console.log("Message count:", messages.messages?.length || 0);
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

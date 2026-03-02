const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

const { app } = require("../src/app");
const { truncateTables } = require("../src/db/memoryStore");
const {
  User,
  PatientProfile,
  DoctorConnection,
  Appointment,
  Prescription,
} = require("../src/models");
const { hashPassword } = require("../src/utils/password");
const { signAccessToken } = require("../src/utils/jwt");
const { encryptValue } = require("../src/utils/fieldCrypto");
const { buildPrescriptionQrPayload } = require("../src/utils/prescriptionQr");

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

beforeEach(() => {
  truncateTables();
});

test("prescription safety blocks on high-risk allergy warning unless override", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Safety",
      role: "doctor",
      email: "dr.safety@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Safety",
      role: "patient",
      email: "patient.safety@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    await PatientProfile.create({
      userId: patient.id,
      allergies: encryptValue(JSON.stringify(["amlodipine"])),
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const blockedRes = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
        allowedRefills: 1,
      }),
    });
    assert.equal(blockedRes.status, 409);
    const blockedBody = await blockedRes.json();
    assert.equal(Array.isArray(blockedBody.warnings), true);
    assert.ok(blockedBody.warnings.some((w) => w.type === "allergy_conflict"));

    const overrideRes = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
        allowedRefills: 1,
        overrideSafety: true,
      }),
    });
    assert.equal(overrideRes.status, 201);
    const overrideBody = await overrideRes.json();
    assert.equal(overrideBody.safety.overrideApplied, true);
  } finally {
    server.close();
  }
});

test("hard-stop interaction cannot be overridden", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Hard Stop",
      role: "doctor",
      email: "dr.hardstop@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Hard Stop",
      role: "patient",
      email: "patient.hardstop@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    await Prescription.create({
      doctorId: doctor.id,
      patientId: patient.id,
      meds: [{ name: "Amlodipine", ndcCode: "M001", strength: "5mg", qty: 30 }],
      allowedRefills: 1,
      linkCode: "HARDS1",
      linked: false,
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const blockedRes = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        meds: [{ ndcCode: "M004", name: "Atorvastatin", strength: "10mg", qty: 30 }],
        allowedRefills: 1,
        overrideSafety: true,
      }),
    });
    assert.equal(blockedRes.status, 422);
    const blockedBody = await blockedRes.json();
    assert.ok(blockedBody.warnings.some((entry) => entry.hardStop === true));
  } finally {
    server.close();
  }
});

test("doctor task inbox returns pending counts and due reminders", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Inbox",
      role: "doctor",
      email: "dr.inbox@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Inbox",
      role: "patient",
      email: "patient.inbox@example.com",
      passwordHash,
    });
    await DoctorConnection.create({
      doctorId: doctor.id,
      patientId: patient.id,
      status: "pending",
    });

    const startAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const endAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    await Appointment.create({
      doctorId: doctor.id,
      patientId: patient.id,
      startAt,
      endAt,
      status: "pending",
      reminderChannel: "email",
      reminderDefault24h: true,
      reminderDefaultSentAt: null,
      reminderCustomSentAt: null,
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const inboxRes = await fetch(`${baseUrl}/api/doctor/task-inbox`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(inboxRes.status, 200);
    const inboxBody = await inboxRes.json();
    assert.equal(inboxBody.counts.pendingConnections, 1);
    assert.equal(inboxBody.counts.pendingAppointments, 1);
    assert.ok(inboxBody.counts.dueReminders >= 0);
    assert.ok(Array.isArray(inboxBody.items));
    assert.ok(inboxBody.items.some((item) => item.type === "appointment_pending"));
  } finally {
    server.close();
  }
});

test("doctor can verify prescription from signed QR content", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Verify",
      role: "doctor",
      email: "dr.verify@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Verify",
      role: "patient",
      email: "patient.verify@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const prescription = await Prescription.create({
      doctorId: doctor.id,
      doctorName: doctor.fullName,
      patientId: patient.id,
      patientFullName: patient.fullName,
      meds: [{ name: "Amlodipine", ndcCode: "M001", strength: "5mg", qty: 30 }],
      allowedRefills: 2,
      linkCode: "QRDOC1",
      linked: false,
    });
    const qrPayload = buildPrescriptionQrPayload(prescription);
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const verifyRes = await fetch(`${baseUrl}/api/doctor/verify-prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ qrContent: JSON.stringify(qrPayload) }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.verified, true);
    assert.equal(verifyBody.prescription.id, prescription.id);
    assert.equal(verifyBody.prescription.doctorId, doctor.id);
  } finally {
    server.close();
  }
});

test("controlled substance requires justification before prescription can be created", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Controlled",
      role: "doctor",
      email: "dr.controlled@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Controlled",
      role: "patient",
      email: "patient.controlled@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const blockedRes = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        meds: [{ ndcCode: "M011", name: "Codeine", strength: "30mg", qty: 20 }],
        allowedRefills: 0,
      }),
    });
    assert.equal(blockedRes.status, 422);
    const blockedBody = await blockedRes.json();
    assert.ok(blockedBody.warnings.some((entry) => entry.type === "controlled_substance"));

    const allowedRes = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        meds: [{ ndcCode: "M011", name: "Codeine", strength: "30mg", qty: 20 }],
        controlledSubstanceJustification: "Severe post-operative pain management, short course only.",
        allowedRefills: 0,
      }),
    });
    assert.equal(allowedRes.status, 201);
  } finally {
    server.close();
  }
});

test("doctor can create template and favorite med for quick ordering", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Template",
      role: "doctor",
      email: "dr.template@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const createTemplateRes = await fetch(`${baseUrl}/api/doctor/prescription-templates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        name: "Test Template",
        diagnosis: "Hypertension",
        meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
        allowedRefills: 2,
      }),
    });
    assert.equal(createTemplateRes.status, 201);

    const listTemplatesRes = await fetch(`${baseUrl}/api/doctor/prescription-templates`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(listTemplatesRes.status, 200);
    const templatesBody = await listTemplatesRes.json();
    assert.ok(Array.isArray(templatesBody.templates));
    assert.ok(templatesBody.templates.some((entry) => entry.name === "Test Template"));

    const createFavoriteRes = await fetch(`${baseUrl}/api/doctor/favorite-meds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        med: { ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30, allowedRefills: 2 },
      }),
    });
    assert.equal(createFavoriteRes.status, 201);

    const listFavoritesRes = await fetch(`${baseUrl}/api/doctor/favorite-meds`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(listFavoritesRes.status, 200);
    const favoritesBody = await listFavoritesRes.json();
    assert.ok(Array.isArray(favoritesBody.favorites));
    assert.equal(favoritesBody.favorites.length, 1);
  } finally {
    server.close();
  }
});

test("dose guardrail warns when pediatric dose is out of range for weight", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Dose",
      role: "doctor",
      email: "dr.dose@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Dose",
      role: "patient",
      email: "patient.dose@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const response = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        patientDob: "2020-01-01",
        patientWeightKg: 10,
        meds: [{ ndcCode: "M010", name: "Paracetamol", strength: "500mg", qty: 10 }],
        allowedRefills: 0,
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.ok(body.warnings.some((entry) => entry.type === "dose_out_of_range"));
  } finally {
    server.close();
  }
});

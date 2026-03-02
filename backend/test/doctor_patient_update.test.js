const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

const { app } = require("../src/app");
const { truncateTables } = require("../src/db/memoryStore");
const { User, PatientProfile, Appointment, Prescription, Order } = require("../src/models");
const { hashPassword } = require("../src/utils/password");
const { signAccessToken } = require("../src/utils/jwt");
const { encryptValue } = require("../src/utils/fieldCrypto");

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

test("doctor can update patient details and sensitive profile fields", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Update",
      role: "doctor",
      email: "dr.update@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Old",
      role: "patient",
      email: "patient.old@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    await PatientProfile.create({
      userId: patient.id,
      phone: "8760000000",
      address: encryptValue("Old Address"),
      trn: encryptValue("111"),
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const updateRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        fullName: "Patient New",
        email: "patient.new@example.com",
        phone: "8761234567",
        address: "New Address",
        trn: "TRN-999",
        allergies: "penicillin, aspirin",
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json();
    assert.equal(updateBody.patient.fullName, "Patient New");
    assert.equal(updateBody.patient.email, "patient.new@example.com");
    assert.equal(updateBody.patient.phone, "8761234567");
    assert.equal(updateBody.patient.address, "New Address");
    assert.equal(updateBody.patient.trn, "TRN-999");
    assert.equal(updateBody.patient.allergies.length, 2);

    const recordRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/record`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(recordRes.status, 200);
    const recordBody = await recordRes.json();
    assert.equal(recordBody.patient.fullName, "Patient New");
    assert.equal(recordBody.patient.email, "patient.new@example.com");
    assert.equal(recordBody.patient.trn, "TRN-999");
  } finally {
    server.close();
  }
});

test("doctor unified patient timeline includes indicators and risk flags", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Timeline",
      role: "doctor",
      email: "dr.timeline@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Timeline",
      role: "patient",
      email: "patient.timeline@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const prescription = await Prescription.create({
      doctorId: doctor.id,
      patientId: patient.id,
      meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
      allowedRefills: 1,
      linkCode: "TLN001",
      linked: true,
    });
    await Order.create({
      patientId: patient.id,
      prescId: prescription.id,
      orderStatus: "failed",
    });
    await Order.create({
      patientId: patient.id,
      prescId: prescription.id,
      orderStatus: "failed",
    });
    await Appointment.create({
      doctorId: doctor.id,
      patientId: patient.id,
      startAt: "2026-03-10T10:00:00.000Z",
      endAt: "2026-03-10T10:30:00.000Z",
      status: "no_show",
      reason: "Follow-up",
    });
    await Appointment.create({
      doctorId: doctor.id,
      patientId: patient.id,
      startAt: "2026-03-20T10:00:00.000Z",
      endAt: "2026-03-20T10:30:00.000Z",
      status: "no_show",
      reason: "Follow-up",
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const response = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/timeline`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.timeline));
    assert.ok(body.timeline.length >= 3);
    assert.ok(Array.isArray(body.riskFlags));
    assert.ok(body.riskFlags.some((flag) => flag.type === "repeated_no_show"));
    assert.ok(body.riskFlags.some((flag) => flag.type === "non_adherence"));
    assert.ok(Object.prototype.hasOwnProperty.call(body, "indicators"));
  } finally {
    server.close();
  }
});

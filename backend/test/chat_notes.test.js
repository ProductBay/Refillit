const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

const { app } = require("../src/app");
const { truncateTables } = require("../src/db/memoryStore");
const { User } = require("../src/models");
const { hashPassword } = require("../src/utils/password");
const { signAccessToken } = require("../src/utils/jwt");

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

test("doctor can chat directly with pharmacy", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Chat",
      role: "doctor",
      email: "dr.chat@example.com",
      passwordHash,
    });
    const pharmacy = await User.create({
      fullName: "Pharmacy Chat",
      role: "pharmacy",
      email: "pharmacy.chat@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const pharmacyToken = signAccessToken({ id: pharmacy.id, role: "pharmacy" });

    const createThreadRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ doctorId: doctor.id, pharmacyId: pharmacy.id }),
    });
    assert.equal(createThreadRes.status, 201);
    const createThreadBody = await createThreadRes.json();
    assert.equal(createThreadBody.thread.threadType, "doctor_pharmacy");

    const threadId = createThreadBody.thread.id;
    const sendByDoctorRes = await fetch(`${baseUrl}/api/chat/threads/${threadId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ message: "Please validate this script." }),
    });
    assert.equal(sendByDoctorRes.status, 201);

    const sendByPharmacyRes = await fetch(`${baseUrl}/api/chat/threads/${threadId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pharmacyToken}`,
      },
      body: JSON.stringify({ message: "Validated and queued." }),
    });
    assert.equal(sendByPharmacyRes.status, 201);

    const readRes = await fetch(`${baseUrl}/api/chat/threads/${threadId}/messages`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(readRes.status, 200);
    const readBody = await readRes.json();
    assert.equal(readBody.messages.length, 2);
  } finally {
    server.close();
  }
});

test("private patient notes require doctor receptionist grant", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Notes",
      role: "doctor",
      email: "dr.notes@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Notes",
      role: "patient",
      email: "patient.notes@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const receptionist = await User.create({
      fullName: "Reception Desk",
      role: "receptionist",
      email: "reception@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const receptionistToken = signAccessToken({ id: receptionist.id, role: "receptionist" });

    const noteCreateRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/private-notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ text: "BP trend elevated. Review in follow-up." }),
    });
    assert.equal(noteCreateRes.status, 201);

    const doctorReadRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/private-notes`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(doctorReadRes.status, 200);
    const doctorReadBody = await doctorReadRes.json();
    assert.equal(doctorReadBody.notes.length, 1);

    const receptionistBlockedRes = await fetch(
      `${baseUrl}/api/doctor/patients/${patient.id}/private-notes?doctorId=${doctor.id}`,
      {
        headers: { Authorization: `Bearer ${receptionistToken}` },
      }
    );
    assert.equal(receptionistBlockedRes.status, 403);

    const grantRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/receptionist-access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        receptionistId: receptionist.id,
        canViewDemographics: true,
        canViewAppointments: true,
        canViewPrivateNotes: true,
        canViewPrescriptions: false,
      }),
    });
    assert.equal(grantRes.status, 201);

    const receptionistReadRes = await fetch(
      `${baseUrl}/api/doctor/patients/${patient.id}/private-notes?doctorId=${doctor.id}`,
      {
        headers: { Authorization: `Bearer ${receptionistToken}` },
      }
    );
    assert.equal(receptionistReadRes.status, 200);
    const receptionistReadBody = await receptionistReadRes.json();
    assert.equal(receptionistReadBody.notes.length, 1);
  } finally {
    server.close();
  }
});

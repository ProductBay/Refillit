const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

require("../src/config/env");

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

test("doctor can create patient, search by TRN, and access own patient record", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Search",
      role: "doctor",
      email: "dr.search@example.com",
      passwordHash,
    });
    const token = signAccessToken({ id: doctor.id, role: "doctor" });

    const createRes = await fetch(`${baseUrl}/api/doctor/patients`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fullName: "Patient Scoped",
        email: "patient.scoped@example.com",
        password: "Welcome123!",
        dob: "1985-01-02",
        phone: "+1-876-555-0101",
        idNumber: "JAM-111222333",
        trn: "TRN-777888999",
      }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.ok(createBody.patient.id);

    const searchRes = await fetch(
      `${baseUrl}/api/doctor/patients?query=${encodeURIComponent("TRN-777888999")}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(searchRes.status, 200);
    const searchBody = await searchRes.json();
    assert.equal(searchBody.patients.length, 1);
    assert.equal(searchBody.patients[0].id, createBody.patient.id);

    const recordRes = await fetch(
      `${baseUrl}/api/doctor/patients/${createBody.patient.id}/record`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(recordRes.status, 200);
  } finally {
    server.close();
  }
});

test("doctor can open patient record and gains approved connection on first access", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctorA = await User.create({
      fullName: "Dr A",
      role: "doctor",
      email: "dr.a@example.com",
      passwordHash,
    });
    const doctorB = await User.create({
      fullName: "Dr B",
      role: "doctor",
      email: "dr.b@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Hidden",
      role: "patient",
      email: "patient.hidden@example.com",
      passwordHash,
      createdByDoctorId: doctorA.id,
    });

    const doctorBToken = signAccessToken({ id: doctorB.id, role: "doctor" });
    const recordRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/record`, {
      headers: { Authorization: `Bearer ${doctorBToken}` },
    });
    assert.equal(recordRes.status, 200);
  } finally {
    server.close();
  }
});

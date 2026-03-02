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

test("doctor can grant and revoke receptionist access per patient", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Reception",
      role: "doctor",
      email: "dr.reception@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Reception",
      role: "patient",
      email: "patient.reception@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const receptionist = await User.create({
      fullName: "Reception User",
      role: "receptionist",
      email: "reception.user@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const createGrantRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/receptionist-access`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        receptionistId: receptionist.id,
        canViewDemographics: true,
        canViewAppointments: true,
        canViewPrivateNotes: false,
        canViewPrescriptions: false,
      }),
    });
    assert.equal(createGrantRes.status, 201);

    const listRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/receptionist-access`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.access.length, 1);
    assert.equal(listBody.access[0].receptionistId, receptionist.id);
    assert.equal(listBody.access[0].scopes.canViewDemographics, true);

    const revokeRes = await fetch(
      `${baseUrl}/api/doctor/patients/${patient.id}/receptionist-access/${receptionist.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${doctorToken}` },
      }
    );
    assert.equal(revokeRes.status, 200);

    const listAfterRevokeRes = await fetch(
      `${baseUrl}/api/doctor/patients/${patient.id}/receptionist-access`,
      {
        headers: { Authorization: `Bearer ${doctorToken}` },
      }
    );
    assert.equal(listAfterRevokeRes.status, 200);
    const listAfterRevokeBody = await listAfterRevokeRes.json();
    assert.equal(listAfterRevokeBody.access.length, 0);
  } finally {
    server.close();
  }
});

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

test("doctor can enroll receptionist and receptionist appears in selector list", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Enroll",
      role: "doctor",
      email: "dr.enroll@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const createRes = await fetch(`${baseUrl}/api/doctor/receptionists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        fullName: "Receptionist Enrolled",
        email: "receptionist.enrolled@example.com",
      }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.receptionist.role, "receptionist");
    assert.equal(createBody.receptionist.createdByDoctorId, doctor.id);
    assert.ok(createBody.credentialsIssued?.temporaryPassword);

    const listRes = await fetch(`${baseUrl}/api/doctor/receptionists`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.ok(
      (listBody.receptionists || []).some(
        (entry) =>
          entry.email === "receptionist.enrolled@example.com" &&
          entry.ownedByCurrentDoctor === true
      )
    );
  } finally {
    server.close();
  }
});

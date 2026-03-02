const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");

require("../src/config/env");

const { app } = require("../src/app");
const { sequelize } = require("../src/db");
const { initModels, PharmacyProfile, User, AuditLog } = require("../src/models");
const { migrator } = require("../src/migrate");
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

const listTables = async () => {
  const [rows] = await sequelize.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"
  );
  return new Set(rows.map((row) => row.tablename));
};

const truncateAll = async () => {
  const targets = [
    "audit_logs",
    "nhf_claims",
    "orders",
    "prescriptions",
    "pharmacy_profiles",
    "doctor_profiles",
    "users",
  ];

  let tables = await listTables();
  if (!targets.every((name) => tables.has(name))) {
    await migrator.up();
    tables = await listTables();
  }

  const existing = targets.filter((name) => tables.has(name));
  if (!existing.length) {
    throw new Error("Test DB missing required tables; migrations did not run.");
  }

  const quoted = existing.map((name) => `"${name}"`).join(", ");
  await sequelize.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);
};

const ensureDb = () => {
  if (!process.env.DATABASE_URL) {
    test.skip("DATABASE_URL not set; skipping DB-backed tests.");
    return false;
  }
  return true;
};

before(async () => {
  if (!ensureDb()) return;
  initModels();
  await sequelize.authenticate();
  await migrator.up();
});

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  await truncateAll();
});

after(async () => {
  if (!process.env.DATABASE_URL) return;
  await sequelize.close();
});

test("doctor -> patient link -> order -> pharmacy verify", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr. Test",
      role: "doctor",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Test",
      role: "patient",
      createdByDoctorId: doctor.id,
      passwordHash,
    });
    const pharmacyUser = await User.create({
      fullName: "Pharmacy Test",
      role: "pharmacy",
      passwordHash,
    });
    const courierUser = await User.create({
      fullName: "Courier Test",
      role: "courier",
      passwordHash,
    });
    const pharmacyProfile = await PharmacyProfile.create({
      userId: pharmacyUser.id,
      councilReg: "PC-TEST-001",
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });
    const pharmacyToken = signAccessToken({ id: pharmacyUser.id, role: "pharmacy" });
    const courierToken = signAccessToken({ id: courierUser.id, role: "courier" });

    const createResponse = await fetch(`${baseUrl}/api/doctor/prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        patientFullName: "Patient Test",
        patientDob: "1990-01-01",
        patientContact: "patient@example.com",
        meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
        allowedRefills: 2,
        expiryDate: "2026-04-01",
        allowSubstitution: false,
        controlledSubstance: false,
      }),
    });

    assert.equal(createResponse.status, 201);
    const createBody = await createResponse.json();
    assert.ok(createBody.prescription.id);
    assert.ok(createBody.linkCode);

    const linkResponse = await fetch(
      `${baseUrl}/api/patient/prescriptions/${createBody.prescription.id}/link`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${patientToken}`,
        },
        body: JSON.stringify({ code: createBody.linkCode }),
      }
    );
    assert.equal(linkResponse.status, 200);

    const orderResponse = await fetch(`${baseUrl}/api/patient/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        prescId: createBody.prescription.id,
        pharmacyId: pharmacyProfile.id,
        deliveryOption: "delivery",
        payment: { method: "wipay", amount: 3500, status: "confirmed" },
      }),
    });
    assert.equal(orderResponse.status, 201);
    const orderBody = await orderResponse.json();
    assert.ok(orderBody.order.id);

    const verifyResponse = await fetch(`${baseUrl}/api/pharmacy/verify-prescription`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pharmacyToken}`,
      },
      body: JSON.stringify({ prescId: createBody.prescription.id }),
    });
    assert.equal(verifyResponse.status, 200);
    const verifyBody = await verifyResponse.json();
    assert.equal(verifyBody.verified, true);

    const processingResponse = await fetch(
      `${baseUrl}/api/pharmacy/orders/${orderBody.order.id}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pharmacyToken}`,
        },
        body: JSON.stringify({ status: "processing" }),
      }
    );
    assert.equal(processingResponse.status, 200);

    const statusResponse = await fetch(
      `${baseUrl}/api/pharmacy/orders/${orderBody.order.id}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pharmacyToken}`,
        },
        body: JSON.stringify({ status: "ready" }),
      }
    );
    assert.equal(statusResponse.status, 200);
    const statusBody = await statusResponse.json();
    assert.equal(statusBody.order.orderStatus, "ready");

    const assignResponse = await fetch(`${baseUrl}/api/dispatch/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pharmacyToken}`,
      },
      body: JSON.stringify({ orderId: orderBody.order.id, courierId: courierUser.id }),
    });
    assert.equal(assignResponse.status, 200);

    const podResponse = await fetch(`${baseUrl}/api/dispatch/${orderBody.order.id}/pod`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${courierToken}`,
      },
      body: JSON.stringify({ method: "otp", proof: "123456" }),
    });
    assert.equal(podResponse.status, 200);
    const podBody = await podResponse.json();
    assert.equal(podBody.order.orderStatus, "completed");
  } finally {
    server.close();
  }
});

test("admin audit logs require admin role", async () => {
  if (!process.env.DATABASE_URL) {
    return;
  }
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const adminUser = await User.create({
      fullName: "Admin Test",
      role: "admin",
      passwordHash,
    });
    const patientUser = await User.create({
      fullName: "Patient Two",
      role: "patient",
      passwordHash,
    });

    await AuditLog.create({
      actorUserId: adminUser.id,
      action: "audit.test",
      entityType: "test",
      entityId: "123",
    });

    const adminToken = signAccessToken({ id: adminUser.id, role: "admin" });
    const patientToken = signAccessToken({ id: patientUser.id, role: "patient" });

    const forbidden = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${baseUrl}/api/admin/audit`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.total >= 1);
  } finally {
    server.close();
  }
});

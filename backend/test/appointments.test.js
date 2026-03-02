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

test("doctor availability -> patient booking -> doctor approval", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Appointments",
      role: "doctor",
      email: "dr.appt@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Book",
      role: "patient",
      email: "patient.book@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const slotRes = await fetch(`${baseUrl}/api/doctor/appointments/availability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        startAt: "2026-03-01T10:00:00.000Z",
        endAt: "2026-03-01T10:30:00.000Z",
        mode: "virtual",
        location: "Video Room 1",
        maxBookings: 2,
      }),
    });
    assert.equal(slotRes.status, 201);
    const slotBody = await slotRes.json();

    const listRes = await fetch(
      `${baseUrl}/api/patient/appointments/doctors/${doctor.id}/availability`,
      { headers: { Authorization: `Bearer ${patientToken}` } }
    );
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.availability.length, 1);

    const bookRes = await fetch(`${baseUrl}/api/patient/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        availabilityId: slotBody.availability.id,
        reason: "Follow-up",
      }),
    });
    assert.equal(bookRes.status, 201);
    const bookBody = await bookRes.json();
    assert.equal(bookBody.booking.status, "pending");

    const pendingRes = await fetch(`${baseUrl}/api/doctor/appointments/bookings?status=pending`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(pendingRes.status, 200);
    const pendingBody = await pendingRes.json();
    assert.equal(pendingBody.bookings.length, 1);
    assert.equal(pendingBody.bookings[0].reminder.default24h, true);

    const approveRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "approved" }),
      }
    );
    assert.equal(approveRes.status, 200);
    const approveBody = await approveRes.json();
    assert.equal(approveBody.booking.status, "approved");

    const reminderConfigRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/reminder-config`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({
          channel: "email",
          default24h: true,
          customAlertAt: "2026-02-28T10:00:00.000Z",
        }),
      }
    );
    assert.equal(reminderConfigRes.status, 200);
    const reminderConfigBody = await reminderConfigRes.json();
    assert.equal(reminderConfigBody.reminder.channel, "email");
    assert.equal(reminderConfigBody.reminder.default24h, true);
    assert.equal(reminderConfigBody.reminder.customAlertAt, "2026-02-28T10:00:00.000Z");

    const reminderSendRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/reminder-send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ kind: "manual", channel: "email" }),
      }
    );
    assert.equal(reminderSendRes.status, 200);
    const reminderSendBody = await reminderSendRes.json();
    assert.equal(reminderSendBody.reminder.channel, "email");
    assert.equal(Boolean(reminderSendBody.reminderSummary.lastSentAt), true);

    const completeRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "completed" }),
      }
    );
    assert.equal(completeRes.status, 200);
    const completeBody = await completeRes.json();
    assert.equal(completeBody.booking.status, "completed");
  } finally {
    server.close();
  }
});

test("doctor cannot mark pending booking as completed", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Transitions",
      role: "doctor",
      email: "dr.transitions@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Transition",
      role: "patient",
      email: "patient.transitions@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const slotRes = await fetch(`${baseUrl}/api/doctor/appointments/availability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        startAt: "2026-03-02T10:00:00.000Z",
        endAt: "2026-03-02T10:30:00.000Z",
        mode: "virtual",
        location: "Video Room 2",
        maxBookings: 1,
      }),
    });
    assert.equal(slotRes.status, 201);
    const slotBody = await slotRes.json();

    const bookRes = await fetch(`${baseUrl}/api/patient/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        availabilityId: slotBody.availability.id,
        reason: "Transition check",
      }),
    });
    assert.equal(bookRes.status, 201);
    const bookBody = await bookRes.json();
    assert.equal(bookBody.booking.status, "pending");

    const completeRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "completed" }),
      }
    );
    assert.equal(completeRes.status, 409);
    const completeBody = await completeRes.json();
    assert.match(completeBody.error, /approved/i);
  } finally {
    server.close();
  }
});

test("booking auto-triage tags and no_show transition are supported", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Triage",
      role: "doctor",
      email: "dr.triage@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Triage",
      role: "patient",
      email: "patient.triage@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const slotRes = await fetch(`${baseUrl}/api/doctor/appointments/availability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        startAt: "2026-04-01T10:00:00.000Z",
        endAt: "2026-04-01T10:30:00.000Z",
        mode: "in-person",
        location: "Clinic A",
        maxBookings: 1,
      }),
    });
    const slotBody = await slotRes.json();

    const bookRes = await fetch(`${baseUrl}/api/patient/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        availabilityId: slotBody.availability.id,
        reason: "Chest pain and medication refill",
      }),
    });
    assert.equal(bookRes.status, 201);
    const bookBody = await bookRes.json();
    assert.ok(Array.isArray(bookBody.booking.triageTags));
    assert.ok(bookBody.booking.triageTags.includes("urgent"));
    assert.ok(bookBody.booking.triageTags.includes("medication"));

    const approveRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "approved" }),
      }
    );
    assert.equal(approveRes.status, 200);

    const noShowRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookBody.booking.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "no_show" }),
      }
    );
    assert.equal(noShowRes.status, 200);
    const noShowBody = await noShowRes.json();
    assert.equal(noShowBody.booking.status, "no_show");
  } finally {
    server.close();
  }
});

test("doctor intelligence and waitlist auto-fill provide actionable output", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Intel",
      role: "doctor",
      email: "dr.intel@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Intel",
      role: "patient",
      email: "patient.intel@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const slotRes = await fetch(`${baseUrl}/api/doctor/appointments/availability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        startAt: "2026-05-01T10:00:00.000Z",
        endAt: "2026-05-01T10:30:00.000Z",
        mode: "in-person",
        location: "Clinic B",
        maxBookings: 2,
      }),
    });
    const slotBody = await slotRes.json();

    const waitlistRes = await fetch(`${baseUrl}/api/patient/appointments/waitlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        preferredDate: "2026-05-01",
        reason: "Follow-up refill",
      }),
    });
    assert.equal(waitlistRes.status, 201);

    const autoFillRes = await fetch(`${baseUrl}/api/doctor/appointments/waitlist/auto-fill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${doctorToken}`,
      },
    });
    assert.equal(autoFillRes.status, 200);
    const autoFillBody = await autoFillRes.json();
    assert.ok(autoFillBody.filledCount >= 1);

    const intelRes = await fetch(`${baseUrl}/api/doctor/appointments/intelligence`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(intelRes.status, 200);
    const intelBody = await intelRes.json();
    assert.ok(Array.isArray(intelBody.predictions));
    assert.ok(typeof intelBody.waitlistCount === "number");
  } finally {
    server.close();
  }
});

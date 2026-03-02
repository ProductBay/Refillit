const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

const { app } = require("../src/app");
const { truncateTables } = require("../src/db/memoryStore");
const { AppointmentAvailability, User } = require("../src/models");
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

test("receptionist arrival board transitions are enforced and tied to appointment state", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Reception Flow",
      role: "doctor",
      email: "dr.reception.flow@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Reception Flow",
      role: "patient",
      email: "patient.reception.flow@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const receptionist = await User.create({
      fullName: "Reception Flow User",
      role: "receptionist",
      email: "reception.flow@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const receptionistToken = signAccessToken({ id: receptionist.id, role: "receptionist" });
    const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const endAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const slot = await AppointmentAvailability.create({
      doctorId: doctor.id,
      startAt,
      endAt,
      mode: "in-person",
      maxBookings: 1,
      isActive: true,
    });

    const blockedBookRes = await fetch(`${baseUrl}/api/receptionist/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receptionistToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        patientId: patient.id,
        availabilityId: slot.id,
        reason: "Front desk scheduling",
      }),
    });
    assert.equal(blockedBookRes.status, 403);

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
        canViewPrivateNotes: false,
        canViewPrescriptions: false,
      }),
    });
    assert.equal(grantRes.status, 201);

    const bookRes = await fetch(`${baseUrl}/api/receptionist/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receptionistToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        patientId: patient.id,
        availabilityId: slot.id,
        reason: "Front desk scheduling",
      }),
    });
    assert.equal(bookRes.status, 201);
    const bookBody = await bookRes.json();
    assert.equal(bookBody.booking.patientId, patient.id);

    const appointmentsRes = await fetch(
      `${baseUrl}/api/receptionist/appointments?date=${encodeURIComponent(startAt.slice(0, 10))}`,
      {
        headers: { Authorization: `Bearer ${receptionistToken}` },
      }
    );
    assert.equal(appointmentsRes.status, 200);
    const appointmentsBody = await appointmentsRes.json();
    assert.equal(appointmentsBody.appointments.length, 1);

    const appointmentId = appointmentsBody.appointments[0].id;

    const arrivedRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${appointmentId}/arrival-status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({ status: "arrived", note: "Patient arrived at front desk." }),
      }
    );
    assert.equal(arrivedRes.status, 200);
    const arrivedBody = await arrivedRes.json();
    assert.equal(arrivedBody.appointment.arrivalStatus, "arrived");
    assert.equal(arrivedBody.appointment.status, "approved");

    const completedTooEarlyRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${appointmentId}/arrival-status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({ status: "waiting" }),
      }
    );
    assert.equal(completedTooEarlyRes.status, 400);

    const inRoomRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${appointmentId}/arrival-status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({ status: "in_room" }),
      }
    );
    assert.equal(inRoomRes.status, 200);
    const inRoomBody = await inRoomRes.json();
    assert.equal(inRoomBody.appointment.arrivalStatus, "in_room");

    const completeRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${appointmentId}/arrival-status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({ status: "completed" }),
      }
    );
    assert.equal(completeRes.status, 200);
    const completeBody = await completeRes.json();
    assert.equal(completeBody.appointment.arrivalStatus, "completed");
    assert.equal(completeBody.appointment.status, "completed");
  } finally {
    server.close();
  }
});

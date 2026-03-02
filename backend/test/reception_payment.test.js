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

test("doctor fee is reflected and receptionist can collect payment", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Fees",
      role: "doctor",
      email: "dr.fees@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Fees",
      role: "patient",
      email: "patient.fees@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const receptionist = await User.create({
      fullName: "Reception Fees",
      role: "receptionist",
      email: "reception.fees@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const receptionistToken = signAccessToken({ id: receptionist.id, role: "receptionist" });

    const slotStart = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const slotEnd = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const slotRes = await fetch(`${baseUrl}/api/doctor/appointments/availability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        startAt: slotStart,
        endAt: slotEnd,
        mode: "in-person",
        location: "Main clinic",
        maxBookings: 1,
        feeRequired: true,
        feeAmount: 4500,
        feeCurrency: "JMD",
      }),
    });
    assert.equal(slotRes.status, 201);
    const slotBody = await slotRes.json();

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
      }),
    });
    assert.equal(grantRes.status, 201);

    const bookingRes = await fetch(`${baseUrl}/api/receptionist/appointments/bookings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${receptionistToken}`,
      },
      body: JSON.stringify({
        doctorId: doctor.id,
        patientId: patient.id,
        availabilityId: slotBody.availability.id,
        reason: "Consultation",
      }),
    });
    assert.equal(bookingRes.status, 201);
    const bookingBody = await bookingRes.json();
    assert.equal(bookingBody.booking.feeRequired, true);
    assert.equal(Number(bookingBody.booking.feeAmount), 4500);
    assert.equal(bookingBody.booking.paymentStatus, "unpaid");
    assert.equal(Number(bookingBody.booking.nhfDeductionAmount || 0), 0);

    const visitChargeRes = await fetch(
      `${baseUrl}/api/doctor/appointments/bookings/${bookingBody.booking.id}/visit-charge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({
          consultationFee: 4500,
          additionalCharges: 0,
          nhfDeductionAmount: 0,
          feeCurrency: "JMD",
          markReadyForCollection: true,
          chargeNotes: "Visit finalized in room.",
        }),
      }
    );
    assert.equal(visitChargeRes.status, 200);

    const alertsBeforeRes = await fetch(`${baseUrl}/api/receptionist/billing-alerts`, {
      headers: { Authorization: `Bearer ${receptionistToken}` },
    });
    assert.equal(alertsBeforeRes.status, 200);
    const alertsBeforeBody = await alertsBeforeRes.json();
    assert.equal(Array.isArray(alertsBeforeBody.alerts), true);
    assert.equal(alertsBeforeBody.alerts.length, 1);

    const collectPartialRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${bookingBody.booking.id}/payment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({
          amount: 2000,
          method: "cash",
          nhfDeductionAmount: 500,
          nhfReference: "NHF-CLM-001",
          reference: "RCPT-001",
        }),
      }
    );
    assert.equal(collectPartialRes.status, 200);
    const partialBody = await collectPartialRes.json();
    assert.equal(partialBody.appointment.payment.status, "partial");
    assert.equal(Number(partialBody.appointment.payment.nhfDeductionAmount), 500);
    assert.equal(partialBody.appointment.payment.nhfReference, "NHF-CLM-001");
    assert.equal(Number(partialBody.appointment.payment.balanceAmount), 2000);
    assert.ok(partialBody.receipt?.receiptNumber);
    assert.equal(partialBody.receipt?.appointment?.id, bookingBody.booking.id);
    assert.equal(partialBody.receipt?.appointment?.doctorId, doctor.id);
    assert.equal(partialBody.receipt?.receptionist?.id, receptionist.id);
    assert.equal(Number(partialBody.receipt?.appointment?.nhfDeductionAmount), 500);

    const collectFinalRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${bookingBody.booking.id}/payment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${receptionistToken}`,
        },
        body: JSON.stringify({
          amount: 2000,
          method: "card",
          reference: "RCPT-002",
        }),
      }
    );
    assert.equal(collectFinalRes.status, 200);
    const finalBody = await collectFinalRes.json();
    assert.equal(finalBody.appointment.payment.status, "paid");
    assert.equal(Number(finalBody.appointment.payment.balanceAmount), 0);

    const receiptRes = await fetch(
      `${baseUrl}/api/receptionist/appointments/${bookingBody.booking.id}/payment-receipt`,
      {
        headers: { Authorization: `Bearer ${receptionistToken}` },
      }
    );
    assert.equal(receiptRes.status, 200);
    const receiptBody = await receiptRes.json();
    assert.equal(receiptBody.receipt?.appointment?.id, bookingBody.booking.id);
    assert.equal(receiptBody.receipt?.doctor?.id, doctor.id);
    assert.equal(receiptBody.receipt?.receptionist?.id, receptionist.id);

    const summaryRes = await fetch(`${baseUrl}/api/receptionist/cashier-summary`, {
      headers: { Authorization: `Bearer ${receptionistToken}` },
    });
    assert.equal(summaryRes.status, 200);
    const summaryBody = await summaryRes.json();
    assert.equal(Number(summaryBody.summary?.cashTotal), 2000);
    assert.equal(Number(summaryBody.summary?.cardTotal), 2000);
    assert.equal(Number(summaryBody.summary?.totalCollected), 4000);

    const kpiRes = await fetch(`${baseUrl}/api/doctor/kpi`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(kpiRes.status, 200);
    const kpiBody = await kpiRes.json();
    assert.equal(Number(kpiBody.kpi?.paymentsCollectedToday), 4000);
    assert.equal(Number(kpiBody.kpi?.paymentTransactionsToday), 2);

    const alertsAfterRes = await fetch(`${baseUrl}/api/receptionist/billing-alerts`, {
      headers: { Authorization: `Bearer ${receptionistToken}` },
    });
    assert.equal(alertsAfterRes.status, 200);
    const alertsAfterBody = await alertsAfterRes.json();
    assert.equal(alertsAfterBody.alerts.length, 0);
  } finally {
    server.close();
  }
});

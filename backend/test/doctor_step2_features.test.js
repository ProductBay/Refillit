const assert = require("node:assert/strict");
const http = require("node:http");
const { beforeEach, test } = require("node:test");

const { app } = require("../src/app");
const { truncateTables } = require("../src/db/memoryStore");
const {
  User,
  CareInstructionBroadcast,
  Prescription,
  RefillRequest,
} = require("../src/models");
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

test("SOAP notes can be signed once and then locked", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr SOAP",
      role: "doctor",
      email: "dr.soap@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient SOAP",
      role: "patient",
      email: "patient.soap@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const createRes = await fetch(`${baseUrl}/api/doctor/soap-notes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        subjective: "Headache x2 days",
        objective: "BP 130/80",
        assessment: "Likely tension headache",
        plan: "Hydration and PRN analgesic",
      }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    const noteId = createBody.note.id;

    const signRes = await fetch(`${baseUrl}/api/doctor/soap-notes/${noteId}/sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ signature: "Dr SOAP" }),
    });
    assert.equal(signRes.status, 200);
    const signBody = await signRes.json();
    assert.equal(signBody.note.locked, true);
    assert.equal(Boolean(signBody.note.signedAt), true);

    const signAgainRes = await fetch(`${baseUrl}/api/doctor/soap-notes/${noteId}/sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({ signature: "Dr SOAP" }),
    });
    assert.equal(signAgainRes.status, 409);
  } finally {
    server.close();
  }
});

test("objective assist derives factual clinical context from subjective keywords", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Objective",
      role: "doctor",
      email: "dr.objective@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const res = await fetch(`${baseUrl}/api/doctor/soap-notes/objective-assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        subjective:
          "Patient reports chest tightness and shortness of breath for 3 days, worsening at night, denies fever.",
        diagnosis: "Asthma exacerbation",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.objectiveAssist);
    assert.ok(body.objectiveAssist.objectiveText.includes("patient-reported"));
    assert.ok((body.objectiveAssist.detectedKeywords || []).length >= 2);
    assert.ok((body.objectiveAssist.recommendedVitals || []).includes("SpO2"));
    assert.ok((body.objectiveAssist.deniedSymptoms || []).some((item) => item.includes("fever")));
    assert.ok(Number(body.objectiveAssist.confidence || 0) >= 0.5);
  } finally {
    server.close();
  }
});

test("assessment assist generates differential and safety flags", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Assessment",
      role: "doctor",
      email: "dr.assessment@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const res = await fetch(`${baseUrl}/api/doctor/soap-notes/assessment-assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        subjective: "Chest tightness and shortness of breath for 2 days, worse at night.",
        objective: "SpO2 96%, mild wheeze on exam.",
        diagnosis: "Asthma",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.assessmentAssist);
    assert.ok(String(body.assessmentAssist.assessmentText || "").length > 30);
    assert.ok((body.assessmentAssist.differentials || []).length >= 1);
    assert.ok((body.assessmentAssist.safetyFlags || []).length >= 1);
    assert.ok((body.assessmentAssist.detectedObjectiveIssues || []).length >= 1);
    assert.ok(Number(body.assessmentAssist.confidence || 0) >= 0.5);
  } finally {
    server.close();
  }
});

test("plan assist summarizes treatment and follow-up from assessment context", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Plan",
      role: "doctor",
      email: "dr.plan@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const res = await fetch(`${baseUrl}/api/doctor/soap-notes/plan-assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        subjective: "Shortness of breath and chest tightness for 2 days.",
        objective: "SpO2 93%, HR 112, mild wheeze on auscultation.",
        assessment: "Probable asthma/reactive airway exacerbation.",
        diagnosis: "Asthma",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.planAssist);
    assert.ok(String(body.planAssist.planText || "").length > 40);
    assert.ok((body.planAssist.actions || []).length >= 1);
    assert.ok(String(body.planAssist.followUp || "").length > 0);
    assert.ok((body.planAssist.redFlags || []).length >= 1);
    assert.ok(Number(body.planAssist.confidence || 0) >= 0.5);
  } finally {
    server.close();
  }
});

test("assessment/plan assist detect trauma and routine checkup presentations", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr RealWorld",
      role: "doctor",
      email: "dr.realworld@example.com",
      passwordHash,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });

    const traumaAssessRes = await fetch(`${baseUrl}/api/doctor/soap-notes/assessment-assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        subjective: "Patient fell and reports possible broken arm with severe pain 9/10.",
        objective: "Visible swelling and deformity of forearm, reduced ROM.",
      }),
    });
    assert.equal(traumaAssessRes.status, 200);
    const traumaAssessBody = await traumaAssessRes.json();
    assert.ok((traumaAssessBody.assessmentAssist?.riskLevel || "") === "high");
    assert.ok(
      (traumaAssessBody.assessmentAssist?.detectedObjectiveIssues || []).some((entry) =>
        String(entry.label || "").toLowerCase().includes("musculoskeletal")
      )
    );

    const checkupPlanRes = await fetch(`${baseUrl}/api/doctor/soap-notes/plan-assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        subjective: "Regular checkup and wellness visit, no acute complaints.",
        objective: "Preventive exam completed, health maintenance reviewed.",
        assessment: "Routine preventive maintenance encounter.",
      }),
    });
    assert.equal(checkupPlanRes.status, 200);
    const checkupPlanBody = await checkupPlanRes.json();
    assert.ok(
      String(checkupPlanBody.planAssist?.planText || "").toLowerCase().includes("preventive")
    );
  } finally {
    server.close();
  }
});

test("broadcast instructions support patient read receipt and escalation", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Broadcast",
      role: "doctor",
      email: "dr.broadcast@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Broadcast",
      role: "patient",
      email: "patient.broadcast@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const sendRes = await fetch(`${baseUrl}/api/doctor/instructions/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        cohort: "all",
        language: "en",
        text: "Please complete your follow-up blood tests.",
      }),
    });
    assert.equal(sendRes.status, 201);
    const sendBody = await sendRes.json();
    assert.equal(sendBody.sent, 1);

    const allBroadcasts = await CareInstructionBroadcast.findAll({});
    assert.equal(allBroadcasts.length, 1);
    const broadcast = allBroadcasts[0];
    broadcast.deliveredAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await broadcast.save();

    const doctorListRes = await fetch(`${baseUrl}/api/doctor/instructions/broadcasts`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(doctorListRes.status, 200);
    const doctorListBody = await doctorListRes.json();
    assert.ok(doctorListBody.broadcasts[0].escalationLevel >= 1);

    const patientListRes = await fetch(`${baseUrl}/api/patient/instructions`, {
      headers: { Authorization: `Bearer ${patientToken}` },
    });
    assert.equal(patientListRes.status, 200);
    const patientListBody = await patientListRes.json();
    assert.equal(patientListBody.broadcasts.length, 1);

    const readRes = await fetch(
      `${baseUrl}/api/patient/instructions/${patientListBody.broadcasts[0].id}/read`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${patientToken}`,
        },
      }
    );
    assert.equal(readRes.status, 200);
    const readBody = await readRes.json();
    assert.equal(Boolean(readBody.broadcast.readAt), true);
  } finally {
    server.close();
  }
});

test("referral, consent expiry, refill workflow, and audit trail are linked to patient", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const passwordHash = await hashPassword("ChangeMe123!");
    const doctor = await User.create({
      fullName: "Dr Coordination",
      role: "doctor",
      email: "dr.coordination@example.com",
      passwordHash,
    });
    const patient = await User.create({
      fullName: "Patient Coordination",
      role: "patient",
      email: "patient.coordination@example.com",
      passwordHash,
      createdByDoctorId: doctor.id,
    });
    const prescription = await Prescription.create({
      doctorId: doctor.id,
      patientId: patient.id,
      meds: [{ ndcCode: "M001", name: "Amlodipine", strength: "5mg", qty: 30 }],
      allowedRefills: 1,
      linkCode: "STEP2",
      linked: true,
    });

    const doctorToken = signAccessToken({ id: doctor.id, role: "doctor" });
    const patientToken = signAccessToken({ id: patient.id, role: "patient" });

    const referralRes = await fetch(`${baseUrl}/api/doctor/referrals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        patientId: patient.id,
        referralType: "lab",
        targetName: "Central Lab",
        reason: "HbA1c and lipid panel",
        priority: "routine",
      }),
    });
    assert.equal(referralRes.status, 201);

    const consentRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/consents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctorToken}`,
      },
      body: JSON.stringify({
        consentType: "lab_release",
        expiresAt: "2020-01-01",
      }),
    });
    assert.equal(consentRes.status, 201);

    const consentListRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/consents`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(consentListRes.status, 200);
    const consentListBody = await consentListRes.json();
    assert.equal(consentListBody.consents[0].status, "expired");

    const refillReqRes = await fetch(`${baseUrl}/api/patient/refill-requests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${patientToken}`,
      },
      body: JSON.stringify({
        prescId: prescription.id,
        doctorId: doctor.id,
        reason: "Medication almost finished",
      }),
    });
    assert.equal(refillReqRes.status, 201);
    const refillReqBody = await refillReqRes.json();

    const decisionRes = await fetch(
      `${baseUrl}/api/doctor/refill-requests/${refillReqBody.request.id}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${doctorToken}`,
        },
        body: JSON.stringify({ decision: "approved" }),
      }
    );
    assert.equal(decisionRes.status, 200);

    const auditRes = await fetch(`${baseUrl}/api/doctor/patients/${patient.id}/audit`, {
      headers: { Authorization: `Bearer ${doctorToken}` },
    });
    assert.equal(auditRes.status, 200);
    const auditBody = await auditRes.json();
    const actions = auditBody.audit.map((entry) => entry.action);
    assert.ok(actions.includes("doctor.referral.create"));
    assert.ok(actions.includes("doctor.consent.create"));
    assert.ok(actions.includes("doctor.refill_request.decision"));
  } finally {
    server.close();
  }
});

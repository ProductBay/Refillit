const doctorEmail = "doctor@refillit.dev";
const patientEmail = "patient@refillit.dev";
const password = "Refillit123!";
const api = "http://localhost:4000";
const wsBase = "ws://localhost:4000/ws/chat";

const fetchJson = async (url, opts) => {
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((data && data.error) || res.statusText);
  }
  return data;
};

const run = async () => {
  const doctor = await fetchJson(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: doctorEmail, password }),
  });

  const patient = await fetchJson(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: patientEmail, password }),
  });

  const thread = await fetchJson(`${api}/api/chat/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${doctor.token}`,
    },
    body: JSON.stringify({ patientId: patient.user.id }),
  });

  const ws = new (require("ws"))(
    `${wsBase}?token=${encodeURIComponent(patient.token)}`
  );

  const timeout = setTimeout(() => {
    console.error("No realtime message received");
    ws.close();
    process.exit(1);
  }, 5000);

  ws.on("open", async () => {
    await fetchJson(`${api}/api/chat/threads/${thread.thread.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${doctor.token}`,
      },
      body: JSON.stringify({ message: "Hello from doctor" }),
    });
  });

  ws.on("message", (raw) => {
    const payload = JSON.parse(String(raw));
    if (payload.type === "message") {
      console.log("Realtime message received:", payload.message.message);
      clearTimeout(timeout);
      ws.close();
      process.exit(0);
    }
  });
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

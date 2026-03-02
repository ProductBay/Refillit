const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

process.env.JWT_SECRET = "test_secret";
process.env.AUTH_LOOKUP_DB = "false";

const { app } = require("../src/app");
const { signAccessToken } = require("../src/utils/jwt");

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

test("Ops can set courier availability and courier sees it", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const adminToken = signAccessToken({ id: "admin-test", role: "admin" });
    const courierId = "ops-test-courier-1";

    // Ops sets courier offline
    const respSet = await fetch(`${baseUrl}/api/dispatch/couriers/${encodeURIComponent(courierId)}/availability`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ online: false }),
    });
    assert.equal(respSet.status, 200);
    const bodySet = await respSet.json();
    assert.equal(bodySet.courierId, courierId);
    assert.equal(bodySet.online, false);

    // Courier can read their own availability
    const courierToken = signAccessToken({ id: courierId, role: "courier" });
    const respGet = await fetch(`${baseUrl}/api/dispatch/courier-availability/me`, {
      headers: { Authorization: `Bearer ${courierToken}` },
    });
    assert.equal(respGet.status, 200);
    const bodyGet = await respGet.json();
    assert.equal(bodyGet.courierId, courierId);
    assert.equal(bodyGet.online, false);
    assert.equal(bodyGet.updatedBy, "admin-test");
  } finally {
    server.close();
  }
});

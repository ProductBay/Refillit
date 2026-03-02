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

test("GET /api/auth/me rejects missing token", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/auth/me`);
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("GET /api/auth/me accepts valid role", async () => {
  const { server, baseUrl } = await startServer();
  try {
    const token = signAccessToken({ id: "test-user", role: "patient" });
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.id, "test-user");
    assert.equal(body.user.role, "patient");
  } finally {
    server.close();
  }
});

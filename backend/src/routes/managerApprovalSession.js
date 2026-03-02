const { randomBytes, randomUUID } = require("node:crypto");

const sessions = new Map();
const failedLogins = new Map();

function nowMs() {
  return Date.now();
}

function ttlMs() {
  const value = Number(process.env.CASHIER_MANAGER_SESSION_TTL_MS || 10 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 10 * 60 * 1000;
}

function lockoutMs() {
  const value = Number(process.env.CASHIER_MANAGER_LOCKOUT_MS || 5 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 5 * 60 * 1000;
}

function maxAttempts() {
  const value = Number(process.env.CASHIER_MANAGER_MAX_LOGIN_ATTEMPTS || 5);
  return Number.isFinite(value) && value > 0 ? value : 5;
}

function maxApprovalsCap() {
  const value = Number(process.env.CASHIER_MANAGER_MAX_APPROVALS_CAP || 50);
  return Number.isFinite(value) && value > 0 ? value : 50;
}

function cleanupExpiredSessions() {
  const current = nowMs();
  for (const [token, session] of sessions.entries()) {
    const expiresAtMs = new Date(session.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= current) {
      sessions.delete(token);
    }
  }
}

function cleanupFailedLogins() {
  const current = nowMs();
  for (const [key, state] of failedLogins.entries()) {
    const lockUntilMs = Number(state.lockUntilMs || 0);
    const lastAttemptMs = Number(state.lastAttemptMs || 0);
    const staleWindow = lockoutMs() * 2;
    if (lockUntilMs && lockUntilMs <= current && current - lastAttemptMs > staleWindow) {
      failedLogins.delete(key);
    }
  }
}

function normalizeScope(scope) {
  const value = String(scope || "reusable").trim().toLowerCase();
  if (value === "single_use") return "single_use";
  return "reusable";
}

function normalizeMaxApprovals(value, scope) {
  if (scope === "single_use") return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(Math.floor(parsed), maxApprovalsCap());
}

function createManagerSession({ managerId, managerName, role, approvalScope, maxApprovals }) {
  cleanupExpiredSessions();
  cleanupFailedLogins();
  const token = randomBytes(24).toString("hex");
  const scope = normalizeScope(approvalScope);
  const limit = normalizeMaxApprovals(maxApprovals, scope);
  const expiresAt = new Date(nowMs() + ttlMs()).toISOString();
  const session = {
    token,
    sessionId: randomUUID(),
    managerId: String(managerId || "").trim() || "MGR-1",
    managerName: String(managerName || "").trim() || "Manager",
    role: String(role || "").trim() || "manager",
    approvalScope: scope,
    maxApprovals: limit,
    approvalsUsed: 0,
    approvalsRemaining: limit,
    issuedAt: new Date().toISOString(),
    expiresAt,
  };
  sessions.set(token, session);
  return session;
}

function loginManagerSession({ username, password, approvalScope, maxApprovals }) {
  cleanupFailedLogins();
  const expectedUsername = String(process.env.CASHIER_MANAGER_USERNAME || "manager").trim();
  const expectedPassword = String(process.env.CASHIER_MANAGER_PASSWORD || "manager123").trim();
  const inputUsername = String(username || "").trim();
  const inputPassword = String(password || "").trim();
  if (!inputUsername || !inputPassword) {
    return { ok: false, status: 401, message: "Username and password are required." };
  }

  const key = inputUsername.toLowerCase();
  const attemptState = failedLogins.get(key) || {
    count: 0,
    lockUntilMs: 0,
    lastAttemptMs: 0,
  };
  const current = nowMs();
  if (attemptState.lockUntilMs && attemptState.lockUntilMs > current) {
    return {
      ok: false,
      status: 423,
      message: "Manager login is temporarily locked. Try again later.",
      retryAfterMs: attemptState.lockUntilMs - current,
    };
  }

  if (inputUsername !== expectedUsername || inputPassword !== expectedPassword) {
    const nextCount = Number(attemptState.count || 0) + 1;
    const shouldLock = nextCount >= maxAttempts();
    failedLogins.set(key, {
      count: shouldLock ? 0 : nextCount,
      lockUntilMs: shouldLock ? current + lockoutMs() : 0,
      lastAttemptMs: current,
    });
    return {
      ok: false,
      status: shouldLock ? 423 : 401,
      message: shouldLock
        ? "Too many failed attempts. Manager login locked temporarily."
        : "Invalid manager credentials.",
      retryAfterMs: shouldLock ? lockoutMs() : 0,
    };
  }

  const role = String(process.env.CASHIER_MANAGER_ROLE || "manager").trim().toLowerCase();
  const allowedRoles = new Set(["manager", "admin"]);
  if (!allowedRoles.has(role)) {
    return { ok: false, status: 403, message: "Manager role is not allowed." };
  }

  failedLogins.delete(key);

  return {
    ok: true,
    session: createManagerSession({
      managerId: String(process.env.CASHIER_MANAGER_ID || "MGR-1"),
      managerName: String(process.env.CASHIER_MANAGER_NAME || "Floor Manager"),
      role,
      approvalScope,
      maxApprovals,
    }),
  };
}

function validateManagerSessionToken(token) {
  cleanupExpiredSessions();
  const key = String(token || "").trim();
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  const expiresAtMs = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) {
    sessions.delete(key);
    return null;
  }
  if (Number(session.approvalsRemaining || 0) <= 0) {
    return null;
  }
  return session;
}

function revokeManagerSession(token) {
  const key = String(token || "").trim();
  if (!key) return false;
  return sessions.delete(key);
}

function getManagerSession(token) {
  cleanupExpiredSessions();
  const key = String(token || "").trim();
  if (!key) return null;
  const session = sessions.get(key);
  if (!session) return null;
  const expiresAtMs = new Date(session.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs()) {
    sessions.delete(key);
    return null;
  }
  return session;
}

function consumeManagerApprovalSessionToken(token) {
  const session = validateManagerSessionToken(token);
  if (!session) return null;
  const used = Number(session.approvalsUsed || 0) + 1;
  const remaining = Math.max(0, Number(session.maxApprovals || 1) - used);
  const updated = {
    ...session,
    approvalsUsed: used,
    approvalsRemaining: remaining,
  };
  sessions.set(session.token, updated);
  return updated;
}

module.exports = {
  consumeManagerApprovalSessionToken,
  loginManagerSession,
  validateManagerSessionToken,
  revokeManagerSession,
  getManagerSession,
};

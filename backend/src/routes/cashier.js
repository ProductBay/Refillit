const express = require("express");
const { randomUUID } = require("node:crypto");
const { AuditLog } = require("../models");
const {
  consumeManagerApprovalSessionToken,
  getManagerSession,
  loginManagerSession,
  revokeManagerSession,
} = require("./managerApprovalSession");
const {
  applyCashierAction,
  DEFAULT_STATUS,
  filterOrdersByDateRange,
  findCashierOrderById,
  findCashierOrderByTicket,
  listCashierOrders,
  normalizeStatus,
  summarizeCashierOrders,
  validateVoidOverride,
} = require("./cashierOrderStore");

const router = express.Router();

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTs(value) {
  const date = new Date(value);
  const ts = date.getTime();
  return Number.isNaN(ts) ? null : ts;
}

function isWithinRange(value, fromTs, toTsValue) {
  const ts = toTs(value);
  if (!ts) return false;
  if (fromTs && ts < fromTs) return false;
  if (toTsValue && ts > toTsValue) return false;
  return true;
}

async function listShiftLogs() {
  const rows = await AuditLog.findAll({});
  return rows.filter((entry) => entry?.payload?.type === "cashier_shift");
}

function toShiftRecord(row) {
  if (!row?.payload || typeof row.payload !== "object") return null;
  return {
    ...row.payload,
    id: row.id,
  };
}

async function findShiftById(shiftId) {
  const all = await listShiftLogs();
  const target = normalizeText(shiftId).toLowerCase();
  const found = all.find((entry) => normalizeText(entry?.payload?.shiftId).toLowerCase() === target);
  return found || null;
}

function orderPaidInsideShift(order, shift) {
  const events = Array.isArray(order?.auditTrail) ? order.auditTrail : [];
  const shiftId = normalizeText(shift?.shiftId);
  const fromTs = toTs(shift.openedAt);
  const toTsValue = toTs(shift.closedAt || new Date().toISOString());
  for (const evt of events) {
    if (normalizeText(evt?.action).toLowerCase() !== "mark_paid") continue;
    const evtShiftId = normalizeText(evt?.shiftId);
    if (shiftId && evtShiftId && evtShiftId === shiftId) return true;
    const ts = toTs(evt.timestamp);
    if (!ts) continue;
    if (fromTs && ts < fromTs) continue;
    if (toTsValue && ts > toTsValue) continue;
    return true;
  }
  return false;
}

async function computeShiftExpectedCash(shift) {
  const orders = await listCashierOrders();
  const paidOrders = orders.filter((order) => orderPaidInsideShift(order, shift));
  const paidTotal = paidOrders.reduce((sum, order) => sum + normalizeAmount(order?.grandTotal), 0);
  return {
    paidOrderCount: paidOrders.length,
    paidTotal,
    expectedDrawerTotal: normalizeAmount(shift.openingFloat) + paidTotal,
  };
}

router.get("/queue", async (req, res, next) => {
  try {
    const rawStatus = String(req.query.status || DEFAULT_STATUS).trim().toLowerCase();
    const status = rawStatus === "all" ? "all" : normalizeStatus(rawStatus);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 1000);
    const rows = filterOrdersByDateRange(await listCashierOrders(), {
      from: req.query.from,
      to: req.query.to,
    });
    const filtered =
      status === "all"
        ? rows
        : rows.filter((entry) => normalizeStatus(entry.status) === status);
    return res.json({ orders: filtered.slice(0, limit) });
  } catch (error) {
    return next(error);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const summary = await summarizeCashierOrders({
      from: req.query.from,
      to: req.query.to,
    });
    return res.json(summary);
  } catch (error) {
    return next(error);
  }
});

router.post("/manager-approval/login", async (req, res) => {
  const result = loginManagerSession({
    username: req.body?.username,
    password: req.body?.password,
    approvalScope: req.body?.approvalScope,
    maxApprovals: req.body?.maxApprovals,
  });
  if (!result?.ok) {
    return res.status(result?.status || 401).json({
      message: result?.message || "Invalid manager credentials.",
      retryAfterMs: Number(result?.retryAfterMs || 0),
    });
  }
  return res.json({ session: result.session });
});

router.post("/manager-approval/logout", async (req, res) => {
  const token = normalizeText(req.body?.token);
  if (!token) return res.status(400).json({ message: "Token is required." });
  const revoked = revokeManagerSession(token);
  return res.json({ ok: revoked });
});

router.get("/manager-approval/session", async (req, res) => {
  const token = normalizeText(req.query?.token || req.headers?.["x-manager-session-token"]);
  if (!token) return res.status(400).json({ message: "Token is required." });
  const session = getManagerSession(token);
  if (!session) return res.status(404).json({ message: "Session not found or expired." });
  return res.json({ session });
});

router.get("/overrides", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    const cashierId = normalizeText(req.query.cashierId).toLowerCase();
    const managerId = normalizeText(req.query.managerId).toLowerCase();
    const fromTs = req.query.from ? toTs(req.query.from) : null;
    const toTsValue = req.query.to ? toTs(req.query.to) : null;

    const orders = await listCashierOrders();
    const events = [];
    for (const order of orders) {
      const trail = Array.isArray(order?.auditTrail) ? order.auditTrail : [];
      for (const evt of trail) {
        const isOverride =
          normalizeText(evt?.action).toLowerCase() === "void_manager_override" ||
          Boolean(evt?.overrideValidated);
        if (!isOverride) continue;
        if (!isWithinRange(evt?.timestamp, fromTs, toTsValue)) continue;
        if (cashierId && normalizeText(evt?.actorId).toLowerCase() !== cashierId) continue;
        if (managerId && normalizeText(evt?.overrideManagerId).toLowerCase() !== managerId) continue;
        events.push({
          timestamp: evt.timestamp,
          orderId: order.orderId,
          ticketNumber: order.ticketNumber,
          cashierId: evt.actorId || "",
          cashierName: evt.actorName || "",
          managerId: evt.overrideManagerId || "",
          managerName: evt.overrideManagerName || "",
          note: evt.note || "",
          shiftId: evt.shiftId || "",
          statusFrom: evt.statusFrom || "",
          statusTo: evt.statusTo || "",
        });
      }
    }
    events.sort((a, b) => (toTs(b.timestamp) || 0) - (toTs(a.timestamp) || 0));
    return res.json({ events: events.slice(0, limit) });
  } catch (error) {
    return next(error);
  }
});

router.get("/shifts/current", async (req, res, next) => {
  try {
    const cashierId = normalizeText(req.query.cashierId);
    const shifts = (await listShiftLogs())
      .map((entry) => toShiftRecord(entry))
      .filter(Boolean)
      .filter((entry) => entry.status === "open")
      .filter((entry) => (cashierId ? normalizeText(entry.cashierId) === cashierId : true))
      .sort((a, b) => (toTs(b.openedAt) || 0) - (toTs(a.openedAt) || 0));
    const current = shifts[0] || null;
    if (!current) return res.json({ shift: null });
    const expected = await computeShiftExpectedCash(current);
    return res.json({
      shift: {
        ...current,
        expected,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/shifts/open", async (req, res, next) => {
  try {
    const cashierId = normalizeText(req.body?.cashierId) || "unknown";
    const cashierName = normalizeText(req.body?.cashierName) || "Unknown Cashier";
    const openingFloat = normalizeAmount(req.body?.openingFloat);
    const now = new Date().toISOString();

    const current = (await listShiftLogs())
      .map((entry) => toShiftRecord(entry))
      .filter(Boolean)
      .find(
        (entry) =>
          entry.status === "open" &&
          normalizeText(entry.cashierId).toLowerCase() === cashierId.toLowerCase()
      );
    if (current) {
      return res.status(409).json({ message: "An open shift already exists for this cashier.", shift: current });
    }

    const shift = {
      type: "cashier_shift",
      shiftId: randomUUID(),
      cashierId,
      cashierName,
      openingFloat,
      openedAt: now,
      status: "open",
      openedBy: {
        id: normalizeText(req.body?.actorId) || cashierId,
        name: normalizeText(req.body?.actorName) || cashierName,
      },
      closeout: null,
    };
    const created = await AuditLog.create({ payload: shift });
    return res.status(201).json({ shift: toShiftRecord(created) });
  } catch (error) {
    return next(error);
  }
});

router.post("/shifts/:id/close", async (req, res, next) => {
  try {
    const found = await findShiftById(req.params.id);
    if (!found) return res.status(404).json({ message: "Shift not found." });
    const shift = toShiftRecord(found);
    if (!shift || shift.status !== "open") {
      return res.status(409).json({ message: "Shift is already closed." });
    }

    const expected = await computeShiftExpectedCash(shift);
    const closingCashCount = normalizeAmount(req.body?.closingCashCount);
    const closedAt = new Date().toISOString();
    const variance = closingCashCount - expected.expectedDrawerTotal;

    found.payload = {
      ...shift,
      status: "closed",
      closedAt,
      closeout: {
        closingCashCount,
        paidOrderCount: expected.paidOrderCount,
        paidTotal: expected.paidTotal,
        expectedDrawerTotal: expected.expectedDrawerTotal,
        variance,
        note: normalizeText(req.body?.note),
        closedBy: {
          id: normalizeText(req.body?.actorId) || normalizeText(req.body?.cashierId) || shift.cashierId,
          name: normalizeText(req.body?.actorName) || normalizeText(req.body?.cashierName) || shift.cashierName,
        },
      },
    };
    await found.save();
    return res.json({
      shift: toShiftRecord(found),
      report: found.payload.closeout,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/shifts/report", async (req, res, next) => {
  try {
    const fromTs = req.query.from ? toTs(req.query.from) : null;
    const toTsValue = req.query.to ? toTs(req.query.to) : null;
    const cashierId = normalizeText(req.query.cashierId);
    const shifts = (await listShiftLogs())
      .map((entry) => toShiftRecord(entry))
      .filter(Boolean)
      .filter((entry) => (cashierId ? normalizeText(entry.cashierId) === cashierId : true))
      .filter((entry) => {
        const openedTs = toTs(entry.openedAt);
        if (!openedTs) return false;
        if (fromTs && openedTs < fromTs) return false;
        if (toTsValue && openedTs > toTsValue) return false;
        return true;
      })
      .sort((a, b) => (toTs(b.openedAt) || 0) - (toTs(a.openedAt) || 0));

    const totals = shifts.reduce(
      (acc, entry) => {
        const closeout = entry.closeout || {};
        acc.openingFloat += normalizeAmount(entry.openingFloat);
        acc.expectedDrawerTotal += normalizeAmount(closeout.expectedDrawerTotal);
        acc.closingCashCount += normalizeAmount(closeout.closingCashCount);
        acc.variance += normalizeAmount(closeout.variance);
        if (entry.status === "closed") acc.closedCount += 1;
        return acc;
      },
      {
        openingFloat: 0,
        expectedDrawerTotal: 0,
        closingCashCount: 0,
        variance: 0,
        closedCount: 0,
      }
    );
    return res.json({
      shifts,
      totals: {
        ...totals,
        totalCount: shifts.length,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/order/:id", async (req, res, next) => {
  try {
    const order = await findCashierOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found." });
    return res.json({ order });
  } catch (error) {
    return next(error);
  }
});

router.get("/order/by-ticket/:ticket", async (req, res, next) => {
  try {
    const order = await findCashierOrderByTicket(req.params.ticket);
    if (!order) return res.status(404).json({ message: "Order not found." });
    return res.json({ order });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/:id/mark-paid", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      orderId: req.params.id,
      action: "mark_paid",
      payload: req.body,
      nextStatus: "paid",
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/:id/void", async (req, res, next) => {
  try {
    const override = validateVoidOverride(req.body || {});
    if (!override.ok) {
      return res.status(override.status).json({ message: override.message });
    }
    const managerSessionToken = normalizeText(req.body?.managerSessionToken);
    if (!managerSessionToken) {
      return res.status(401).json({ message: "Manager approval session token is required." });
    }
    const managerSession = consumeManagerApprovalSessionToken(managerSessionToken);
    if (!managerSession) {
      return res.status(403).json({ message: "Manager approval session is invalid, expired, or exhausted." });
    }
    const payload = {
      ...req.body,
      overrideManagerName: managerSession.managerName,
      overrideManagerId: managerSession.managerId,
      overrideValidated: true,
      overrideSessionId: managerSession.sessionId,
      overrideSessionExpiresAt: managerSession.expiresAt,
      overrideRole: managerSession.role,
      overrideApprovalsRemaining: Number(managerSession.approvalsRemaining || 0),
    };
    delete payload.overrideCode;
    const updated = await applyCashierAction({
      orderId: req.params.id,
      action: "void_manager_override",
      payload,
      nextStatus: "void",
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/:id/handoff-pos", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      orderId: req.params.id,
      action: "handoff_pos",
      payload: req.body,
      nextStatus: "pos_handoff",
      updater: (order) => {
        order.posAdapter = {
          key: String(req.body?.adapterKey || "generic_pos"),
          handedOffAt: new Date().toISOString(),
        };
      },
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/:id/retry-handoff", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      orderId: req.params.id,
      action: "retry_handoff",
      payload: req.body,
      nextStatus: "pos_handoff",
      updater: (order) => {
        const previous = order.posAdapter && typeof order.posAdapter === "object" ? order.posAdapter : {};
        const retries = Number(previous.retryCount || 0) + 1;
        order.posAdapter = {
          key: String(req.body?.adapterKey || previous.key || "generic_pos"),
          handedOffAt: previous.handedOffAt || new Date().toISOString(),
          retryCount: retries,
          lastRetryAt: new Date().toISOString(),
        };
      },
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/by-ticket/:ticket/mark-paid", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      ticketNumber: req.params.ticket,
      action: "mark_paid",
      payload: req.body,
      nextStatus: "paid",
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/by-ticket/:ticket/void", async (req, res, next) => {
  try {
    const override = validateVoidOverride(req.body || {});
    if (!override.ok) {
      return res.status(override.status).json({ message: override.message });
    }
    const managerSessionToken = normalizeText(req.body?.managerSessionToken);
    if (!managerSessionToken) {
      return res.status(401).json({ message: "Manager approval session token is required." });
    }
    const managerSession = consumeManagerApprovalSessionToken(managerSessionToken);
    if (!managerSession) {
      return res.status(403).json({ message: "Manager approval session is invalid, expired, or exhausted." });
    }
    const payload = {
      ...req.body,
      overrideManagerName: managerSession.managerName,
      overrideManagerId: managerSession.managerId,
      overrideValidated: true,
      overrideSessionId: managerSession.sessionId,
      overrideSessionExpiresAt: managerSession.expiresAt,
      overrideRole: managerSession.role,
      overrideApprovalsRemaining: Number(managerSession.approvalsRemaining || 0),
    };
    delete payload.overrideCode;
    const updated = await applyCashierAction({
      ticketNumber: req.params.ticket,
      action: "void_manager_override",
      payload,
      nextStatus: "void",
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

router.post("/orders/by-ticket/:ticket/handoff-pos", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      ticketNumber: req.params.ticket,
      action: "handoff_pos",
      payload: req.body,
      nextStatus: "pos_handoff",
      updater: (order) => {
        order.posAdapter = {
          key: String(req.body?.adapterKey || "generic_pos"),
          handedOffAt: new Date().toISOString(),
        };
      },
    });
    if (!updated) return res.status(404).json({ message: "Order not found." });
    return res.json({ order: updated });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;

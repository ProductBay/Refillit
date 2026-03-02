const express = require("express");
const {
  applyCashierAction,
  findCashierOrderById,
  findCashierOrderByTicket,
  fromRequestPayload,
  listCashierOrders,
  persistCashierOrder,
  normalizeStatus,
  validateVoidOverride,
} = require("./cashierOrderStore");
const { consumeManagerApprovalSessionToken } = require("./managerApprovalSession");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const payload = fromRequestPayload(req.body);
    const saved = await persistCashierOrder(payload);
    return res.status(201).json(saved);
  } catch (error) {
    return next(error);
  }
});

router.get("/by-ticket/:ticket", async (req, res, next) => {
  try {
    const order = await findCashierOrderByTicket(req.params.ticket);
    if (!order) return res.status(404).json({ message: "Order not found." });
    return res.json({ order });
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    if (req.query.id) {
      const byId = await findCashierOrderById(req.query.id);
      if (!byId) return res.status(404).json({ message: "Order not found." });
      return res.json({ order: byId });
    }

    if (req.query.ticket) {
      const byTicket = await findCashierOrderByTicket(req.query.ticket);
      if (!byTicket) return res.status(404).json({ message: "Order not found." });
      return res.json({ order: byTicket });
    }

    const status = req.query.status ? normalizeStatus(req.query.status) : "";
    const rows = await listCashierOrders();
    const filtered = status ? rows.filter((entry) => normalizeStatus(entry.status) === status) : rows;
    return res.json({ orders: filtered });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const order = await findCashierOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found." });
    return res.json({ order });
  } catch (error) {
    return next(error);
  }
});

router.post("/:id/mark-paid", async (req, res, next) => {
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

router.post("/:id/void", async (req, res, next) => {
  try {
    const override = validateVoidOverride(req.body || {});
    if (!override.ok) {
      return res.status(override.status).json({ message: override.message });
    }
    const managerSessionToken = String(req.body?.managerSessionToken || "").trim();
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

router.post("/:id/handoff-pos", async (req, res, next) => {
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

router.post("/:id/retry-handoff", async (req, res, next) => {
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

router.post("/by-ticket/:ticket/mark-paid", async (req, res, next) => {
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

router.post("/by-ticket/:ticket/void", async (req, res, next) => {
  try {
    const override = validateVoidOverride(req.body || {});
    if (!override.ok) {
      return res.status(override.status).json({ message: override.message });
    }
    const managerSessionToken = String(req.body?.managerSessionToken || "").trim();
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

router.post("/by-ticket/:ticket/handoff-pos", async (req, res, next) => {
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

router.post("/by-ticket/:ticket/retry-handoff", async (req, res, next) => {
  try {
    const updated = await applyCashierAction({
      ticketNumber: req.params.ticket,
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

module.exports = router;

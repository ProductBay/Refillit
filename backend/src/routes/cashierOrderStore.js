const { randomUUID } = require("node:crypto");
const { Order } = require("../models");

const DEFAULT_STATUS = "ready_for_checkout";

function nowIso() {
  return new Date().toISOString();
}

function toTimestamp(value) {
  const date = new Date(value);
  const ts = date.getTime();
  return Number.isNaN(ts) ? null : ts;
}

function normalizeValue(value) {
  return String(value || "").trim();
}

function normalizeStatus(status) {
  const value = normalizeValue(status).toLowerCase();
  return value || DEFAULT_STATUS;
}

function normalizeTicket(ticket) {
  const value = normalizeValue(ticket).toUpperCase();
  return value || `TKT-${Date.now()}`;
}

function buildAuditEvent({ action, payload, previousStatus, nextStatus }) {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    action: normalizeValue(action) || "unknown",
    source: normalizeValue(payload?.source) || "backend",
    actorName: normalizeValue(payload?.cashierName) || "Cashier",
    actorId: normalizeValue(payload?.cashierId),
    note: normalizeValue(payload?.note),
    statusFrom: normalizeValue(previousStatus),
    statusTo: normalizeValue(nextStatus),
    adapterKey: normalizeValue(payload?.adapterKey),
    shiftId: normalizeValue(payload?.shiftId),
    overrideValidated: Boolean(payload?.overrideValidated),
    overrideManagerName: normalizeValue(payload?.overrideManagerName),
    overrideManagerId: normalizeValue(payload?.overrideManagerId),
    overrideApprovalsRemaining: Number(payload?.overrideApprovalsRemaining || 0),
  };
}

function validateVoidOverride(payload) {
  const reason = normalizeValue(payload?.note);
  if (!reason) {
    return { ok: false, status: 400, message: "Void reason is required." };
  }
  return { ok: true };
}

function toCashierOrder(row) {
  if (!row) return null;
  const snapshot = row.prescriptionSnapshot && typeof row.prescriptionSnapshot === "object"
    ? row.prescriptionSnapshot
    : {};
  const embedded = snapshot.cashierOrder && typeof snapshot.cashierOrder === "object"
    ? snapshot.cashierOrder
    : null;

  if (embedded) {
    const merged = {
      ...embedded,
      orderId: normalizeValue(embedded.orderId || row.id) || row.id,
      id: normalizeValue(embedded.id || row.id) || row.id,
      status: normalizeStatus(embedded.status || row.orderStatus),
      ticketNumber: normalizeTicket(embedded.ticketNumber),
      createdAt: embedded.createdAt || row.createdAt || nowIso(),
      updatedAt: embedded.updatedAt || row.updatedAt || nowIso(),
      auditTrail: Array.isArray(embedded.auditTrail) ? embedded.auditTrail : [],
    };
    return merged;
  }

  if (row.ticketNumber || row.salesRep || row.customer || row.orderId) {
    return {
      ...row,
      orderId: normalizeValue(row.orderId || row.id) || row.id,
      id: normalizeValue(row.id || row.orderId) || row.orderId,
      status: normalizeStatus(row.status || row.orderStatus),
      ticketNumber: normalizeTicket(row.ticketNumber),
      createdAt: row.createdAt || nowIso(),
      updatedAt: row.updatedAt || nowIso(),
      auditTrail: Array.isArray(row.auditTrail) ? row.auditTrail : [],
    };
  }

  return null;
}

function fromRequestPayload(payload) {
  const base = payload && typeof payload === "object" ? payload : {};
  const orderId = normalizeValue(base.orderId || base.id) || randomUUID();
  return {
    ...base,
    orderId,
    id: orderId,
    ticketNumber: normalizeTicket(base.ticketNumber),
    status: normalizeStatus(base.status),
    queueSource: normalizeValue(base.queueSource) || "backend",
    createdAt: base.createdAt || nowIso(),
    updatedAt: nowIso(),
    auditTrail: Array.isArray(base.auditTrail) ? base.auditTrail : [],
  };
}

async function persistCashierOrder(cashierOrder) {
  const existing = await Order.findByPk(cashierOrder.orderId);
  if (existing) {
    const snapshot = existing.prescriptionSnapshot && typeof existing.prescriptionSnapshot === "object"
      ? existing.prescriptionSnapshot
      : {};
    existing.orderStatus = cashierOrder.status;
    existing.payment = {
      ...(existing.payment && typeof existing.payment === "object" ? existing.payment : {}),
      grandTotal: Number(cashierOrder.grandTotal || 0),
    };
    existing.prescriptionSnapshot = {
      ...snapshot,
      cashierOrder,
    };
    await existing.save();
    return toCashierOrder(existing);
  }

  const created = await Order.create({
    id: cashierOrder.orderId,
    orderStatus: cashierOrder.status,
    payment: { grandTotal: Number(cashierOrder.grandTotal || 0) },
    prescriptionSnapshot: { cashierOrder },
  });
  return toCashierOrder(created);
}

async function listCashierOrders() {
  const rows = await Order.findAll({});
  return rows
    .map((entry) => toCashierOrder(entry))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function filterOrdersByDateRange(orders, { from, to } = {}) {
  const fromTs = from ? toTimestamp(from) : null;
  const toTs = to ? toTimestamp(to) : null;
  if (!fromTs && !toTs) return orders;
  return orders.filter((order) => {
    const createdTs = toTimestamp(order.createdAt || order.updatedAt);
    if (!createdTs) return false;
    if (fromTs && createdTs < fromTs) return false;
    if (toTs && createdTs > toTs) return false;
    return true;
  });
}

async function findCashierOrderById(orderId) {
  const id = normalizeValue(orderId);
  if (!id) return null;
  const byPk = await Order.findByPk(id);
  if (byPk) {
    const mapped = toCashierOrder(byPk);
    if (mapped) return mapped;
  }
  const rows = await listCashierOrders();
  return rows.find((entry) => normalizeValue(entry.orderId).toLowerCase() === id.toLowerCase()) || null;
}

async function findCashierOrderByTicket(ticketNumber) {
  const ticket = normalizeTicket(ticketNumber);
  const rows = await listCashierOrders();
  return rows.find((entry) => normalizeTicket(entry.ticketNumber) === ticket) || null;
}

async function applyCashierAction({ orderId, ticketNumber, action, payload, nextStatus, updater }) {
  const existing = orderId
    ? await findCashierOrderById(orderId)
    : await findCashierOrderByTicket(ticketNumber);
  if (!existing) return null;

  const statusTo = normalizeStatus(nextStatus || existing.status);
  const updated = {
    ...existing,
    status: statusTo,
    updatedAt: nowIso(),
  };
  if (typeof updater === "function") updater(updated);
  const event = buildAuditEvent({
    action,
    payload,
    previousStatus: existing.status,
    nextStatus: statusTo,
  });
  updated.auditTrail = [event, ...(Array.isArray(existing.auditTrail) ? existing.auditTrail : [])].slice(0, 100);

  return persistCashierOrder(updated);
}

async function summarizeCashierOrders({ from, to } = {}) {
  const statuses = ["ready_for_checkout", "pos_handoff", "paid", "void"];
  const summary = {
    generatedAt: nowIso(),
    totalOrders: 0,
    totalRevenue: 0,
    byStatus: {},
    byCashier: [],
  };
  for (const status of statuses) {
    summary.byStatus[status] = { count: 0, revenue: 0 };
  }

  const orders = filterOrdersByDateRange(await listCashierOrders(), { from, to });
  summary.totalOrders = orders.length;

  const cashierMap = new Map();
  for (const order of orders) {
    const status = normalizeStatus(order.status);
    const grandTotal = Number(order.grandTotal || 0);
    if (!summary.byStatus[status]) {
      summary.byStatus[status] = { count: 0, revenue: 0 };
    }
    summary.byStatus[status].count += 1;
    summary.byStatus[status].revenue += grandTotal;
    summary.totalRevenue += grandTotal;

    const actor = Array.isArray(order.auditTrail) && order.auditTrail.length
      ? order.auditTrail[0]
      : null;
    const actorKey = normalizeValue(actor?.actorId) || normalizeValue(actor?.actorName) || "unknown";
    const current = cashierMap.get(actorKey) || {
      cashierId: normalizeValue(actor?.actorId),
      cashierName: normalizeValue(actor?.actorName) || "Unknown",
      count: 0,
      revenue: 0,
    };
    current.count += 1;
    current.revenue += grandTotal;
    cashierMap.set(actorKey, current);
  }

  summary.byCashier = [...cashierMap.values()].sort((a, b) => b.revenue - a.revenue);
  return summary;
}

module.exports = {
  DEFAULT_STATUS,
  filterOrdersByDateRange,
  fromRequestPayload,
  listCashierOrders,
  findCashierOrderById,
  findCashierOrderByTicket,
  persistCashierOrder,
  applyCashierAction,
  normalizeStatus,
  summarizeCashierOrders,
  validateVoidOverride,
};

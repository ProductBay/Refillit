const { AuditLog } = require("../models");

const writeAudit = async ({ actorUserId, action, entityType, entityId, metadata }) =>
  AuditLog.create({ actorUserId, action, entityType, entityId, metadata: metadata || null });

module.exports = { writeAudit };

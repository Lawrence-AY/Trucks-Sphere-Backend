const { AuditLog } = require('../database/models');

async function writeAudit({ req, userId, action, entityType, entityId, metadata }) {
  try {
    await AuditLog.create({
      user_id: userId || req?.auth?.userId || null,
      action,
      entityType,
      entityId,
      metadata,
      ipAddress: req?.ip,
    });
  } catch (error) {
    console.error('Failed to write audit log:', error.message);
  }
}

module.exports = { writeAudit };

const express = require('express');
const { Op } = require('sequelize');
const asyncHandler = require('../../shared/asyncHandler');
const { ok } = require('../../shared/response');
const { authenticate, authorize } = require('../../middleware/v1AuthMiddleware');
const { DeliveryOrder, Reconciliation, Driver, Vehicle, AuditLog } = require('../../database/models');

const router = express.Router();

router.get('/summary', authenticate, authorize('reports.view', 'delivery_orders.read'), asyncHandler(async (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const [
    pendingDeliveries,
    inTransit,
    deliveredToday,
    reconciled,
    delayedDeliveries,
    weightDiscrepancies,
    expiringDriverLicenses,
    expiringVehicleDocuments,
  ] = await Promise.all([
    DeliveryOrder.count({ where: { status: ['draft', 'scheduled', 'dispatched'] } }),
    DeliveryOrder.count({ where: { status: 'in_transit' } }),
    DeliveryOrder.count({ where: { status: 'delivered', updatedAt: { [Op.gte]: start } } }),
    DeliveryOrder.count({ where: { status: 'reconciled' } }),
    DeliveryOrder.count({ where: { status: { [Op.notIn]: ['completed', 'cancelled'] }, scheduledAt: { [Op.lt]: new Date() } } }),
    Reconciliation.count({ where: { hasDiscrepancy: true } }),
    Driver.count({ where: { licenseExpiryDate: { [Op.lte]: inThirtyDays } } }),
    Vehicle.count({ where: { status: 'active' } }),
  ]);

  return ok(res, {
    pendingDeliveries,
    inTransit,
    deliveredToday,
    reconciled,
    delayedDeliveries,
    weightDiscrepancies,
    expiringDriverLicenses,
    expiringVehicleDocuments,
  });
}));

router.get('/recent-activity', authenticate, authorize('reports.view', 'audit_logs.view'), asyncHandler(async (req, res) => {
  const rows = await AuditLog.findAll({ limit: 20, order: [['createdAt', 'DESC']] });
  return ok(res, rows);
}));

module.exports = router;

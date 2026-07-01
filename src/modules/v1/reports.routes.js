const express = require('express');
const asyncHandler = require('../../shared/asyncHandler');
const { ok } = require('../../shared/response');
const { authenticate, authorize } = require('../../middleware/v1AuthMiddleware');
const { DeliveryOrder, Reconciliation, PurchaseOrder, Vendor, Driver, Vehicle, Material } = require('../../database/models');

const router = express.Router();

router.get('/delivery-summary', authenticate, authorize('reports.view'), asyncHandler(async (req, res) => {
  const rows = await DeliveryOrder.findAll({ include: [PurchaseOrder, Vendor, Driver, Vehicle, Material], order: [['createdAt', 'DESC']] });
  return ok(res, rows);
}));

router.get('/vendor-summary', authenticate, authorize('reports.view'), asyncHandler(async (req, res) => {
  const rows = await PurchaseOrder.findAll({ include: [Vendor, Material], order: [['createdAt', 'DESC']] });
  return ok(res, rows);
}));

router.get('/discrepancies', authenticate, authorize('reports.view'), asyncHandler(async (req, res) => {
  const rows = await Reconciliation.findAll({ where: { hasDiscrepancy: true }, order: [['createdAt', 'DESC']] });
  return ok(res, rows);
}));

router.get('/export/:format', authenticate, authorize('reports.export'), asyncHandler(async (req, res) => {
  return ok(res, {
    format: req.params.format,
    status: 'queued',
    message: 'Export generation endpoint is reserved for the PDF/CSV worker.',
  });
}));

module.exports = router;

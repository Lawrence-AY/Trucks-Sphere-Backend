const express = require('express');
const { fn, col } = require('sequelize');
const asyncHandler = require('../../shared/asyncHandler');
const { ok } = require('../../shared/response');
const { authenticate, authorize } = require('../../middleware/v1AuthMiddleware');
const { PurchaseOrder, Vendor, Material } = require('../../database/models');
const { crudRouter } = require('./crudFactory');

const router = express.Router();

router.get('/summary/vendors', authenticate, authorize('purchase_orders.read'), asyncHandler(async (req, res) => {
  const rows = await PurchaseOrder.findAll({
    attributes: [
      'vendor_id',
      [fn('COUNT', col('PurchaseOrder.id')), 'totalPurchaseOrders'],
      [fn('SUM', col('ordered_quantity')), 'totalOrderedQuantity'],
      [fn('SUM', col('delivered_quantity')), 'totalDeliveredQuantity'],
      [fn('SUM', col('remaining_quantity')), 'remainingQuantity'],
    ],
    include: [{ model: Vendor, attributes: ['id', 'vendorCode', 'name'] }],
    group: ['vendor_id', 'Vendor.id'],
  });

  const data = rows.map((row) => {
    const json = row.toJSON();
    const ordered = Number(json.totalOrderedQuantity || 0);
    const delivered = Number(json.totalDeliveredQuantity || 0);
    return {
      vendor: json.Vendor,
      totalPurchaseOrders: Number(json.totalPurchaseOrders || 0),
      totalOrderedQuantity: Math.round(ordered),
      totalDeliveredQuantity: Math.round(delivered),
      remainingQuantity: Math.round(Number(json.remainingQuantity || 0)),
      completionPercentage: ordered ? Math.round((delivered / ordered) * 100) : 0,
    };
  });

  return ok(res, data);
}));

router.get('/:id/detail', authenticate, authorize('purchase_orders.read'), asyncHandler(async (req, res) => {
  const po = await PurchaseOrder.findByPk(req.params.id, { include: [Vendor, Material] });
  return ok(res, po);
}));

router.use('/', crudRouter({
  express,
  model: PurchaseOrder,
  entityName: 'purchase_orders',
  searchable: ['poNumber'],
  exactFilters: ['status', 'vendor_id', 'material_id'],
  auth: { authenticate, authorize },
  permissions: { read: 'purchase_orders.read', manage: 'purchase_orders.update' },
}));

module.exports = router;

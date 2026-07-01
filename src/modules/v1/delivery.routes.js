const express = require('express');
const { Op } = require('sequelize');
const asyncHandler = require('../../shared/asyncHandler');
const ApiError = require('../../shared/apiError');
const { ok, created } = require('../../shared/response');
const { getPagination, getPagingMeta, getSort } = require('../../shared/pagination');
const { authenticate, authorize } = require('../../middleware/v1AuthMiddleware');
const { writeAudit } = require('../../services/auditService');
const {
  DeliveryOrder,
  PurchaseOrder,
  Vendor,
  Driver,
  Vehicle,
  Material,
  Dispatch,
  WeighbridgeRecord,
  ReceiptNote,
  Reconciliation,
  ReconciliationHistory,
  DeliveryTimeline,
  Attachment,
} = require('../../database/models');

const router = express.Router();

const include = [PurchaseOrder, Vendor, Driver, Vehicle, Material, Dispatch, WeighbridgeRecord, ReceiptNote, Reconciliation];

async function addTimeline(req, deliveryOrderId, status, title, description) {
  await DeliveryTimeline.create({ delivery_order_id: deliveryOrderId, user_id: req.auth.userId, status, title, description });
}

router.get('/', authenticate, authorize('delivery_orders.read'), asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req.query);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.vendorId) where.vendor_id = req.query.vendorId;
  if (req.query.driverId) where.driver_id = req.query.driverId;
  if (req.query.vehicleId) where.vehicle_id = req.query.vehicleId;
  if (req.query.purchaseOrderId) where.purchase_order_id = req.query.purchaseOrderId;
  if (req.query.search) where.deliveryNumber = { [Op.iLike]: `%${req.query.search}%` };
  const result = await DeliveryOrder.findAndCountAll({ where, include, limit, offset, order: getSort(req.query) });
  return ok(res, result.rows, getPagingMeta(result.count, page, limit));
}));

router.post('/', authenticate, authorize('delivery_orders.create'), asyncHandler(async (req, res) => {
  const po = await PurchaseOrder.findByPk(req.body.purchase_order_id || req.body.purchaseOrderId);
  if (!po) throw new ApiError(404, 'Purchase order not found', 'NOT_FOUND');
  if (Number(req.body.quantity) > Number(po.remainingQuantity)) {
    throw new ApiError(422, 'Delivery quantity exceeds remaining purchase order quantity', 'QUANTITY_EXCEEDS_REMAINING');
  }
  const count = await DeliveryOrder.count();
  const delivery = await DeliveryOrder.create({
    deliveryNumber: req.body.deliveryNumber || `DO-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`,
    purchase_order_id: po.id,
    vendor_id: req.body.vendor_id || po.vendor_id,
    driver_id: req.body.driver_id,
    vehicle_id: req.body.vehicle_id,
    material_id: req.body.material_id || po.material_id,
    quantity: req.body.quantity,
    origin: req.body.origin,
    destination: req.body.destination,
    scheduledAt: req.body.scheduledAt,
    status: req.body.status || 'draft',
  });
  await addTimeline(req, delivery.id, delivery.status, 'Delivery created', 'Delivery order was created');
  await writeAudit({ req, action: 'delivery.created', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return created(res, delivery);
}));

router.get('/:id', authenticate, authorize('delivery_orders.read'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id, { include });
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  return ok(res, delivery);
}));

router.post('/:id/assign-driver', authenticate, authorize('delivery_orders.update'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  await delivery.update({ driver_id: req.body.driverId || req.body.driver_id });
  await addTimeline(req, delivery.id, delivery.status, 'Driver assigned', 'Driver was assigned to delivery');
  await writeAudit({ req, action: 'driver.assigned', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return ok(res, delivery);
}));

router.post('/:id/assign-vehicle', authenticate, authorize('delivery_orders.update'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  await delivery.update({ vehicle_id: req.body.vehicleId || req.body.vehicle_id });
  await addTimeline(req, delivery.id, delivery.status, 'Vehicle assigned', 'Vehicle was assigned to delivery');
  await writeAudit({ req, action: 'vehicle.assigned', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return ok(res, delivery);
}));

router.post('/:id/dispatch', authenticate, authorize('dispatch.submit'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  const dispatch = await Dispatch.create({ delivery_order_id: delivery.id, submitted_by: req.auth.userId, notes: req.body.notes });
  await delivery.update({ status: 'dispatched', dispatchedAt: new Date() });
  await addTimeline(req, delivery.id, 'dispatched', 'Dispatch submitted', req.body.notes);
  await writeAudit({ req, action: 'dispatch.submitted', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return created(res, dispatch);
}));

router.post('/:id/weighbridge/:type', authenticate, authorize('weighbridge.capture_origin', 'weighbridge.capture_destination'), asyncHandler(async (req, res) => {
  const type = req.params.type;
  if (!['origin', 'destination'].includes(type)) throw new ApiError(400, 'Weighbridge type must be origin or destination', 'VALIDATION_ERROR');
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  const record = await WeighbridgeRecord.create({
    delivery_order_id: delivery.id,
    captured_by: req.auth.userId,
    type,
    weight: req.body.weight,
    ticketNumber: req.body.ticketNumber,
    stationName: req.body.stationName,
    capturedAt: req.body.capturedAt || new Date(),
  });
  await delivery.update({ status: type === 'origin' ? 'origin_weighbridge' : 'destination_weighbridge' });
  await addTimeline(req, delivery.id, delivery.status, `${type} weight captured`, `${req.body.weight} recorded at ${req.body.stationName}`);
  await writeAudit({ req, action: `weighbridge.${type}_captured`, entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return created(res, record);
}));

router.post('/:id/receipt-note', authenticate, authorize('receipt_notes.submit'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  if (req.body.receiptStatus === 'rejected' && !req.body.receiptNote) {
    throw new ApiError(422, 'Rejected receipts require remarks', 'REMARKS_REQUIRED');
  }
  const note = await ReceiptNote.create({
    delivery_order_id: delivery.id,
    received_by: req.auth.userId,
    receiptStatus: req.body.receiptStatus,
    receiptNote: req.body.receiptNote,
    receivedAt: req.body.receivedAt || new Date(),
  });
  await delivery.update({ status: 'delivered' });
  await addTimeline(req, delivery.id, 'delivered', 'Receipt submitted', req.body.receiptStatus);
  await writeAudit({ req, action: 'receipt.uploaded', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return created(res, note);
}));

router.post('/:id/reconcile', authenticate, authorize('reconciliation.run'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id, { include: [WeighbridgeRecord] });
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  const origin = delivery.WeighbridgeRecords.find((record) => record.type === 'origin');
  const destination = delivery.WeighbridgeRecords.find((record) => record.type === 'destination');
  if (!origin || !destination) throw new ApiError(422, 'Origin and destination weights are required', 'WEIGHTS_REQUIRED');
  const tolerance = Number(req.body.tolerance || process.env.DEFAULT_WEIGHT_TOLERANCE || 0.5);
  const difference = Number(origin.weight) - Number(destination.weight);
  const hasDiscrepancy = Math.abs(difference) > tolerance;
  const reconciliation = await Reconciliation.create({
    delivery_order_id: delivery.id,
    originWeight: origin.weight,
    destinationWeight: destination.weight,
    difference,
    tolerance,
    hasDiscrepancy,
    status: hasDiscrepancy ? 'discrepancy' : 'matched',
  });
  await ReconciliationHistory.create({
    reconciliation_id: reconciliation.id,
    user_id: req.auth.userId,
    action: 'created',
    snapshot: reconciliation.toJSON(),
  });
  await delivery.update({ status: 'reconciled' });
  await addTimeline(req, delivery.id, 'reconciled', 'Reconciliation completed', hasDiscrepancy ? 'Discrepancy flagged' : 'Weights matched');
  await writeAudit({ req, action: 'reconciliation.completed', entityType: 'delivery_order', entityId: delivery.id, metadata: reconciliation.toJSON() });
  return created(res, reconciliation);
}));

router.get('/:id/timeline', authenticate, authorize('delivery_orders.read'), asyncHandler(async (req, res) => {
  const rows = await DeliveryTimeline.findAll({ where: { delivery_order_id: req.params.id }, order: [['occurredAt', 'ASC']] });
  return ok(res, rows);
}));

router.get('/:id/attachments', authenticate, authorize('delivery_orders.read'), asyncHandler(async (req, res) => {
  const rows = await Attachment.findAll({ where: { delivery_order_id: req.params.id }, order: [['createdAt', 'DESC']] });
  return ok(res, rows);
}));

router.post('/:id/cancel', authenticate, authorize('delivery_orders.cancel'), asyncHandler(async (req, res) => {
  const delivery = await DeliveryOrder.findByPk(req.params.id);
  if (!delivery) throw new ApiError(404, 'Delivery order not found', 'NOT_FOUND');
  await delivery.update({ status: 'cancelled' });
  await addTimeline(req, delivery.id, 'cancelled', 'Delivery cancelled', req.body.reason);
  await writeAudit({ req, action: 'delivery.cancelled', entityType: 'delivery_order', entityId: delivery.id, metadata: req.body });
  return ok(res, delivery);
}));

module.exports = router;

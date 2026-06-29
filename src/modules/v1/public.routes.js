const express = require('express');
const jwt = require('jsonwebtoken');
const asyncHandler = require('../../shared/asyncHandler');
const ApiError = require('../../shared/apiError');
const { ok } = require('../../shared/response');
const { DeliveryOrder, Vendor, PurchaseOrder, Material } = require('../../database/models');

const router = express.Router();
const PUBLIC_LINK_SECRET = process.env.PUBLIC_LINK_SECRET || 'dev_trucksphere_public_secret';

router.get('/vendor-links/:token', asyncHandler(async (req, res) => {
  const payload = jwt.verify(req.params.token, PUBLIC_LINK_SECRET);
  const delivery = await DeliveryOrder.findByPk(payload.deliveryOrderId, { include: [Vendor, PurchaseOrder, Material] });
  if (!delivery) throw new ApiError(404, 'Delivery context not found', 'NOT_FOUND');
  return ok(res, delivery);
}));

router.post('/vendor-links/:token/acknowledge', asyncHandler(async (req, res) => {
  const payload = jwt.verify(req.params.token, PUBLIC_LINK_SECRET);
  return ok(res, { acknowledged: true, deliveryOrderId: payload.deliveryOrderId });
}));

module.exports = router;

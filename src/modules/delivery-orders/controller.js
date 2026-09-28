const delivery_ordersService = require('./service');
const { db } = require('../../../config/firebase');

async function getUserEntity(email) {
  const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!userSnap.empty) return userSnap.docs[0].data();
  return null;
}

function withRoleDefaults(payload, user, userEntity) {
  const nextPayload = { ...payload };
  const email = user?.email || user?.user_email || '';

  if (!email && !userEntity) return nextPayload;

  if (user?.role === 'operator_quarry' && userEntity?.quarryId && !nextPayload.quarryId) {
    nextPayload.quarryId = userEntity.quarryId;
  }

  if (user?.role === 'operator_site' && userEntity?.siteId && !nextPayload.siteId) {
    nextPayload.siteId = userEntity.siteId;
  }

  if (user?.role === 'vendor' && userEntity?.vendorId && !nextPayload.vendorId) {
    nextPayload.vendorId = userEntity.vendorId;
  }

  return nextPayload;
}

exports.findAll = async (req, res, next) => {
  try {
    const { role, email } = req.user;
    let scopedQuery = { ...req.query };

    // Scope delivery orders based on user role
    const userEntity = await getUserEntity(email);

    if (role === 'vendor' && userEntity?.vendorId) {
      scopedQuery.vendorId = userEntity.vendorId;
    } else if (role === 'operator_quarry' && userEntity?.quarryId) {
      scopedQuery.quarryId = userEntity.quarryId;
    } else if (role === 'operator_site' && userEntity?.siteId) {
      scopedQuery.siteId = userEntity.siteId;
    }
    // operator_fuel and management see all

    const items = await delivery_ordersService.findAll(scopedQuery);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await delivery_ordersService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.findByJobId = async (req, res, next) => {
  try {
    // Wildcard route: jobId is captured in req.params[0] (Express 4)
    const jobId = (req.params[0] || '').replace(/^\/+/, '');
    const items = await delivery_ordersService.findAll({ jobId });
    res.json(items);
  } catch (err) { next(err); }
};

exports.findByPurchaseOrderId = async (req, res, next) => {
  try {
    const purchaseOrderId = (req.params[0] || '').replace(/^\/+/, '');
    const items = await delivery_ordersService.findAll({ purchaseOrderId });
    res.json(items);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const userEntity = await getUserEntity(req.user?.email || req.user?.user_email || '');
    const payload = withRoleDefaults(req.body, req.user, userEntity);
    const item = await delivery_ordersService.create(payload);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await delivery_ordersService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.receiveLot = async (req, res, next) => {
  try {
    const { deliveryOrderId, storageLot } = req.body;

    if (!deliveryOrderId || !storageLot) {
      return res.status(400).json({
        error: 'Both deliveryOrderId and storageLot are required.',
      });
    }

    if (typeof storageLot !== 'string' || storageLot.trim().length === 0) {
      return res.status(400).json({
        error: 'storageLot must be a non-empty string.',
      });
    }

    const updated = await delivery_ordersService.receiveLot(deliveryOrderId, storageLot.trim());
    if (!updated) {
      return res.status(404).json({ error: 'Delivery order not found.' });
    }

    res.json(updated);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await delivery_ordersService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

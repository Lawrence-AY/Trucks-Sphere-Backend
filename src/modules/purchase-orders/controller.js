const purchase_ordersService = require('./service');
const { db } = require('../../../config/firebase');
const { MANAGEMENT_ROLES, normalizeRole } = require('../../middleware/authorizationMiddleware');

async function getUserEntity(user) {
  if (user?.uid) {
    const byUid = await db.collection('users').doc(user.uid).get();
    if (byUid.exists) return byUid.data();
  }
  const email = user?.email || user?.user_email || '';
  const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!userSnap.empty) return userSnap.docs[0].data();
  const authEmailSnap = await db.collection('users').where('authEmail', '==', email).limit(1).get();
  if (!authEmailSnap.empty) return authEmailSnap.docs[0].data();
  return null;
}

function isManagement(role) {
  return [MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE]
    .includes(normalizeRole(role));
}

function matchesId(left, right) {
  return Boolean(left && right && String(left).trim().toLowerCase() === String(right).trim().toLowerCase());
}

function canViewPurchaseOrder(item, user, entity) {
  const role = normalizeRole(user?.role);
  if (isManagement(role)) return true;
  if (role === 'vendor') return matchesId(item?.vendorId, entity?.vendorId || user?.entityId);
  if (role === 'operator_quarry' && item?.isWarehouseMaterial) return false;
  // Purchase orders no longer carry a quarry or site assignment. Both
  // operational teams must be able to select any active PO when creating a
  // job card; job creation records the operator and operational context.
  if (role === 'operator_quarry' || role === 'operator_site' || role === 'operator_warehouse') return true;
  return false;
}

exports.findAll = async (req, res, next) => {
  try {
    const { role } = req.user;
    let scopedQuery = { ...req.query };
    if (normalizeRole(role) === 'operator_quarry') scopedQuery.excludeWarehouse = true;
    const userEntity = await getUserEntity(req.user);

    // Scope purchase orders based on user role
    if (normalizeRole(role) === 'vendor') {
      // An account with no resolved vendor profile must see no records, never
      // the full purchase-order collection.
      scopedQuery.vendorId = userEntity?.vendorId || req.user?.entityId || '__none__';
    }
    // Operators must also receive unassigned purchase orders. They are filtered
    // after retrieval by canViewPurchaseOrder rather than by a restrictive ID query.

    const items = await purchase_ordersService.findAll(scopedQuery);
    const data = items.data.filter((item) => canViewPurchaseOrder(item, req.user, userEntity));
    res.json({ ...items, data, total: data.length, totalPages: 1 });
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await purchase_ordersService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const userEntity = await getUserEntity(req.user);
    if (!canViewPurchaseOrder(item, req.user, userEntity)) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await purchase_ordersService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await purchase_ordersService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.previewNumber = async (req, res, next) => {
  try {
    const { vendorId, materialId } = req.query;
    const poNumber = await purchase_ordersService.previewNumber(vendorId, materialId);
    res.json({ poNumber });
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await purchase_ordersService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

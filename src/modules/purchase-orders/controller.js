const purchase_ordersService = require('./service');
const { db } = require('../../../config/firebase');

async function getUserEntity(email) {
  const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!userSnap.empty) return userSnap.docs[0].data();
  return null;
}

exports.findAll = async (req, res, next) => {
  try {
    const { role, email } = req.user;
    let scopedQuery = { ...req.query };

    // Scope purchase orders based on user role
    if (role === 'vendor') {
      const userEntity = await getUserEntity(email);
      if (userEntity?.vendorId) {
        scopedQuery.vendorId = userEntity.vendorId;
      }
    }
    // Management, quarry ops, site ops, fuel ops see all

    const items = await purchase_ordersService.findAll(scopedQuery);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await purchase_ordersService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
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

exports.delete = async (req, res, next) => {
  try {
    await purchase_ordersService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};
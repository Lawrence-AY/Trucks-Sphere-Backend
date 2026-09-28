const fuelService = require('./service');
const { normalizeRole } = require('../../middleware/authorizationMiddleware');

exports.findAll = async (req, res, next) => {
  try {
    const { email } = req.user;
    const role = normalizeRole(req.user?.role);
    // Scope fuel records based on user role
    let scopedQuery = { ...req.query };

    if (role === 'vendor') {
      // `verifyToken` normally resolves entityId from the authenticated
      // profile. Fall back to both legacy and current email fields for older
      // vendor accounts, but never return the unscoped fuel collection.
      let vendorId = req.user?.entityId || req.user?.vendorId || '';
      if (!vendorId) {
        const { db } = require('../../../config/firebase');
        const legacyUser = await db.collection('users').where('email', '==', email).limit(1).get();
        const authEmailUser = legacyUser.empty
          ? await db.collection('users').where('authEmail', '==', email).limit(1).get()
          : legacyUser;
        if (!authEmailUser.empty) {
          vendorId = authEmailUser.docs[0].data().vendorId || '';
        }
      }
      scopedQuery.vendorId = vendorId || '__none__';
    } else if (role === 'operator_fuel') {
      // Fuel operator sees only records they dispensed
      scopedQuery.dispensedByEmail = email;
    }
    // Management sees all

    const items = await fuelService.findAll(scopedQuery);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await fuelService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const { email, name, displayName } = req.user;
    const actorEmail = email || '';
    const payload = {
      ...req.body,
      dispensedBy: req.body.dispensedBy || actorEmail,
      dispensedByEmail: actorEmail,
      dispensedByName: req.body.dispensedByName || req.body.dispensedBy || displayName || name || actorEmail,
    };
    const item = await fuelService.create(payload);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await fuelService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await fuelService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

exports.confirm = async (req, res, next) => {
  try {
    const result = await fuelService.confirm(req.query.authorizationId, req.user.email, req.query);
    res.json({ ...result.transaction, receiptNoteId: result.receiptNoteId });
  } catch (err) {
    if (err.code === 'FMS_TRANSACTION_PENDING') return res.json({ status: 'pending', code: err.code });
    next(err);
  }
};

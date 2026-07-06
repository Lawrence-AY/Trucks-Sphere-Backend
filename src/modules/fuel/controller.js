const fuelService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    const { role, email } = req.user;
    // Scope fuel records based on user role
    let scopedQuery = { ...req.query };
    const { db } = require('../../../config/firebase');

    if (role === 'vendor') {
      // Vendor sees only their fuel records
      const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!userSnap.empty) {
        const userDoc = userSnap.docs[0].data();
        if (userDoc.vendorId) {
          scopedQuery.vendorId = userDoc.vendorId;
        }
      }
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
    const { email } = req.user;
    const payload = {
      ...req.body,
      dispensedBy: req.body.dispensedBy || email, // Track who dispensed
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
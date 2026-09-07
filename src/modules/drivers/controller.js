const driversService = require('./service');
const { verifyDriverIdentity } = require('../../integrations/iprsService');

function scopedQuery(req) {
  return req.user?.role === 'vendor' ? { ...req.query, vendorId: req.user?.entityId || '__none__' } : req.query;
}

function isOutsideVendorScope(req, item) {
  return req.user?.role === 'vendor' && (!req.user?.entityId || item?.vendorId !== req.user.entityId);
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await driversService.findAll(scopedQuery(req));
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await driversService.findById(req.params.id);
    if (isOutsideVendorScope(req, item)) return res.status(404).json({ error: 'Not found' });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    await verifyDriverIdentity({
      nationalId: req.body.nationalId,
      firstName: req.body.firstName,
      surname: req.body.surname,
    });
    const item = await driversService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.checkNationalId = async (req, res, next) => {
  try {
    const available = await driversService.isNationalIdAvailable(
      req.params.nationalId,
      req.query.excludeId,
    );
    res.json({ available });
  } catch (err) { next(err); }
};

exports.verifyIdentity = async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const result = await verifyDriverIdentity(req.body);
    res.json(result);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    if (['nationalId', 'firstName', 'surname'].some((key) => Object.prototype.hasOwnProperty.call(req.body, key))) {
      const existing = await driversService.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await verifyDriverIdentity({
        nationalId: req.body.nationalId ?? existing.nationalId,
        firstName: req.body.firstName ?? existing.firstName,
        surname: req.body.surname ?? existing.surname,
      });
    }
    const item = await driversService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await driversService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

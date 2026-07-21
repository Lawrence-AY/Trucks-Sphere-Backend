const vehiclesService = require('./service');

function scopedQuery(req) {
  return req.user?.role === 'vendor' ? { ...req.query, vendorId: req.user?.entityId || '__none__' } : req.query;
}

function isOutsideVendorScope(req, item) {
  return req.user?.role === 'vendor' && (!req.user?.entityId || item?.vendorId !== req.user.entityId);
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await vehiclesService.findAll(scopedQuery(req));
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await vehiclesService.findById(req.params.id);
    if (isOutsideVendorScope(req, item)) return res.status(404).json({ error: 'Not found' });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await vehiclesService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await vehiclesService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await vehiclesService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

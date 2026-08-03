const vendorsService = require('./service');

function vendorScope(req) {
  return req.user?.role === 'vendor' ? req.user?.entityId || '' : '';
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await vendorsService.findAll(req.query);
    const vendorId = vendorScope(req);
    if (vendorId) {
      const data = items.data.filter((item) => item.id === vendorId || item.vendorId === vendorId);
      return res.json({ ...items, data, total: data.length, totalPages: data.length ? 1 : 0 });
    }
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await vendorsService.findById(req.params.id);
    if (vendorScope(req) && (!item || (item.id !== vendorScope(req) && item.vendorId !== vendorScope(req)))) return res.status(404).json({ error: 'Not found' });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await vendorsService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.previewUsername = async (req, res, next) => {
  try {
    const username = await vendorsService.previewUsername(req.query.contactPerson || req.query.companyName);
    res.json({ username });
  } catch (err) { next(err); }
};

exports.createWithAccount = async (req, res, next) => {
  try {
    const item = await vendorsService.createWithAccount(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.syncFromOdoo = async (_req, res, next) => {
  try {
    const job = vendorsService.startOdooSync();
    res.status(job.status === 'running' ? 202 : 200).json(job);
  } catch (err) { next(err); }
};

exports.getOdooSyncStatus = async (_req, res, next) => {
  try {
    res.json(vendorsService.getOdooSyncStatus());
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await vendorsService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await vendorsService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

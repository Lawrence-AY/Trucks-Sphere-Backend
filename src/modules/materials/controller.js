const materialsService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    const items = await materialsService.findAll(req.query);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await materialsService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await materialsService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await materialsService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.syncToOdoo = async (_req, res, next) => {
  try {
    const job = materialsService.startOdooSync();
    res.status(job.status === 'running' ? 202 : 200).json(job);
  } catch (err) { next(err); }
};

exports.getOdooSyncStatus = async (_req, res, next) => {
  try {
    res.json(materialsService.getOdooSyncStatus());
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await materialsService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

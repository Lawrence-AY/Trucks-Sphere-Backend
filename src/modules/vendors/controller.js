const vendorsService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    const items = await vendorsService.findAll(req.query);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await vendorsService.findById(req.params.id);
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

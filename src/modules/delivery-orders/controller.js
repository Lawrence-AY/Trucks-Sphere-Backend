const delivery_ordersService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    const items = await delivery_ordersService.findAll(req.query);
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
    const { jobId } = req.params;
    const items = await delivery_ordersService.findAll({ jobId });
    res.json(items);
  } catch (err) { next(err); }
};

exports.findByPurchaseOrderId = async (req, res, next) => {
  try {
    const { purchaseOrderId } = req.params;
    const items = await delivery_ordersService.findAll({ purchaseOrderId });
    res.json(items);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await delivery_ordersService.create(req.body);
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

exports.delete = async (req, res, next) => {
  try {
    await delivery_ordersService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

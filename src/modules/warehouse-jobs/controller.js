const warehouseJobsService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    res.json(warehouseJobsService.findAll(req.query));
  } catch (error) { next(error); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = warehouseJobsService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    return res.json(item);
  } catch (error) { return next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await warehouseJobsService.create({
      ...req.body,
      createdByUid: req.user?.uid || '',
      createdByName: req.user?.displayName || req.user?.email || '',
    });
    res.status(201).json(item);
  } catch (error) { next(error); }
};

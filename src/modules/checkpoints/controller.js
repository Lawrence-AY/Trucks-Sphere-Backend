const checkpointsService = require('./service');

exports.findAll = async (req, res, next) => {
  try {
    const items = await checkpointsService.findAll(req.query);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await checkpointsService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await checkpointsService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await checkpointsService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await checkpointsService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

/** GET /api/checkpoints/journey/:jobId */
exports.getJourneyByJobId = async (req, res, next) => {
  try {
    const { jobId } = req.params;
    if (!jobId) return res.status(400).json({ error: 'jobId parameter is required' });
    const result = await checkpointsService.getJourneyByJobId(jobId);
    res.json(result);
  } catch (err) { next(err); }
};

/** GET /api/checkpoints/active */
exports.getActiveDeliveries = async (req, res, next) => {
  try {
    const result = await checkpointsService.getActiveDeliveries();
    res.json(result);
  } catch (err) { next(err); }
};

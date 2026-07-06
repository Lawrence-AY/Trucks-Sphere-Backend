/**
 * Generic CRUD controller factory
 * @param {Object} service - Service object with getAll, getById, create, update, remove
 */
const crudController = (service) => ({
  getAll: async (req, res, next) => {
    try {
      const data = await service.getAll(req.query);
      res.json({ status: 'success', data });
    } catch (err) { next(err); }
  },
  getById: async (req, res, next) => {
    try {
      const data = await service.getById(req.params.id);
      res.json({ status: 'success', data });
    } catch (err) { next(err); }
  },
  create: async (req, res, next) => {
    try {
      const data = await service.create(req.body, req.user);
      res.status(201).json({ status: 'success', data });
    } catch (err) { next(err); }
  },
  update: async (req, res, next) => {
    try {
      const data = await service.update(req.params.id, req.body);
      res.json({ status: 'success', data });
    } catch (err) { next(err); }
  },
  remove: async (req, res, next) => {
    try {
      await service.remove(req.params.id);
      res.json({ status: 'success', message: 'Deleted successfully' });
    } catch (err) { next(err); }
  },
});

module.exports = crudController;

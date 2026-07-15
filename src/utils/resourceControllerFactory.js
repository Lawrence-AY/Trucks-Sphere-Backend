function createResourceController(service) {
  return {
    findAll: async (req, res, next) => {
      try {
        const items = await service.findAll(req.query, req.user);
        res.json(items);
      } catch (error) {
        next(error);
      }
    },

    findById: async (req, res, next) => {
      try {
        const item = await service.findById(req.params.id);
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json(item);
      } catch (error) {
        next(error);
      }
    },

    create: async (req, res, next) => {
      try {
        const item = await service.create(req.body, req.user);
        res.status(201).json(item);
      } catch (error) {
        next(error);
      }
    },

    update: async (req, res, next) => {
      try {
        const item = await service.update(req.params.id, req.body, req.user);
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json(item);
      } catch (error) {
        next(error);
      }
    },

    delete: async (req, res, next) => {
      try {
        await service.delete(req.params.id);
        res.json({ message: 'Deleted successfully' });
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = createResourceController;

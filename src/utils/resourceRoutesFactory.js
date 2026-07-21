const express = require('express');
const { verifyToken } = require('../middleware/authMiddleware');
const createResourceController = require('./resourceControllerFactory');

function createResourceRoutes(service, { middleware = [] } = {}) {
  const router = express.Router();
  const controller = createResourceController(service);

  router.use(verifyToken);
  if (middleware.length) router.use(...middleware);
  router.get('/', controller.findAll);
  router.get('/:id', controller.findById);
  router.post('/', controller.create);
  router.put('/:id', controller.update);
  router.delete('/:id', controller.delete);

  return router;
}

module.exports = createResourceRoutes;

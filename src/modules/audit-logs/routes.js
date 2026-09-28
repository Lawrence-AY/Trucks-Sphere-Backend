const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const createResourceController = require('../../utils/resourceControllerFactory');
const createResourceService = require('../../utils/resourceServiceFactory');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
const service = createResourceService({
  collectionName: 'auditLogs',
  cacheName: 'auditLogs',
  searchableFields: ['action', 'entityType', 'entityId', 'actorName', 'actorEmail'],
  defaultStatusField: 'severity',
});
const controller = createResourceController(service);

router.use(verifyToken);
router.use(requireManagementAccess({ superAdminOnly: true }));
router.get('/', controller.findAll);
router.get('/:id', controller.findById);

module.exports = router;

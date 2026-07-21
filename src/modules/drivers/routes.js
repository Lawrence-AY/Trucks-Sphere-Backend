const express = require('express');
const router = express.Router();
const driversController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'vendor'));

router.get('/national-id/:nationalId', requireManagementAccess({ allowLite: true }), driversController.checkNationalId);
router.get('/', driversController.findAll);
router.get('/:id', driversController.findById);
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), driversController.create);
router.put('/:id', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), driversController.update);
router.delete('/:id', requireManagementAccess({ write: true }), driversController.delete);

module.exports = router;

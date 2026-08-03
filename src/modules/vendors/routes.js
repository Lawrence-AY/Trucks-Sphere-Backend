const express = require('express');
const router = express.Router();
const vendorsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'vendor', 'operator_warehouse'));

router.get('/username', vendorsController.previewUsername);
router.post('/with-account', requireManagementAccess({ allowLite: true, write: true }), vendorsController.createWithAccount);
router.post('/sync/odoo', requireManagementAccess({ write: true }), vendorsController.syncFromOdoo);
router.get('/sync/odoo', requireManagementAccess({ allowLite: true }), vendorsController.getOdooSyncStatus);
router.get('/', vendorsController.findAll);
router.get('/:id', vendorsController.findById);
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), vendorsController.create);
router.put('/:id', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), vendorsController.update);
router.delete('/:id', requireManagementAccess({ write: true }), vendorsController.delete);

module.exports = router;

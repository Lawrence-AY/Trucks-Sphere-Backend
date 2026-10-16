const express = require('express');
const router = express.Router();
const vendorsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'vendor', 'operator_warehouse', 'storeman'));

router.get('/username', vendorsController.previewUsername);
router.post('/validate-kra-pin', vendorsController.validateKraPin);
router.post('/with-account', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true }), vendorsController.createWithAccount);
router.get('/', vendorsController.findAll);
router.post('/:id/account', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), vendorsController.createAccount);
router.get('/:id/fleet', vendorsController.findFleet);
router.get('/:id/documents', vendorsController.findDocuments);
router.get('/:id/aliases', vendorsController.listAliases);
router.post('/:id/aliases', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), vendorsController.addAlias);
router.delete('/:id/aliases/:aliasId', requireManagementAccess({ write: true }), vendorsController.removeAlias);
router.get('/:id', vendorsController.findById);
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), vendorsController.create);
router.put('/:id', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), vendorsController.update);
router.delete('/:id', requireManagementAccess({ write: true }), vendorsController.delete);

module.exports = router;

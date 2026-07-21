const express = require('express');
const router = express.Router();
const purchase_ordersController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);

router.get('/', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'vendor', 'operator_quarry', 'operator_site'), purchase_ordersController.findAll);
router.get('/preview-number', requireManagementAccess({ allowLite: true }), purchase_ordersController.previewNumber);
router.get('/:id', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'vendor', 'operator_quarry', 'operator_site'), purchase_ordersController.findById);
// Management Lite can create new purchase orders, but cannot alter or delete
// an order after it has been submitted.
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true }), purchase_ordersController.create);
router.put('/:id', requireManagementAccess({ write: true, allowAdminWrite: true }), purchase_ordersController.update);
router.delete('/:id', requireManagementAccess({ write: true }), purchase_ordersController.delete);

module.exports = router;

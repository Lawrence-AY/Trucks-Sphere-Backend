const express = require('express');
const router = express.Router();
const materialsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
// Materials are a read-only catalogue for every operational workflow: vendors
// need it for their material summary, and quarry/site operators need it while
// creating and processing job cards.  Creation and maintenance remain
// management-only below.
router.use(requireRoles(
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
  'vendor',
  'operator_quarry',
  'operator_site',
  'operator_fuel',
));

router.get('/', materialsController.findAll);
router.post('/sync/odoo', requireManagementAccess({ write: true }), materialsController.syncToOdoo);
router.get('/sync/odoo', requireManagementAccess({ allowLite: true }), materialsController.getOdooSyncStatus);
router.get('/:id', materialsController.findById);
router.post('/', requireManagementAccess({ write: true }), materialsController.create);
router.put('/:id', requireManagementAccess({ write: true }), materialsController.update);
router.delete('/:id', requireManagementAccess({ write: true }), materialsController.delete);

module.exports = router;

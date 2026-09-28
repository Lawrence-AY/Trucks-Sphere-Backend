const express = require('express');
const router = express.Router();
const driversController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
// Quarry and site operators need read-only access to the vendor fleet so
// they can assign a driver to a job card.  Write access remains guarded on
// each mutation route below.
router.use(requireRoles(
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
  'vendor',
  'operator_quarry',
  'operator_site',
  'operator_warehouse',
));

router.get('/national-id/:nationalId', requireManagementAccess({ allowLite: true }), driversController.checkNationalId);
router.post('/verify-identity', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), driversController.verifyIdentity);
router.post('/lookup-identity', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), driversController.lookupIdentity);
router.get('/', driversController.findAll);
router.get('/:id', driversController.findById);
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), driversController.create);
router.put('/:id', requireManagementAccess({ allowLite: true, write: true, allowAdminWrite: true, allowLiteWrite: true }), driversController.update);
router.delete('/:id', requireManagementAccess({ write: true }), driversController.delete);

module.exports = router;

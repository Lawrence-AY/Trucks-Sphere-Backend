const express = require('express');
const router = express.Router();
const vehiclesController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
// Quarry and site operators need read-only access to the vendor fleet so
// they can assign a truck to a job card.  Write access remains guarded on
// each mutation route below.
router.use(requireRoles(
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
  'vendor',
  'operator_quarry',
  'operator_site',
));

router.get('/', vehiclesController.findAll);
router.get('/:id', vehiclesController.findById);
router.post('/', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), vehiclesController.create);
router.put('/:id', requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true }), vehiclesController.update);
router.delete('/:id', requireManagementAccess({ write: true }), vehiclesController.delete);

module.exports = router;

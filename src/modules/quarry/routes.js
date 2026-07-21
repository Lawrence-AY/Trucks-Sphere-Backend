const express = require('express');
const router = express.Router();
const quarryController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_quarry'));

router.get('/', quarryController.findAll);
router.get('/:id', quarryController.findById);
router.post('/', requireManagementAccess({ write: true }), quarryController.create);
router.put('/:id', requireManagementAccess({ write: true }), quarryController.update);
router.delete('/:id', requireManagementAccess({ write: true }), quarryController.delete);

module.exports = router;

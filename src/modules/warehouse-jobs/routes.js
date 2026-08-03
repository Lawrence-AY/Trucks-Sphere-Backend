const express = require('express');
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
router.use(verifyToken);
// Warehouse personnel submit their own dispatches; management can still view
// and create them for oversight or contingency operations.
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_warehouse'));

router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);

module.exports = router;

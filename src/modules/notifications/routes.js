const express = require('express');
const router = express.Router();
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'vendor', 'operator_quarry', 'operator_site', 'operator_fuel'));

router.get('/', controller.findAll);
router.put('/:id/read', controller.markRead);
router.put('/read-all', controller.markAllRead);

module.exports = router;

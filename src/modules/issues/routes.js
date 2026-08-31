const express = require('express');
const router = express.Router();
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');

// All routes require authentication
router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'vendor', 'operator_quarry', 'operator_site', 'operator_fuel', 'inspector'));

router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);
router.post('/:id/notify', controller.notifySubmitter);

module.exports = router;

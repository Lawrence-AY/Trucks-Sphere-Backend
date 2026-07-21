const express = require('express');
const router = express.Router();
const checkpointsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'vendor', 'operator_quarry', 'operator_site'));

router.get('/', checkpointsController.findAll);
router.get('/active', checkpointsController.getActiveDeliveries);
router.get('/journey/:jobId', checkpointsController.getJourneyByJobId);
router.get('/:id', checkpointsController.findById);
router.post('/', checkpointsController.create);
router.put('/:id', checkpointsController.update);
router.delete('/:id', checkpointsController.delete);

module.exports = router;

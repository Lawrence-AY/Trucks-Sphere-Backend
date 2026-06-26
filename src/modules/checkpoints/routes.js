const express = require('express');
const router = express.Router();
const checkpointsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', checkpointsController.findAll);
router.get('/active', checkpointsController.getActiveDeliveries);
router.get('/journey/:jobId', checkpointsController.getJourneyByJobId);
router.get('/:id', checkpointsController.findById);
router.post('/', checkpointsController.create);
router.put('/:id', checkpointsController.update);
router.delete('/:id', checkpointsController.delete);

module.exports = router;

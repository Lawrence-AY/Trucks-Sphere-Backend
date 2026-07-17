const express = require('express');
const router = express.Router();
const driversController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/national-id/:nationalId', driversController.checkNationalId);
router.get('/', driversController.findAll);
router.get('/:id', driversController.findById);
router.post('/', driversController.create);
router.put('/:id', driversController.update);
router.delete('/:id', driversController.delete);

module.exports = router;

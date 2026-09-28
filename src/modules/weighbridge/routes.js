const express = require('express');
const router = express.Router();
const weighbridgeController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', weighbridgeController.findAll);
router.get('/:id', weighbridgeController.findById);
router.post('/', weighbridgeController.create);
router.put('/:id', weighbridgeController.update);
router.delete('/:id', weighbridgeController.delete);

module.exports = router;

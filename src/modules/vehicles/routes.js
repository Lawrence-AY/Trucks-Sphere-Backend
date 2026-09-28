const express = require('express');
const router = express.Router();
const vehiclesController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', vehiclesController.findAll);
router.get('/:id', vehiclesController.findById);
router.post('/', vehiclesController.create);
router.put('/:id', vehiclesController.update);
router.delete('/:id', vehiclesController.delete);

module.exports = router;

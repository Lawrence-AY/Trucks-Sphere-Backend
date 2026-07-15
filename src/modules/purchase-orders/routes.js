const express = require('express');
const router = express.Router();
const purchase_ordersController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', purchase_ordersController.findAll);
router.get('/preview-number', purchase_ordersController.previewNumber);
router.get('/:id', purchase_ordersController.findById);
router.post('/', purchase_ordersController.create);
router.put('/:id', purchase_ordersController.update);
router.delete('/:id', purchase_ordersController.delete);

module.exports = router;

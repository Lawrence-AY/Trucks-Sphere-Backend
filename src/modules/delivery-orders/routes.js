const express = require('express');
const router = express.Router();
const delivery_ordersController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', delivery_ordersController.findAll);
router.get('/:id', delivery_ordersController.findById);
router.get('/job/:jobId', delivery_ordersController.findByJobId);
router.get('/po/:purchaseOrderId', delivery_ordersController.findByPurchaseOrderId);
router.post('/', delivery_ordersController.create);
router.put('/:id', delivery_ordersController.update);
router.delete('/:id', delivery_ordersController.delete);

module.exports = router;

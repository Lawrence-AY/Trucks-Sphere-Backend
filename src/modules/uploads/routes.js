const express = require('express');
const router = express.Router();
const controller = require('./controller');
const uploadController = require('./uploadController');

// CRUD for uploads collection (legacy)
router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

// File upload endpoints → Firebase Storage + Firestore photoURL
router.post('/driver-photo/:driverId', uploadController.uploadDriverPhoto);
router.post('/delivery-note/:deliveryOrderId', uploadController.uploadDeliveryNote);
router.post('/receipt-note/:weighRecordId', uploadController.uploadReceiptNote);

module.exports = router;
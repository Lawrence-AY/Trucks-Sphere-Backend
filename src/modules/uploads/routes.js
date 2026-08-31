const express = require('express');
const router = express.Router();
const controller = require('./controller');
const uploadController = require('./uploadController');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');
const { multerErrorHandler } = require('./uploadMiddleware');

// All upload routes require authentication
router.use(verifyToken);

// Multer error handler — catches file size, type, and field-name errors
// before they fall through to the generic 500 handler

// CRUD for uploads collection (legacy)
router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

// File upload endpoints → Firebase Storage + Firestore photoURL
router.post('/driver-photo/:driverId', uploadController.uploadDriverPhoto);
router.post('/delivery-note/:deliveryOrderId', uploadController.uploadDeliveryNote);
router.post('/warehouse-packaging/:warehouseJobId', uploadController.uploadWarehousePackagingPhoto);
router.post('/receipt-note/:weighRecordId', uploadController.uploadReceiptNote);
router.post('/inspection-photo/:deliveryOrderId', requireRoles(
  MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'inspector'
), uploadController.uploadInspectionPhoto);

// Wildcard route for driver-photo-weigh-out to handle jobIds with slashes
// (e.g., POMAT006/V003/D033/T033/J0001). Express would normally split on /
// and :jobId would only capture the first segment, causing a 404.
// The 0-9 wildcard captures the remaining path as req.params[0].
router.post('/driver-photo-weigh-out/(*)', uploadController.uploadDriverPhotoWeighOut);
router.post('/fuel-pump-photo/(*)', uploadController.uploadFuelPumpPhoto);

router.use(multerErrorHandler);

module.exports = router;

/**
 * Public Tracking Routes
 *
 * These routes are PUBLIC — no authentication middleware is applied.
 * Access is controlled solely by the validity and lifecycle of the tracking ID.
 */
const express = require('express');
const router = express.Router();
const trackingController = require('./controller');
const upload = require('../uploads/uploadMiddleware');
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireManagementAccess, requireRoles, MANAGEMENT_ROLES } = require('../../middleware/authorizationMiddleware');

router.post('/sessions', trackingController.startSecuritySession);
router.post('/sessions/:sessionId/vehicle', upload.single('file'), upload.validateUploadedFile, trackingController.attachSecuritySessionVehicle);
router.post('/sessions/:sessionId/decision', trackingController.recordSecurityDecision);
router.get('/flags', verifyToken, requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, MANAGEMENT_ROLES.ADMIN_LITE, 'operator_site'), trackingController.listFlags);
router.post('/flags/:id/clear', verifyToken, requireManagementAccess({ write: true, allowAdminWrite: true }), trackingController.clearFlag);
router.get('/security-personnel', verifyToken, requireManagementAccess({ write: true, allowAdminWrite: true }), trackingController.listSecurityPersonnel);
router.post('/security-personnel', verifyToken, requireManagementAccess({ write: true, allowAdminWrite: true }), trackingController.createSecurityPersonnel);

// GET /track/by-plate/:plateNumber — public, no auth required
router.get('/by-plate/:plateNumber', trackingController.getTrackingByPlate);

// GET /track/:trackingId — public, no auth required
router.get('/:trackingId', trackingController.getTrackingPage);

module.exports = router;

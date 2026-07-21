/**
 * Public Tracking Routes
 *
 * These routes are PUBLIC — no authentication middleware is applied.
 * Access is controlled solely by the validity and lifecycle of the tracking ID.
 */
const express = require('express');
const router = express.Router();
const trackingController = require('./controller');

// GET /track/by-plate/:plateNumber — public, no auth required
router.get('/by-plate/:plateNumber', trackingController.getTrackingByPlate);

// GET /track/:trackingId — public, no auth required
router.get('/:trackingId', trackingController.getTrackingPage);

module.exports = router;

const express = require('express');
const router = express.Router();
const siteController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', siteController.findAll);
router.get('/:id', siteController.findById);
router.post('/', siteController.create);
router.put('/:id', siteController.update);
router.delete('/:id', siteController.delete);

// ─── Site Operator Geolocation ──────────────────────────────────
// POST /api/sites/geolocation — site operator records their current GPS position
router.post('/geolocation', siteController.recordGeolocation);

// GET /api/sites/:id/geolocations — fetch geolocation history for a site
router.get('/:id/geolocations', siteController.getGeolocations);

module.exports = router;
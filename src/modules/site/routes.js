const express = require('express');
const router = express.Router();
const siteController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_site'));

router.get('/', siteController.findAll);
router.get('/:id', siteController.findById);
router.post('/', requireManagementAccess({ write: true }), siteController.create);
router.put('/:id', requireManagementAccess({ write: true }), siteController.update);
router.delete('/:id', requireManagementAccess({ write: true }), siteController.delete);

// ─── Site Operator Geolocation ──────────────────────────────────
// POST /api/sites/geolocation — site operator records their current GPS position
router.post('/geolocation', siteController.recordGeolocation);

// GET /api/sites/:id/geolocations — fetch geolocation history for a site
router.get('/:id/geolocations', siteController.getGeolocations);

module.exports = router;

const siteService = require('./service');
const { db } = require('../../../config/firebase');

/**
 * Look up the user's entity (site) from the users collection.
 */
async function getUserSite(email) {
  if (!email) return null;
  const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (userSnap.empty) return null;
  return userSnap.docs[0].data();
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await siteService.findAll(req.query);
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await siteService.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await siteService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await siteService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await siteService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

// ─── Geolocation ────────────────────────────────────────────────

/**
 * POST /api/sites/geolocation
 *
 * Body: { latitude, longitude, accuracy?, siteId? }
 * If siteId is not provided, it is derived from the user's role (site_operator).
 *
 * Records the operator's GPS position at the site.
 * Stored in the `siteGeolocations` collection for audit/verification.
 */
exports.recordGeolocation = async (req, res, next) => {
  try {
    const { latitude, longitude, accuracy, siteId: bodySiteId, operatorName, notes } = req.body;
    const userEmail = req.user?.email || req.user?.user_email || '';
    const userDisplayName = req.user?.name || req.user?.displayName || 'Unknown Operator';

    // Validate coordinates
    if (latitude == null || longitude == null) {
      return res.status(400).json({
        error: 'latitude and longitude are required.',
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({
        error: 'latitude and longitude must be valid numbers.',
      });
    }

    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        error: 'Coordinates out of valid range.',
      });
    }

    // Determine siteId — from body, or from the user's role assignment
    let siteId = bodySiteId || null;

    if (!siteId && userEmail) {
      const userEntity = await getUserSite(userEmail);
      if (userEntity?.siteId) {
        siteId = userEntity.siteId;
      }
    }

    if (!siteId) {
      return res.status(400).json({
        error: 'siteId is required. Either provide it in the request body or ensure your user account is assigned to a site.',
      });
    }

    // Verify the site exists
    const site = await db.collection('sites').doc(siteId).get();
    if (!site.exists) {
      return res.status(404).json({ error: `Site ${siteId} not found.` });
    }

    const geolocationRecord = await siteService.recordGeolocation({
      siteId,
      latitude: lat,
      longitude: lng,
      accuracy: accuracy != null ? parseFloat(accuracy) : null,
      operatorEmail: userEmail,
      operatorName: operatorName || userDisplayName,
      notes: notes || '',
      recordedBy: userEmail,
    });

    res.status(201).json(geolocationRecord);
  } catch (err) { next(err); }
};

/**
 * GET /api/sites/:id/geolocations
 *
 * Returns paginated geolocation records for a specific site.
 * Query params: page, limit, from, to (ISO date strings)
 */
exports.getGeolocations = async (req, res, next) => {
  try {
    const { id: siteId } = req.params;
    const { page = 1, limit = 50, from, to } = req.query;

    // Verify the site exists
    const site = await db.collection('sites').doc(siteId).get();
    if (!site.exists) {
      return res.status(404).json({ error: `Site ${siteId} not found.` });
    }

    const result = await siteService.getGeolocations(siteId, { page, limit, from, to });
    res.json(result);
  } catch (err) { next(err); }
};
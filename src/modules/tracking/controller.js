/**
 * Public Tracking Controller
 *
 * Handles public (unauthenticated) tracking page requests.
 * These endpoints DO NOT require authentication — they are public URLs.
 */

const trackingService = require('./service');
const { isValidTrackingId } = require('../../utils/trackingUtils');

/**
 * GET /track/:trackingId
 *
 * Public endpoint to fetch tracking data for a delivery job.
 * Returns 404 if:
 *   - The tracking ID format is invalid
 *   - No delivery order matches the tracking ID
 *   - The delivery is no longer in an active (in-transit) state
 *
 * No authentication required — this is a public URL.
 */
exports.getTrackingPage = async (req, res, next) => {
  try {
    const { trackingId } = req.params;

    // Validate tracking ID format
    if (!trackingId || !isValidTrackingId(trackingId)) {
      return res.status(404).json({
        error: 'This tracking link is invalid or has expired.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    // Look up the delivery order
    const order = trackingService.findByTrackingId(trackingId);

    if (!order) {
      return res.status(404).json({
        error: 'This tracking link has expired or is no longer active.',
        code: 'TRACKING_EXPIRED',
      });
    }

    // Return sanitized public data
    const publicData = trackingService.sanitizeForPublic(order);
    return res.json(publicData);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /track/by-plate/:plateNumber
 *
 * Public endpoint to fetch tracking data by vehicle plate number.
 */
exports.getTrackingByPlate = async (req, res, next) => {
  try {
    const { plateNumber } = req.params;

    if (!plateNumber || plateNumber.length < 3) {
      return res.status(404).json({
        error: 'No active delivery found for this vehicle plate.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    const order = trackingService.findByPlate(plateNumber);

    if (!order) {
      return res.status(404).json({
        error: 'No active delivery found for this vehicle plate.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    const publicData = trackingService.sanitizeForPublic(order);
    return res.json(publicData);
  } catch (err) {
    next(err);
  }
};

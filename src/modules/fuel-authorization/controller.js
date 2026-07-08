const fuelAuthService = require('./service');

/**
 * POST /api/fuel-authorization/request
 * Operator initiates a fuel authorization request.
 * Body: { vendorId, vendorName, vendorPhone, driverId, driverName, driverPhone, vehicleId, plateNumber, fuelAmount, jobId }
 */
exports.requestAuthorization = async (req, res, next) => {
  try {
    const { email, displayName, name } = req.user || {};
    const payload = {
      ...req.body,
      requestedBy: req.body.requestedBy || displayName || name || email || 'Fuel Operator',
      requestedByEmail: req.body.requestedByEmail || email || '',
    };
    const result = await fuelAuthService.createAuthorization(payload);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/fuel-authorization/verify
 * Vendor verifies OTP and authorizes or denies fuel.
 * Body: { authId, otp, authorize (boolean) }
 */
exports.verifyAuthorization = async (req, res, next) => {
  try {
    const { authId, otp, authorize } = req.body;
    if (!authId) return res.status(400).json({ error: 'authId is required' });
    if (!otp) return res.status(400).json({ error: 'OTP is required' });
    if (authorize === undefined) return res.status(400).json({ error: 'authorize (boolean) is required' });

    const result = await fuelAuthService.verifyOTP(authId, otp, authorize);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/fuel-authorization/status/:authId
 * Operator polls to check authorization status.
 */
exports.getStatus = async (req, res, next) => {
  try {
    const result = await fuelAuthService.getAuthorizationStatus(req.params.authId);
    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/fuel-authorization/pending/:vendorId
 * Get all pending authorizations for a vendor.
 */
exports.getPending = async (req, res, next) => {
  try {
    const { vendorId } = req.params;
    // Scoped: vendor can only see their own pending requests
    const { role, email } = req.user || {};
    const { db } = require('../../../config/firebase');
    let effectiveVendorId = vendorId;

    if (role === 'vendor') {
      const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!userSnap.empty) {
        const userDoc = userSnap.docs[0].data();
        effectiveVendorId = userDoc.vendorId || vendorId;
      }
    }

    const results = await fuelAuthService.getPendingForVendor(effectiveVendorId);
    res.json(results);
  } catch (err) {
    next(err);
  }
};
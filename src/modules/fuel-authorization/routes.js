const express = require('express');
const router = express.Router();
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

// Operator: request fuel authorization (sends OTP to vendor)
router.post('/request', controller.requestAuthorization);

// Vendor: verify OTP and authorize/deny
router.post('/verify', controller.verifyAuthorization);

// Operator: poll authorization status
router.get('/status/:authId', controller.getStatus);

// Vendor: get pending authorizations
router.get('/pending/:vendorId', controller.getPending);

module.exports = router;
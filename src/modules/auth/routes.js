const express = require('express');
const router = express.Router();
const authController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

// Register new user (creates Firebase Auth user + custom claims for role)
router.post('/register', authController.register);

// Login with email + password → backend proxies to Firebase Auth REST API
router.post('/login', authController.login);

// Get current user profile (requires valid token in Authorization header)
router.get('/profile', verifyToken, authController.getProfile);

// Update user role (admin only)
router.put('/role', verifyToken, authController.updateRole);

module.exports = router;

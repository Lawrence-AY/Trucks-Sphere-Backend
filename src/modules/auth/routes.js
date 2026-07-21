const express = require('express');
const router = express.Router();
const authController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

// Register new user (creates Firebase Auth user + custom claims for role)
router.post('/register', verifyToken, requireManagementAccess({ write: true }), authController.register);

// Login with email + password → backend proxies to Firebase Auth REST API
router.post('/login', authController.login);
router.post('/password-reset', authController.requestPasswordReset);

// Logout (JWT is stateless — client clears token; no server-side invalidation needed)
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// Get current user profile (requires valid token in Authorization header)
router.get('/profile', verifyToken, authController.getProfile);

// Update user profile (display name, phone, etc.)
router.put('/profile', verifyToken, authController.updateProfile);

// Update user role (admin only)
router.put('/role', verifyToken, authController.updateRole);

// Change password (authenticated user)
router.post('/change-password', verifyToken, authController.changePassword);

module.exports = router;

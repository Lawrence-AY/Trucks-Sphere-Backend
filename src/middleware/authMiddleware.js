const admin = require('../../config/firebase');
const { getAuth } = require('firebase-admin/auth');

/**
 * Verify Firebase ID token from Authorization header
 */
async function verifyToken(req, res, next) {
  try {
    if (!admin.apps.length) {
      return res.status(503).json({ error: 'Legacy Firebase authentication is not configured' });
    }

    const auth = getAuth();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await auth.verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      name: decodedToken.name || decodedToken.email?.split('@')[0] || 'User',
      role: decodedToken.role || 'management',
      phone: decodedToken.phone_number || '',
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Role-based access middleware
 * @param  {...string} roles - Allowed roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${roles.join(', ')}` });
    }
    next();
  };
}

module.exports = { verifyToken, requireRole };

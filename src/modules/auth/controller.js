const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const authService = require('./service');

exports.register = async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body;
    const user = await authService.createUser(email, password, name, role);
    res.status(201).json({ message: 'User created', user });
  } catch (err) {
    next(err);
  }
};

/**
 * Login: Accept email + password, verify against Firebase Auth,
 * then return user profile with role from custom claims or Firestore.
 */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Use Firebase Admin SDK to verify credentials
    // Note: Firebase Admin SDK doesn't have signInWithEmailAndPassword.
    // Instead, we use the Firebase Auth REST API.
    const firebaseApiKey = process.env.FIREBASE_API_KEY || 'AIzaSyATEU61bk0_DNuEBui15djMTvlGmSv_5fc';
    
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error?.message === 'EMAIL_NOT_FOUND' || data.error?.message === 'INVALID_PASSWORD'
        ? 'Invalid email or password'
        : data.error?.message || 'Authentication failed';
      return res.status(401).json({ error: errorMsg });
    }

    // Get user details from Firebase Admin
    const userRecord = await getAuth().getUser(data.localId);
    const role = userRecord.customClaims?.role || 'management';

    const user = {
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName || email.split('@')[0],
      role,
      phone: userRecord.phoneNumber || '',
    };

    res.json({
      user,
      token: data.idToken,
      refreshToken: data.refreshToken,
    });
  } catch (err) {
    // Fallback for when Firebase is not configured
    if (err.code === 'app/no-app' || err.message?.includes('credential')) {
      const { MOCK_USERS } = require('./service');
      const match = MOCK_USERS[email?.toLowerCase()];
      if (!match || password?.length < 4) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      return res.json({
        user: {
          uid: `mock_${email}`,
          email: email.toLowerCase(),
          displayName: match.displayName,
          role: match.role,
        },
        token: `mock_token_${Date.now()}`,
      });
    }
    next(err);
  }
};

exports.getProfile = async (req, res) => {
  res.json({ user: req.user });
};

exports.updateRole = async (req, res, next) => {
  try {
    const { uid, role } = req.body;
    if (!['management', 'operator_quarry', 'operator_site', 'vendor'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await getAuth().setCustomUserClaims(uid, { role });
    res.json({ message: `Role updated to ${role}` });
  } catch (err) {
    next(err);
  }
};

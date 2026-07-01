const { getAuth } = require('firebase-admin/auth');

exports.register = async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }
    const VALID_ROLES = ['management', 'operator_quarry', 'operator_site', 'vendor'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role: ${role}` });
    }
    const userRecord = await getAuth().createUser({
      email,
      password,
      displayName: name,
    });
    await getAuth().setCustomUserClaims(userRecord.uid, { role });
    res.status(201).json({
      message: 'User created',
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        name: userRecord.displayName,
        role,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'User with this email already exists' });
    }
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Convert username to email: if already an email, use as-is; otherwise append @truck.com
    const email = username.includes('@') ? username : `${username}@truck.com`;

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
      const firebaseError = data.error?.message || '';
      const isAuthError = ['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'INVALID_EMAIL', 'USER_DISABLED'].includes(firebaseError);
      const errorMsg = isAuthError ? 'Invalid username or password' : (firebaseError || 'Authentication failed');
      return res.status(401).json({ error: errorMsg });
    }

    const userRecord = await getAuth().getUser(data.localId);
    const role = userRecord.customClaims?.role || 'management';

    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email.split('@')[0],
        role,
        phone: userRecord.phoneNumber || '',
      },
      token: data.idToken,
      refreshToken: data.refreshToken,
    });
  } catch (err) {
    console.error('Login error:', err);
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
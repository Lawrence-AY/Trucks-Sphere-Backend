const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');

exports.register = async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name required' });
    }
    const VALID_ROLES = ['management', 'operator_quarry', 'operator_site', 'vendor', 'operator_fuel'];
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

/**
 * Resolve vendorId / quarryId / siteId from Firestore for role-based users
 */
async function resolveEntityIds(email, role) {
  const ids = {};
  try {
    // First, try to resolve from the users collection (seeded with vendorId/quarryId/siteId)
    const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    let userDoc = null;
    if (!usersSnap.empty) {
      userDoc = usersSnap.docs[0].data();
    }

    if (role === 'vendor') {
      // Try users collection first
      if (userDoc && userDoc.vendorId) {
        ids.vendorId = userDoc.vendorId;
      } else {
        // Fallback: look up vendor by email in vendors collection
        const vendorsSnap = await db.collection('vendors').where('email', '==', email).limit(1).get();
        if (!vendorsSnap.empty) {
          ids.vendorId = vendorsSnap.docs[0].id;
        }
      }
    } else if (role === 'operator_quarry') {
      if (userDoc && userDoc.quarryId) {
        ids.quarryId = userDoc.quarryId;
      } else {
        const quarriesSnap = await db.collection('quarries').where('email', '==', email).limit(1).get();
        if (!quarriesSnap.empty) {
          ids.quarryId = quarriesSnap.docs[0].id;
        }
      }
    } else if (role === 'operator_site') {
      if (userDoc && userDoc.siteId) {
        ids.siteId = userDoc.siteId;
      } else {
        const sitesSnap = await db.collection('sites').where('email', '==', email).limit(1).get();
        if (!sitesSnap.empty) {
          ids.siteId = sitesSnap.docs[0].id;
        }
      }
    } else if (role === 'operator_fuel') {
      // Resolve fuel station/operator ID from users collection
      if (userDoc && userDoc.fuelStationId) {
        ids.fuelStationId = userDoc.fuelStationId;
      }
      // Also set a generic operatorId for fuel records
      if (userDoc && userDoc.id) {
        ids.fuelOperatorId = userDoc.id;
      }
    }
  } catch (err) {
    console.warn('resolveEntityIds: Failed to resolve entity for', email, role, err.message);
  }
  return ids;
}

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

    // Resolve vendorId / quarryId / siteId based on role + email
    const entityIds = await resolveEntityIds(email, role);

    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email.split('@')[0],
        role,
        phone: userRecord.phoneNumber || '',
        ...entityIds,
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
  try {
    const { uid, email, role } = req.user;
    const userRecord = await getAuth().getUser(uid);
    const entityIds = await resolveEntityIds(email, role);
    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email?.split('@')[0] || '',
        role,
        phone: userRecord.phoneNumber || '',
        ...entityIds,
      },
    });
  } catch (err) {
    console.error('getProfile error:', err);
    // Fallback with minimal data
    const { uid, email, role } = req.user;
    const entityIds = await resolveEntityIds(email, role);
    res.json({ user: { uid, email, displayName: email?.split('@')[0] || '', role, phone: '', ...entityIds } });
  }
};

exports.updateRole = async (req, res, next) => {
  try {
    const { uid, role } = req.body;
    if (!['management', 'operator_quarry', 'operator_site', 'vendor', 'operator_fuel'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await getAuth().setCustomUserClaims(uid, { role });
    res.json({ message: `Role updated to ${role}` });
  } catch (err) {
    next(err);
  }
};
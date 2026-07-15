const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');

/**
 * Generate a unique username from firstName + first 3 letters of lastName.
 * Strips special chars, handles short last names, resolves collisions.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @returns {Promise<string>} Generated unique username (lowercase)
 */
async function generateUsername(firstName, lastName) {
  // Sanitize: strip spaces, hyphens, special chars, convert to lowercase
  const sanitize = (str) => (str || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const first = sanitize(firstName);
  const last = sanitize(lastName);

  if (!first) throw Object.assign(new Error('First name is required to generate username'), { statusCode: 400 });

  // Build base: firstName + first 3 of lastName (or full if < 3)
  const lastPart = last.slice(0, Math.min(3, last.length));
  let base = `${first}${lastPart}`;

  // Check for collisions in Firestore users collection
  let username = base;
  let counter = 1;
  let collision = true;

  while (collision) {
    const snap = await db.collection('users').where('generatedUsername', '==', username).limit(1).get();
    if (snap.empty) {
      collision = false;
    } else {
      username = `${base}${counter}`;
      counter++;
    }
  }

  return username;
}

exports.register = async (req, res, next) => {
  try {
    const { email, password, name, firstName, lastName, role, displayName: reqDisplayName } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    const VALID_ROLES = ['management', 'operator_quarry', 'operator_site', 'vendor', 'operator_fuel', 'quarry_operator', 'site_operator', 'fuel_operator', 'weighbridge_operator', 'driver', 'viewer'];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role: "${role}". Valid roles: ${VALID_ROLES.join(', ')}` });
    }

    // Auto-generate email if not provided
    const displayName = reqDisplayName || name || (firstName && lastName ? `${firstName} ${lastName}` : email ? email.split('@')[0] : 'User');
    const userEmail = email || `${displayName.toLowerCase().replace(/[^a-z0-9]/g, '')}@trucksphere.user`;

    // Auto-generate username from firstName + lastName
    const generatedUsername = await generateUsername(
      firstName || displayName.split(' ')[0],
      lastName || displayName.split(' ').slice(1).join(' ') || 'user',
    );

    // Create Firebase Auth user
    const userRecord = await getAuth().createUser({
      email: userEmail,
      password,
      displayName,
    });
    await getAuth().setCustomUserClaims(userRecord.uid, { role });

    // Store user profile in Firestore (including generated username, authUid maps to Firebase UID)
    const userDoc = {
      uid: userRecord.uid,
      authUid: userRecord.uid,      // Maps registration UID directly to authUid field
      email: userEmail,
      displayName,
      generatedUsername,
      phone: req.body.phone || '',
      firstName: firstName || displayName.split(' ')[0],
      lastName: lastName || displayName.split(' ').slice(1).join(' ') || '',
      role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.collection('users').doc(userRecord.uid).set(userDoc);

    res.status(201).json({
      message: 'User created',
      user: {
        uid: userRecord.uid,
        authUid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName,
        generatedUsername,
        phone: req.body.phone || '',
        role,
        phone: phone || '',
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
 * POST /api/auth/change-password
 * Allows authenticated users to change their password.
 * Requires current password verification.
 * Immediately updates DB hashed password & invalidates existing sessions.
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const { uid, email } = req.user;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Current password, new password, and confirm password are required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirm password do not match.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password.' });
    }

    // Verify current password via Firebase Auth REST API sign-in
    const firebaseApiKey = process.env.FIREBASE_API_KEY || 'AIzaSyATEU61bk0_DNuEBui15djMTvlGmSv_5fc';
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: currentPassword, returnSecureToken: false }),
      }
    );

    if (!verifyRes.ok) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    // Update password via Firebase Admin SDK (immediately updates hashed password in Auth DB)
    await getAuth().updateUser(uid, { password: newPassword });

    // Invalidate all existing sessions by revoking refresh tokens
    // This forces the user to re-login with the new password on next cycle
    try {
      await getAuth().revokeRefreshTokens(uid);
      console.log(`[Auth] Refresh tokens revoked for user ${uid} after password change`);
    } catch (revokeErr) {
      console.warn(`[Auth] Failed to revoke refresh tokens for ${uid}:`, revokeErr.message);
      // Non-fatal — password update still succeeded
    }

    // Also update the passwordChangedAt timestamp in Firestore user doc
    try {
      await db.collection('users').doc(uid).update({
        passwordChangedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.warn(`[Auth] Failed to update Firestore password timestamp for ${uid}:`, dbErr.message);
      // Non-fatal
    }

    res.json({ message: 'Password updated successfully. Please log in again with your new password.' });
  } catch (err) {
    console.error('Change password error:', err);
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

    // Reject email-style logins — enforce username-only authentication
    if (username.includes('@')) {
      return res.status(400).json({ error: 'Please use your username (not email) to log in.' });
    }

    // Look up the user by generatedUsername in Firestore to resolve their email
    const userSnap = await db.collection('users')
      .where('generatedUsername', '==', username.toLowerCase())
      .limit(1)
      .get();

    let email;
    let userDocData = null;
    let needsBackfill = false;

    if (!userSnap.empty) {
      // Fast path: user has generatedUsername field
      userDocData = userSnap.docs[0].data();
      email = userDocData.email;
    } else {
      // Backward-compatible fallback: legacy users without generatedUsername
      // Try resolving via the old email convention (username@truck.com)
      const fallbackEmail = `${username.toLowerCase()}@truck.com`;
      try {
        const legacySnap = await db.collection('users')
          .where('email', '==', fallbackEmail)
          .limit(1)
          .get();

        if (!legacySnap.empty) {
          userDocData = legacySnap.docs[0].data();
          email = fallbackEmail;
          needsBackfill = true;
          // Backfill generatedUsername for future fast-path logins
          try {
            await db.collection('users').doc(legacySnap.docs[0].id).update({
              generatedUsername: username.toLowerCase(),
            });
            console.log(`[Auth] Backfilled generatedUsername for legacy user: ${username}`);
          } catch (backfillErr) {
            console.warn(`[Auth] Failed to backfill generatedUsername for ${username}:`, backfillErr.message);
          }
        } else {
          return res.status(401).json({ error: 'Invalid username or password' });
        }
      } catch (legacyErr) {
        console.warn('[Auth] Legacy user lookup failed:', legacyErr.message);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
    }

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

    // Look up user profile from Firestore for username, phone
    let firestoreProfile = {};
    try {
      const profileSnap = await db.collection('users').doc(userRecord.uid).get();
      if (profileSnap.exists) {
        const profile = profileSnap.data();
        firestoreProfile = {
          username: profile.username || null,
          phone: profile.phone || userRecord.phoneNumber || '',
          phoneNumber: profile.phoneNumber || userRecord.phoneNumber || '',
        };
      }
    } catch {
      // Non-blocking
    }

    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email.split('@')[0],
        role,
        phone: firestoreProfile.phone || userRecord.phoneNumber || '',
        username: firestoreProfile.username || null,
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

    // Look up user profile from Firestore for username
    let firestoreProfile = {};
    try {
      const profileSnap = await db.collection('users').doc(uid).get();
      if (profileSnap.exists) {
        const profile = profileSnap.data();
        firestoreProfile = {
          username: profile.username || null,
          phone: profile.phone || userRecord.phoneNumber || '',
        };
      }
    } catch {
      // Non-blocking
    }

    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName || email?.split('@')[0] || '',
        role,
        username: firestoreProfile.username || null,
        phone: firestoreProfile.phone || userRecord.phoneNumber || '',
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

exports.updateProfile = async (req, res) => {
  try {
    const { uid, email, role } = req.user;
    const { displayName, phone, email: newEmail } = req.body;

    const updates = {};
    if (displayName) {
      updates.displayName = displayName;
      // Also update Firebase Auth display name
      try {
        await getAuth().updateUser(uid, { displayName });
      } catch (authErr) {
        console.warn('Failed to update Firebase Auth displayName:', authErr.message);
      }
    }
    if (phone !== undefined) {
      updates.phone = phone;
    }
    if (newEmail) {
      updates.email = newEmail;
    }
    updates.updatedAt = new Date().toISOString();

    await db.collection('users').doc(uid).set(updates, { merge: true });

    const entityIds = await resolveEntityIds(email, role);
    res.json({
      user: {
        uid,
        email: newEmail || email,
        displayName: displayName || req.user.displayName || email?.split('@')[0] || '',
        role,
        phone: phone || req.user.phone || '',
        ...entityIds,
      },
      message: 'Profile updated successfully',
    });
  } catch (err) {
    console.error('updateProfile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
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
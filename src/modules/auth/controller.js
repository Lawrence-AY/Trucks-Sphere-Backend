const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');
const cryptoUtils = require('../../utils/cryptoUtils');
const { assertStrongPassword } = require('../../utils/passwordPolicy');
const refreshTokenService = require('./refreshTokenService');
const { logAudit } = require('../../middleware/auditMiddleware');
const { MANAGEMENT_ROLES, normalizeRole } = require('../../middleware/authorizationMiddleware');
const { normalizeQuarryLocation } = require('../../utils/quarryLocations');
const { scheduleAccountDeletion, cancelScheduledDeletion } = require('./accountDeletionService');

const VALID_ROLES = [
  MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.EDIT, MANAGEMENT_ROLES.LITE,
  'operator_quarry', 'operator_site', 'vendor', 'operator_fuel', 'operator_warehouse',
  'quarry_operator', 'site_operator', 'fuel_operator', 'warehouse_operator', 'weighbridge_operator', 'viewer',
];

function getFirebaseApiKey() {
  const firebaseApiKey = String(process.env.FIREBASE_API_KEY || '').trim();
  if (!firebaseApiKey) {
    const error = new Error('FIREBASE_API_KEY is not configured.');
    error.statusCode = 500;
    error.code = 'SECURITY_CONFIGURATION_ERROR';
    throw error;
  }
  return firebaseApiKey;
}

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
    assertStrongPassword(password);
    const normalizedRole = normalizeRole(role);
    if (
      normalizeRole(req.user?.role) === MANAGEMENT_ROLES.EDIT &&
      normalizedRole === MANAGEMENT_ROLES.SUPER_ADMIN
    ) {
      return res.status(403).json({ error: 'Management Edit cannot create Super Admin users.' });
    }
    if (!VALID_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: `Invalid role: "${role}". Valid roles: ${VALID_ROLES.join(', ')}` });
    }
    if (normalizedRole === 'vendor') {
      return res.status(400).json({ error: 'Vendor accounts must be created together with a vendor profile.' });
    }
    const quarryLocation = normalizeQuarryLocation(req.body.quarryLocation);
    if (normalizedRole === 'operator_quarry' && !quarryLocation) {
      return res.status(400).json({ error: 'A valid quarry station is required for an operator at quarry.' });
    }

    const displayName = reqDisplayName || name || (firstName && lastName ? `${firstName} ${lastName}` : 'User');

    // Auto-generate username from firstName + lastName
    const generatedUsername = await generateUsername(
      firstName || displayName.split(' ')[0],
      lastName || displayName.split(' ').slice(1).join(' ') || 'user',
    );
    // Firebase password sign-in needs an internal address. Keep it separate
    // from the user's visible, initially blank profile email.
    const authEmail = `${generatedUsername}@users.trucksphere.local`;

    // Create Firebase Auth user
    const userRecord = await getAuth().createUser({
      email: authEmail,
      password,
      displayName,
    });
    await getAuth().setCustomUserClaims(userRecord.uid, { role: normalizedRole });

    // Store user profile in Firestore (including generated username, authUid maps to Firebase UID)
    const userDoc = {
      uid: userRecord.uid,
      authUid: userRecord.uid,      // Maps registration UID directly to authUid field
      email: '',
      authEmail,
      displayName,
      generatedUsername,
      phone: req.body.phone || '',
      firstName: firstName || displayName.split(' ')[0],
      lastName: lastName || displayName.split(' ').slice(1).join(' ') || '',
      role: normalizedRole,
      quarryLocation,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.collection('users').doc(userRecord.uid).set(userDoc);

    res.status(201).json({
      message: 'User created',
      user: {
        uid: userRecord.uid,
        authUid: userRecord.uid,
        email: '',
        displayName: userRecord.displayName,
        generatedUsername,
      phone: req.body.phone || '',
      role: normalizedRole,
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
    assertStrongPassword(newPassword);
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password.' });
    }

    // Verify current password via Firebase Auth REST API sign-in
    const firebaseApiKey = getFirebaseApiKey();
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
 * Start or restart the 21-day account-deletion recovery period for the caller.
 * The due-job removes the Firebase identity and the user's Truck Sphere profile.
 * Operational records are governed by the organisation's documented retention
 * obligations and are not treated as an active account after profile deletion.
 */
exports.requestAccountDeletion = async (req, res, next) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: 'Account deletion must be explicitly confirmed.' });
    }
    const deletion = await scheduleAccountDeletion(req.user.uid);
    logAudit({
      action: 'user.account_deletion_requested',
      entityType: 'user',
      entityId: req.user.uid,
      severity: 'warning',
      metadata: { scheduledFor: deletion.scheduledFor },
      req,
    }).catch(() => {});
    return res.json({
      message: 'Your sign-in credentials and Truck Sphere profile are scheduled for deletion. Signing in again before the scheduled date will cancel this request. Operational records may be retained where required by contractual, tax, safety, or legal obligations.',
      ...deletion,
    });
  } catch (error) {
    next(error);
  }
};

/** Public, rate-limited and deliberately neutral password-reset request. */
exports.requestPasswordReset = async (req, res) => {
  const neutral = { message: 'If an account matches those details, a password-reset link has been sent.' };
  try {
    const identifier = String(req.body?.identifier || req.body?.email || req.body?.username || '').trim().toLowerCase();
    if (!identifier) return res.status(400).json({ error: 'Email or username is required.' });
    let email = identifier.includes('@') ? identifier : '';
    if (!email) {
      const result = await db.collection('users').where('generatedUsername', '==', identifier).limit(1).get();
      if (!result.empty) email = result.docs[0].data().authEmail || result.docs[0].data().email || '';
    }
    const firebaseApiKey = getFirebaseApiKey();
    if (email) {
      await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${firebaseApiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
      });
      logAudit({ action: 'user.password_reset_requested', entityType: 'user', entityId: email, severity: 'info', metadata: {}, req }).catch(() => {});
    }
  } catch (error) {
    console.warn('[Auth] password reset request failed:', error.message);
  }
  return res.json(neutral);
};

// Verifies a Firebase password-reset OOB code without exposing account details.
// The route is protected by the dedicated passwordResetRateLimiter.
exports.verifyPasswordResetCode = async (req, res) => {
  try {
    const oobCode = String(req.body?.oobCode || '').trim();
    if (!oobCode) return res.status(400).json({ error: 'Reset code is required.' });
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${getFirebaseApiKey()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode }),
      },
    );
    if (!response.ok) return res.status(400).json({ error: 'Invalid or expired reset code.' });
    return res.json({ valid: true });
  } catch (error) {
    if (error.code === 'SECURITY_CONFIGURATION_ERROR') {
      return res.status(500).json({ error: 'Password reset is temporarily unavailable.' });
    }
    return res.status(400).json({ error: 'Invalid or expired reset code.' });
  }
};

/**
 * Resolve vendorId / quarryId / siteId from Firestore for role-based users
 */
async function resolveEntityIds(email, role) {
  const ids = {};
  try {
    // First, try to resolve from the users collection (seeded with vendorId/quarryId/siteId)
    let usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (usersSnap.empty && email) {
      usersSnap = await db.collection('users').where('authEmail', '==', email).limit(1).get();
    }
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
      if (userDoc && userDoc.quarryLocation) {
        ids.quarryLocation = userDoc.quarryLocation;
      }
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
      return res.status(400).json({ error: 'Username or email and password required' });
    }

    const isEmail = username.includes('@');
    let email;
    let userDocData = null;

    if (isEmail) {
      // Email-based login — look up directly by email
      const emailSnap = await db.collection('users')
        .where('email', '==', username.toLowerCase())
        .limit(1)
        .get();

      if (!emailSnap.empty) {
        userDocData = emailSnap.docs[0].data();
        email = userDocData.authEmail || userDocData.email;
      } else {
        // Also try authEmail field
        const authEmailSnap = await db.collection('users')
          .where('authEmail', '==', username.toLowerCase())
          .limit(1)
          .get();
        if (!authEmailSnap.empty) {
          userDocData = authEmailSnap.docs[0].data();
          email = userDocData.authEmail || userDocData.email;
        } else {
          return res.status(401).json({ error: 'Invalid email or password' });
        }
      }
    } else {
      // Username-based login — look up by generatedUsername
      const userSnap = await db.collection('users')
        .where('generatedUsername', '==', username.toLowerCase())
        .limit(1)
        .get();

      if (!userSnap.empty) {
        userDocData = userSnap.docs[0].data();
        email = userDocData.authEmail || userDocData.email;
      } else {
        // Backward-compatible fallback: legacy users without generatedUsername
        const fallbackEmail = `${username.toLowerCase()}@truck.com`;
        try {
          const legacySnap = await db.collection('users')
            .where('email', '==', fallbackEmail)
            .limit(1)
            .get();

          if (!legacySnap.empty) {
            userDocData = legacySnap.docs[0].data();
            email = fallbackEmail;
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
    }

    const firebaseApiKey = getFirebaseApiKey();

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
    const deletionCancelled = await cancelScheduledDeletion(userRecord.uid);
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
          email: profile.email || '',
          phoneNumber: profile.phoneNumber || userRecord.phoneNumber || '',
        };
      }
    } catch {
      // Non-blocking
    }

    if (!data.refreshToken) throw new Error('Authentication provider did not return a refresh token.');
    const refreshSession = await refreshTokenService.issueRefreshSession({
      uid: userRecord.uid,
      firebaseRefreshToken: data.refreshToken,
    });

    // Log successful login to audit
    logAudit({
      action: 'user.login',
      entityType: 'user',
      entityId: userRecord.uid,
      severity: 'info',
      metadata: { email: userRecord.email, role },
      req,
    }).catch(() => {});
    if (deletionCancelled) {
      logAudit({ action: 'user.account_deletion_cancelled', entityType: 'user', entityId: userRecord.uid, severity: 'info', metadata: { reason: 'login' }, req }).catch(() => {});
    }

    res.json({
      user: {
        uid: userRecord.uid,
        email: userDocData?.email || '',
        displayName: userRecord.displayName || email.split('@')[0],
        role,
        phone: firestoreProfile.phone || userRecord.phoneNumber || '',
        username: firestoreProfile.username || null,
        ...entityIds,
      },
      token: data.idToken,
      refreshToken: refreshSession.refreshToken,
      refreshTokenExpiresIn: refreshSession.expiresInMs,
    });
  } catch (err) {
    console.error('Login error:', err);
    next(err);
  }
};

exports.refresh = async (req, res, next) => {
  const invalidResponse = () => res.status(401).json({ error: 'Invalid or expired refresh token.' });
  try {
    const active = await refreshTokenService.getActiveRefreshSession(req.body?.refreshToken);
    if (active.status === 'reused') {
      await refreshTokenService.revokeRefreshTokenFamily(active.session.record.familyId);
      await getAuth().revokeRefreshTokens(active.session.record.uid);
      logAudit({ action: 'user.refresh_token_reuse', entityType: 'user', entityId: active.session.record.uid, severity: 'warning', metadata: {}, req }).catch(() => {});
      return invalidResponse();
    }
    if (active.status !== 'active') return invalidResponse();

    const firebaseApiKey = getFirebaseApiKey();
    const firebaseRefreshToken = cryptoUtils.decrypt(active.session.record.encryptedFirebaseRefreshToken);
    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: firebaseRefreshToken }),
    });
    const data = await response.json();
    if (!response.ok || !data.refresh_token || !data.id_token) {
      await refreshTokenService.revokeRefreshTokenFamily(active.session.record.familyId, 'provider_refresh_failed');
      return invalidResponse();
    }

    const rotated = await refreshTokenService.rotateRefreshSession({
      session: active.session,
      firebaseRefreshToken: data.refresh_token,
    });
    if (rotated.reused) {
      await refreshTokenService.revokeRefreshTokenFamily(active.session.record.familyId);
      await getAuth().revokeRefreshTokens(active.session.record.uid);
      return invalidResponse();
    }

    return res.json({
      token: data.id_token,
      refreshToken: rotated.refreshToken,
      expiresIn: data.expires_in ? Number.parseInt(data.expires_in, 10) * 1000 : 3600000,
      refreshTokenExpiresIn: rotated.expiresInMs,
    });
  } catch (error) {
    if (error.code === 'SECURITY_CONFIGURATION_ERROR') return next(error);
    console.warn('[Auth] Refresh token failed:', error.message);
    return invalidResponse();
  }
};

exports.logout = async (req, res) => {
  try {
    if (req.body?.refreshToken) await refreshTokenService.revokeRefreshSession(req.body.refreshToken);
  } catch (error) {
    console.warn('[Auth] Logout session cleanup failed:', error.message);
  }
  return res.status(204).send();
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
        email: firestoreProfile.email || '',
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
      updates.authEmail = newEmail;
      try {
        await getAuth().updateUser(uid, { email: newEmail });
      } catch (authErr) {
        return res.status(400).json({ error: authErr.message || 'Unable to update email.' });
      }
    }
    updates.updatedAt = new Date().toISOString();

    await db.collection('users').doc(uid).set(updates, { merge: true });

    const entityIds = await resolveEntityIds(email, role);
    res.json({
      user: {
        uid,
        email: newEmail || '',
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
    if (normalizeRole(req.user?.role) !== MANAGEMENT_ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
    }
    const { uid, role } = req.body;
    const normalizedRole = normalizeRole(role);
    if (!VALID_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    await getAuth().setCustomUserClaims(uid, { role: normalizedRole });
    await db.collection('users').doc(uid).set({ role: normalizedRole, updatedAt: new Date().toISOString() }, { merge: true });
    res.json({ message: `Role updated to ${normalizedRole}` });
  } catch (err) {
    next(err);
  }
};

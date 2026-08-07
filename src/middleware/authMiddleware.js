// middleware/auth.js
const { auth, db } = require('../../config/firebase');
const { cancelScheduledDeletion } = require('../modules/auth/accountDeletionService');

const ENTITY_BY_ROLE = {
  vendor: ['vendorId', 'vendor'],
  operator_quarry: ['quarryId', 'quarry'],
  operator_site: ['siteId', 'site'],
  operator_fuel: ['fuelStationId', 'fuel_station'],
};

/**
 * Resolve a display-safe actor for an operational write.  This deliberately
 * comes from the authenticated token/profile rather than the request body so
 * clients cannot attribute an action to another user.
 */
async function resolveActor(decodedToken) {
  let profile = {};
  try {
    const profileDoc = await db.collection('users').doc(decodedToken.uid).get();
    profile = profileDoc.exists ? profileDoc.data() : {};
  } catch (error) {
    // A write must not be blocked by a missing profile document. Token claims
    // remain a trustworthy fallback.
    console.warn('[Auth] Could not resolve user profile for audit actor:', error.message);
  }

  const role = profile.role || decodedToken.role || '';
  const [entityField, entityType] = ENTITY_BY_ROLE[role] || [];
  const email = profile.email || decodedToken.email || '';
  return {
    uid: decodedToken.uid,
    username: profile.username || profile.generatedUsername || email.split('@')[0] || decodedToken.uid,
    displayName: profile.displayName || profile.name || decodedToken.name || email.split('@')[0] || 'Unknown user',
    email,
    role,
    ...(entityField && profile[entityField] ? { entityId: profile[entityField], entityType } : {}),
  };
}

function attachActorToWrite(req, actor) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.body || typeof req.body !== 'object') return;

  // Never accept actor fields supplied by the client. All protected writes get
  // the authenticated actor on both the record and status/cancellation updates.
  delete req.body.createdBy;
  delete req.body.updatedBy;
  delete req.body.createdByUid;
  delete req.body.updatedByUid;
  delete req.body.createdByUsername;
  delete req.body.updatedByUsername;
  delete req.body.createdByDisplayName;
  delete req.body.updatedByDisplayName;
  delete req.body.createdAt;
  delete req.body.updatedAt;

  req.body.updatedBy = actor;
  if (req.method === 'POST') req.body.createdBy = actor;
}

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    if (!req.path.endsWith('/account-deletion')) {
      cancelScheduledDeletion(decodedToken.uid).catch((error) => {
        console.warn('[Account deletion] Could not cancel scheduled deletion:', error.message);
      });
    }
    const actor = await resolveActor(decodedToken);
    req.user = { ...decodedToken, ...actor }; // attach token claims plus trusted profile data
    attachActorToWrite(req, actor);
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    const errorCode = error?.code || '';
    const errorMessage = error?.message || 'Unauthorized: Invalid token';
    res.status(401).json({
      error: errorMessage,
      errorInfo: {
        code: errorCode,
        message: errorMessage,
      },
      codePrefix: 'auth',
    });
  }
};

const verifyToken = authenticate;
module.exports = { authenticate, verifyToken, resolveActor };

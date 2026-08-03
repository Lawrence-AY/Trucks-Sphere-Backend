const crypto = require('crypto');
const { db } = require('../../../config/firebase');
const cryptoUtils = require('../../utils/cryptoUtils');

const COLLECTION = 'refreshTokenSessions';
const DEFAULT_TTL_DAYS = 30;

function refreshTokenTtlMs() {
  const configuredDays = Number.parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '', 10);
  const days = Number.isInteger(configuredDays) && configuredDays > 0 && configuredDays <= 90
    ? configuredDays
    : DEFAULT_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isExpired(session, now = Date.now()) {
  return !session.expiresAt || Date.parse(session.expiresAt) <= now;
}

function isInactive(session, now = Date.now()) {
  return Boolean(session.usedAt || session.revokedAt || isExpired(session, now));
}

function createSessionRecord({ token, uid, firebaseRefreshToken, familyId, now = new Date() }) {
  const expiresAt = new Date(now.getTime() + refreshTokenTtlMs()).toISOString();
  return {
    token,
    record: {
      uid,
      familyId: familyId || cryptoUtils.generateSecureToken(16),
      tokenHash: tokenHash(token),
      encryptedFirebaseRefreshToken: cryptoUtils.encrypt(firebaseRefreshToken),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
    },
  };
}

async function issueRefreshSession({ uid, firebaseRefreshToken }) {
  if (!uid || !firebaseRefreshToken) throw new Error('A user ID and Firebase refresh token are required.');
  const { token, record } = createSessionRecord({
    token: cryptoUtils.generateSecureToken(48),
    uid,
    firebaseRefreshToken,
  });
  await db.collection(COLLECTION).doc(record.tokenHash).create(record);
  return { refreshToken: token, expiresInMs: Date.parse(record.expiresAt) - Date.now() };
}

async function findSession(refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken.length < 64 || refreshToken.length > 256) return null;
  const hash = tokenHash(refreshToken);
  const ref = db.collection(COLLECTION).doc(hash);
  const snapshot = await ref.get();
  return snapshot.exists ? { ref, record: snapshot.data(), tokenHash: hash } : null;
}

async function getActiveRefreshSession(refreshToken) {
  const session = await findSession(refreshToken);
  if (!session) return { status: 'invalid' };
  if (session.record.usedAt) return { status: 'reused', session };
  if (isInactive(session.record)) return { status: 'invalid', session };
  return { status: 'active', session };
}

async function rotateRefreshSession({ session, firebaseRefreshToken }) {
  const { token, record: nextRecord } = createSessionRecord({
    token: cryptoUtils.generateSecureToken(48),
    uid: session.record.uid,
    firebaseRefreshToken,
    familyId: session.record.familyId,
  });
  const nextRef = db.collection(COLLECTION).doc(nextRecord.tokenHash);
  let reused = false;

  await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(session.ref);
    if (!currentSnapshot.exists || isInactive(currentSnapshot.data())) {
      reused = true;
      return;
    }
    transaction.update(session.ref, { usedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    transaction.create(nextRef, nextRecord);
  });

  if (reused) return { reused: true };
  return {
    reused: false,
    refreshToken: token,
    expiresInMs: Date.parse(nextRecord.expiresAt) - Date.now(),
  };
}

async function revokeRefreshSession(refreshToken, reason = 'logout') {
  const session = await findSession(refreshToken);
  if (!session || session.record.revokedAt) return false;
  await session.ref.update({ revokedAt: new Date().toISOString(), revokeReason: reason, updatedAt: new Date().toISOString() });
  return true;
}

async function revokeRefreshTokenFamily(familyId, reason = 'refresh_token_reuse') {
  if (!familyId) return;
  const snapshot = await db.collection(COLLECTION).where('familyId', '==', familyId).get();
  const batch = db.batch();
  const now = new Date().toISOString();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, { revokedAt: now, revokeReason: reason, updatedAt: now }));
  if (!snapshot.empty) await batch.commit();
}

module.exports = {
  issueRefreshSession,
  getActiveRefreshSession,
  rotateRefreshSession,
  revokeRefreshSession,
  revokeRefreshTokenFamily,
};

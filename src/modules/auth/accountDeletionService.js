const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');

const DELETION_DELAY_MS = 21 * 24 * 60 * 60 * 1000;

function deletionDates(now = new Date()) {
  const requestedAt = now.toISOString();
  return { requestedAt, scheduledFor: new Date(now.getTime() + DELETION_DELAY_MS).toISOString() };
}

async function scheduleAccountDeletion(uid) {
  const { requestedAt, scheduledFor } = deletionDates();
  await db.collection('users').doc(uid).set({
    accountDeletionRequestedAt: requestedAt,
    accountDeletionDueAt: scheduledFor,
    updatedAt: requestedAt,
  }, { merge: true });
  return { requestedAt, scheduledFor };
}

/** A successful signed-in interaction is an explicit decision to keep the account. */
async function cancelScheduledDeletion(uid) {
  const ref = db.collection('users').doc(uid);
  const snapshot = await ref.get();
  if (!snapshot.exists || !snapshot.data().accountDeletionDueAt) return false;
  await ref.update({
    accountDeletionRequestedAt: null,
    accountDeletionDueAt: null,
    accountDeletionCancelledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/** Permanently remove account identity/profile after the 21-day grace period. */
async function processDueAccountDeletions(now = new Date()) {
  const due = await db.collection('users').where('accountDeletionDueAt', '<=', now.toISOString()).get();
  let deleted = 0;
  for (const profile of due.docs) {
    const data = profile.data();
    const uid = data.uid || data.authUid || profile.id;
    try {
      await getAuth().deleteUser(uid);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') {
        console.error(`[Account deletion] Failed to delete auth user ${uid}:`, error.message);
        continue;
      }
    }
    await profile.ref.delete();
    deleted += 1;
  }
  return deleted;
}

module.exports = { DELETION_DELAY_MS, scheduleAccountDeletion, cancelScheduledDeletion, processDueAccountDeletions };

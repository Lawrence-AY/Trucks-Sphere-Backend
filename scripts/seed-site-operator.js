/*
 * Creates or updates one Site Operator (operator_site) account.
 *
 * The operator_site role already has read/write access to the shared site
 * receiving queue (delivery orders = site activity history), and any order the
 * operator creates is auto-scoped to their siteId. This script provisions the
 * Firebase Auth user + role claim + Firestore profile.
 *
 * Required environment variables:
 *   SITE_OP_EMAIL
 *   SITE_OP_PASSWORD
 *
 * Optional environment variables:
 *   SITE_OP_DISPLAY_NAME (defaults to "Site Operator")
 *   SITE_OP_SITE_ID      (the site this operator is assigned to)
 */
const { auth, db } = require('../config/firebase');
const { assertStrongPassword } = require('../src/utils/passwordPolicy');

const email = String(process.env.SITE_OP_EMAIL || '').trim().toLowerCase();
const password = String(process.env.SITE_OP_PASSWORD || '');
const displayName = String(process.env.SITE_OP_DISPLAY_NAME || 'Site Operator').trim();
const siteId = String(process.env.SITE_OP_SITE_ID || '').trim();

function validateInputs() {
  if (!email) throw new Error('SITE_OP_EMAIL is required.');
  if (!password) throw new Error('SITE_OP_PASSWORD is required.');
  assertStrongPassword(password);
}

async function createOrUpdateSiteOperator() {
  validateInputs();

  let userRecord;
  let action;

  try {
    userRecord = await auth.getUserByEmail(email);
    userRecord = await auth.updateUser(userRecord.uid, {
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
    action = 'updated';
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    userRecord = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
    action = 'created';
  }

  await auth.setCustomUserClaims(userRecord.uid, { role: 'operator_site' });

  const username = email.split('@')[0];
  const profileRef = db.collection('users').doc(userRecord.uid);
  const existingProfile = await profileRef.get();
  const now = new Date().toISOString();

  await profileRef.set(
    {
      id: userRecord.uid,
      uid: userRecord.uid,
      authUid: userRecord.uid,
      email,
      authEmail: email,
      displayName,
      username,
      generatedUsername: username,
      role: 'operator_site',
      ...(siteId ? { siteId } : {}),
      isActive: true,
      createdAt: existingProfile.exists ? existingProfile.data().createdAt || now : now,
      updatedAt: now,
    },
    { merge: true }
  );

  const verifiedUser = await auth.getUser(userRecord.uid);
  if (verifiedUser.customClaims?.role !== 'operator_site') {
    throw new Error('Site Operator verification failed after seeding.');
  }

  console.log(
    `Site Operator ${action}: ${displayName} (${email}) role=operator_site` +
    (siteId ? ` siteId=${siteId}` : ' (no siteId — sees the shared site queue)') +
    `, UID: ${userRecord.uid}`
  );
}

createOrUpdateSiteOperator().catch((error) => {
  console.error('Failed to seed Site Operator:', error.message || error);
  process.exitCode = 1;
});

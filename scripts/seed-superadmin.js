/*
 * Creates or updates one Super Admin in Firebase Authentication and Firestore.
 *
 * Required environment variables:
 *   SUPERADMIN_EMAIL
 *   SUPERADMIN_PASSWORD
 *
 * Optional environment variables:
 *   SUPERADMIN_USERNAME (defaults to "superadmin")
 *   SUPERADMIN_DISPLAY_NAME (defaults to "TruckSphere Super Admin")
 */
const { auth, db } = require('../config/firebase');

const email = String(process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.SUPERADMIN_PASSWORD || '');
const username = String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
const displayName = String(
  process.env.SUPERADMIN_DISPLAY_NAME || 'TruckSphere Super Admin'
).trim();

function validateInputs() {
  if (!email) {
    throw new Error('SUPERADMIN_EMAIL is required.');
  }

  if (!password) {
    throw new Error('SUPERADMIN_PASSWORD is required.');
  }

  if (password.length < 12) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 12 characters long.');
  }

  if (!username) {
    throw new Error('SUPERADMIN_USERNAME cannot be empty.');
  }
}

async function createOrUpdateSuperAdmin() {
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
    if (error.code !== 'auth/user-not-found') {
      throw error;
    }

    userRecord = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
    action = 'created';
  }

  await auth.setCustomUserClaims(userRecord.uid, { role: 'superadmin' });

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
      role: 'superadmin',
      isActive: true,
      createdAt: existingProfile.exists ? existingProfile.data().createdAt || now : now,
      updatedAt: now,
    },
    { merge: true }
  );

  const [verifiedUser, verifiedProfile] = await Promise.all([
    auth.getUser(userRecord.uid),
    profileRef.get(),
  ]);

  if (
    verifiedUser.customClaims?.role !== 'superadmin' ||
    verifiedProfile.data()?.role !== 'superadmin'
  ) {
    throw new Error('Super Admin verification failed after seeding.');
  }

  console.log(
    `Super Admin ${action}: ${username} (${email}), UID: ${userRecord.uid}`
  );
}

createOrUpdateSuperAdmin().catch((error) => {
  console.error('Failed to seed Super Admin:', error.message || error);
  process.exitCode = 1;
});

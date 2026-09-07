async function findLoginProfile(users, value) {
  const identifier = String(value || '').trim().toLowerCase();
  if (!identifier) return null;
  const lookups = identifier.includes('@')
    ? [['email', identifier], ['authEmail', identifier]]
    : [['generatedUsername', identifier], ['username', identifier], ['email', `${identifier}@truck.com`]];
  for (const [field, key] of lookups) {
    const snapshot = await users.where(field, '==', key).limit(1).get();
    if (!snapshot.empty) return snapshot.docs[0].data();
  }
  return null;
}

async function resolveLoginEmail(profile, auth) {
  const uid = profile.authUid || profile.uid || profile.id;
  if (!uid) return profile.authEmail || profile.email;
  try {
    const account = await auth.getUser(uid);
    return account.email || profile.authEmail || profile.email;
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

module.exports = { findLoginProfile, resolveLoginEmail };

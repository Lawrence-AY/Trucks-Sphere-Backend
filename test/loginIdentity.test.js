const test = require('node:test');
const assert = require('node:assert/strict');
const { findLoginProfile, resolveLoginEmail } = require('../src/modules/auth/loginIdentity');

test('vendor login accepts generated username and email with surrounding whitespace and case differences', async () => {
  const profile = { generatedUsername: 'anneomo', email: 'anne@example.test', authUid: 'vendor-uid' };
  const users = { where: (field, _operator, value) => ({ limit: () => ({ get: async () => ({ empty: profile[field] !== value, docs: [{ data: () => profile }] }) }) }) };
  assert.equal(await findLoginProfile(users, ' ANNEOMO '), profile);
  assert.equal(await findLoginProfile(users, ' ANNE@EXAMPLE.TEST '), profile);
  assert.equal(await findLoginProfile(users, 'missing'), null);
});

test('vendor login uses the linked Firebase account even if contact and saved auth emails are stale', async () => {
  const email = await resolveLoginEmail({ authUid: 'vendor-uid', email: 'new-contact@example.test', authEmail: 'stale@example.test' }, {
    getUser: async (uid) => { assert.equal(uid, 'vendor-uid'); return { email: 'actual-login@example.test' }; },
  });
  assert.equal(email, 'actual-login@example.test');
  assert.equal(await resolveLoginEmail({ email: 'legacy@example.test' }, {}), 'legacy@example.test');
  assert.equal(await resolveLoginEmail({ uid: 'deleted', email: 'other@example.test' }, {
    getUser: async () => { throw Object.assign(new Error('Missing'), { code: 'auth/user-not-found' }); },
  }), null);
});

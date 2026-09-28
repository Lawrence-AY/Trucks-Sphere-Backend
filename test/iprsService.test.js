const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../src/integrations/iprsService');

test('IPRS session token extraction supports nested API responses', () => {
  assert.equal(__testables.extractToken({ data: { access_token: 'session-token' } }), 'session-token');
});

test('IPRS identity comparison requires both names and checks the ID when returned', () => {
  const expected = { nationalId: '12345678', firstName: 'Anne-Marie', surname: 'Omondi' };
  assert.equal(__testables.identityMatches({ data: { id_number: '12345678', first_name: 'Anne Marie', surname: 'Omondi' } }, expected), true);
  assert.equal(__testables.identityMatches({ data: { idNumber: '12345678', firstName: 'Anne-Marie', otherNames: 'Wanjiku', surname: 'Omondi' } }, expected), true);
  assert.equal(__testables.identityMatches({ data: { id_number: '12345678', first_name: 'Anne', surname: 'Otieno' } }, expected), false);
});

test('IPRS accepts matching names without an echoed ID in provider validation responses', async () => {
  const identity = { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' };
  for (const status of [200, 400, 422]) {
    const service = integration(async (url) => url.endsWith('/auth/session')
      ? { status: 200, data: { token: 'session' } }
      : { status, data: { success: false, data: { FirstName: 'ANNE', Surname: 'OMONDI' } } });
    assert.equal((await service.verifyDriverIdentity(identity)).verified, true);
  }
  assert.equal(__testables.identityMatches({ firstName: 'Anne', surname: 'Omondi', idNumber: 'wrong' }, identity), false);
  assert.equal(__testables.identityMatches({ firstName: 'Anne' }, identity), false);
  const service = integration(async (url) => url.endsWith('/auth/session')
    ? { status: 200, data: { token: 'session' } }
    : { status: 422, data: { firstName: 'Anne', surname: 'Wrong' } });
  await assert.rejects(service.verifyDriverIdentity(identity), { code: 'IPRS_IDENTITY_MISMATCH' });
});

test('IPRS explicit failed responses are rejected', () => {
  assert.equal(__testables.responseIndicatesRejected({ data: { verified: false } }), true);
  assert.equal(__testables.responseIndicatesRejected({ data: { verified: true } }), false);
});

function integration(post) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/integrations/iprsService'), 'utf8'), {
    module, URL, require: () => ({ post }),
    process: { env: { IPRS_ENABLED: 'true', IPRS_URL: 'https://identity.example.test', IPRS_USERNAME: 'test-user', IPRS_PASSWORD: 'test-password' } },
  });
  return module.exports;
}

test('every IPRS attempt creates a session and uses its token as Bearer with corrected identity', async () => {
  const calls = [];
  let sessions = 0;
  const service = integration(async (url, body, options) => {
    calls.push({ url, body, options });
    if (url.endsWith('/auth/session')) return { status: 200, data: { session: { token: `Bearer session-${++sessions}` } } };
    assert.equal(options.headers.Authorization, `Bearer session-${sessions}`);
    assert.match(options.headers['Cache-Control'], /no-store/);
    return { status: 200, data: { data: { id_number: '12345678', first_name: 'Anne', surname: 'Omondi' } } };
  });
  await assert.rejects(service.verifyDriverIdentity({ nationalId: '12345679', firstName: 'Anne', surname: 'Wrong' }), { code: 'IPRS_IDENTITY_MISMATCH' });
  const fixed = { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' };
  assert.equal((await service.verifyDriverIdentity(fixed)).verified, true);
  assert.equal((await service.verifyDriverIdentity(fixed)).verified, true);
  assert.equal(sessions, 3);
  assert.equal(calls.length, 6);
  assert.equal(calls[3].body.idNumber, fixed.nationalId);
  assert.deepEqual(Object.keys(calls[3].body), ['idNumber']);
});

test('failed IPRS session does not poison a subsequent attempt', async () => {
  let sessions = 0;
  const service = integration(async (url) => {
    if (url.endsWith('/auth/session')) {
      sessions++;
      return sessions === 1 ? { status: 503, data: {} } : { status: 200, data: { access_token: 'new-session' } };
    }
    return { status: 200, data: { id_number: '12345678', first_name: 'Anne', surname: 'Omondi' } };
  });
  const identity = { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' };
  await assert.rejects(service.verifyDriverIdentity(identity), { code: 'IPRS_SESSION_FAILED' });
  assert.equal((await service.verifyDriverIdentity(identity)).verified, true);
  assert.equal(sessions, 2);
});

test('identity matching reads the complete nested record and never accepts an unauthorized response', async () => {
  const expected = { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' };
  const record = { id_number: expected.nationalId, first_name: expected.firstName, surname: expected.surname };
  assert.equal(__testables.identityMatches({ id_number: 'request-reference', data: record }, expected), true);
  const service = integration(async (url) => url.endsWith('/auth/session') ? { status: 200, data: { token: 'session' } } : { status: 401, data: record });
  await assert.rejects(service.verifyDriverIdentity(expected), { code: 'IPRS_VERIFICATION_FAILED' });
});

test('IPRS recognizes case-varied identity fields inside response arrays', () => {
  const expected = { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' };
  assert.equal(__testables.identityMatches({ Data: [{ ID_Number: '12345678', First_Name: 'ANNE', Surname: 'OMONDI' }] }, expected), true);
  assert.equal(__testables.identityMatches({ Result: { Records: [{ IDNo: '12345678', FirstName: 'Anne', LastName: 'Wrong' }] } }, expected), false);
});

test('an unrecognized provider response is not reported as an identity mismatch', async () => {
  const service = integration(async (url) => url.endsWith('/auth/session')
    ? { status: 200, data: { token: 'session' } }
    : { status: 200, data: { success: true, message: 'Request processed' } });
  await assert.rejects(service.verifyDriverIdentity({ nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' }), { code: 'IPRS_RESPONSE_UNRECOGNIZED' });
});

test('diagnostics expose matching booleans and missing fields without identity values', () => {
  const result = __testables.identityComparisons({ Data: [{ IDNumber: '12345678', FirstName: 'Anne' }] }, { nationalId: '12345678', firstName: 'Anne', surname: 'Omondi' });
  assert.deepEqual(result, [{ nationalId: true, firstName: true, surname: null }]);
  assert.doesNotMatch(JSON.stringify(result), /12345678|Anne|Omondi/);
});

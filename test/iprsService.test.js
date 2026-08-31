const test = require('node:test');
const assert = require('node:assert/strict');
const { __testables } = require('../src/integrations/iprsService');

test('IPRS session token extraction supports nested API responses', () => {
  assert.equal(__testables.extractToken({ data: { access_token: 'session-token' } }), 'session-token');
});

test('IPRS identity comparison requires the ID, first name, and surname to match', () => {
  const expected = { nationalId: '12345678', firstName: 'Anne-Marie', surname: 'Omondi' };
  assert.equal(__testables.identityMatches({ data: { id_number: '12345678', first_name: 'Anne Marie', surname: 'Omondi' } }, expected), true);
  assert.equal(__testables.identityMatches({ data: { idNumber: '12345678', firstName: 'Anne-Marie', otherNames: 'Wanjiku', surname: 'Omondi' } }, expected), true);
  assert.equal(__testables.identityMatches({ data: { id_number: '12345678', first_name: 'Anne', surname: 'Otieno' } }, expected), false);
});

test('IPRS explicit failed responses are rejected', () => {
  assert.equal(__testables.responseIndicatesRejected({ data: { verified: false } }), true);
  assert.equal(__testables.responseIndicatesRejected({ data: { verified: true } }), false);
});

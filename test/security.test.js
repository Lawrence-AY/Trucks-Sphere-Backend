const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_SECRET = 'test-secret-that-is-long-enough-to-exercise-key-derivation';
process.env.ENCRYPTION_SALT = 'test-salt-that-is-long-enough';

const cryptoUtils = require('../src/utils/cryptoUtils');
const { assessPassword } = require('../src/utils/passwordPolicy');
const { findCommandInjection, helmetConfig } = require('../src/middleware/securityMiddleware');
const { detectFileType } = require('../src/modules/uploads/uploadMiddleware');

test('crypto utilities require configured key material and round trip values', () => {
  cryptoUtils.assertCryptoConfiguration();
  const encrypted = cryptoUtils.encrypt('refresh-token');
  assert.notEqual(encrypted, 'refresh-token');
  assert.equal(cryptoUtils.decrypt(encrypted), 'refresh-token');
});

test('password policy requires a long mixed-character password', () => {
  assert.equal(assessPassword('Cedar!7MoonLake').valid, true);
  assert.equal(assessPassword('password123!').valid, false);
  assert.equal(assessPassword('Password123456').valid, false);
  assert.equal(assessPassword('Password123!').valid, false);
  assert.equal(assessPassword('Abcd!7RiverStone').valid, false);
  assert.equal(assessPassword('Maple!7777Trail').valid, false);
});

test('command syntax is detected before routing', () => {
  assert.equal(findCommandInjection({ search: 'trucks; rm -rf /' }), 'search');
  assert.equal(findCommandInjection({ search: 'Mombasa delivery' }), null);
});

test('CSP does not permit inline scripts or styles', () => {
  assert.deepEqual(helmetConfig.contentSecurityPolicy.directives.scriptSrc, ["'self'"]);
  assert.deepEqual(helmetConfig.contentSecurityPolicy.directives.styleSrc, ["'self'"]);
});

test('upload signatures are recognized independently of client MIME headers', () => {
  assert.equal(detectFileType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
  assert.equal(detectFileType(Buffer.from('not an image')), null);
});

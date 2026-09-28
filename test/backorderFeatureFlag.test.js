const test = require('node:test');
const assert = require('node:assert/strict');
const { isBackorderCreationEnabled } = require('../src/modules/delivery-orders/backorder');

test('backorder creation is disabled unless explicitly enabled', () => {
  const original = process.env.BACKORDERS_ENABLED;
  delete process.env.BACKORDERS_ENABLED;
  assert.equal(isBackorderCreationEnabled(), false);
  process.env.BACKORDERS_ENABLED = 'true';
  assert.equal(isBackorderCreationEnabled(), true);

  if (original === undefined) delete process.env.BACKORDERS_ENABLED;
  else process.env.BACKORDERS_ENABLED = original;
});

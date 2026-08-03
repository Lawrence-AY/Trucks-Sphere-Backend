const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/integrations/odooPurchaseService');

test('Odoo identifiers are extracted from supported JSON-2 create responses', () => {
  assert.equal(__testables.extractId(12), 12);
  assert.equal(__testables.extractId({ id: 13 }), 13);
  assert.equal(__testables.extractId([{ id: 14 }]), 14);
  assert.equal(__testables.extractId(null), null);
});

test('Odoo many2one values yield their record ID', () => {
  assert.equal(__testables.odooMany2oneId(2), 2);
  assert.equal(__testables.odooMany2oneId([3, 'Ton(s)']), 3);
  assert.equal(__testables.odooMany2oneId(false), null);
});

test('material units have sensible Odoo lookup fallbacks', () => {
  assert.deepEqual(__testables.unitCandidates('Tonnes').slice(0, 5), ['Tonnes', 'Ton(s)', 'Tonne', 'Tons', 'Ton']);
  assert.ok(__testables.unitCandidates('Bags').includes('Units'));
});

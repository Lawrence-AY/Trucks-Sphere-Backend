const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, ALIASES, NAME } = require('../scripts/canonicalize-spades-vendor');
const { matchVendor } = require('../src/utils/vendorMatching');
function fixture() { return { vendors: [{ id: 'V006', companyName: 'SPADES ATLAS', userId: 'account' }],
  users: [{ id: 'account', vendorId: 'V006', username: 'spadesatl', role: 'vendor', displayName: 'SPADES ATLAS' }],
  deliveryOrders: [{ id: 'job', vendorId: 'V006', vendorName: 'SPADE ATLAS COMPANY', quantity: 20, createdAt: 'original', rawPayload: { FIRMA_ADI: 'SPADE ATLAS COMPANY' } }],
  purchaseOrders: [{ id: 'PO0006-V006', vendorId: 'V006', vendorName: 'SPADES ATLAS COMPANY LTD', status: 'active' }],
  vendorAliases: [], vendorUniqueKeys: [] }; }

test('canonical name and all aliases resolve to the original vendor without altering accounts, dates or quantities', () => {
  const state = fixture(); const original = structuredClone(state);
  const changes = plan(state);
  const vendor = changes.find(row => row.collection === 'vendors').after;
  assert.equal(vendor.companyName, NAME); assert.equal(vendor.userId, 'account');
  for (const alias of ALIASES) assert.equal(matchVendor(alias, [vendor]).match.id, 'V006');
  const job = changes.find(row => row.collection === 'deliveryOrders').after;
  assert.equal(job.vendorName, NAME); assert.equal(job.vendorId, 'V006');
  assert.equal(job.quantity, 20); assert.equal(job.createdAt, 'original');
  assert.deepEqual(job.rawPayload, original.deliveryOrders[0].rawPayload);
  const user = changes.find(row => row.collection === 'users').after;
  assert.equal(user.username, 'spadesatl'); assert.equal(user.role, 'vendor');
  assert.deepEqual(state, original);
  for (const row of changes) { state[row.collection] ||= []; state[row.collection] = state[row.collection].filter(item => item.id !== row.id); state[row.collection].push(row.after); }
  assert.equal(plan(state).length, 0);
});

test('conflicting aliases and duplicate vendors require review', () => {
  const state = fixture(); state.vendors.push({ id: 'other', companyName: 'SPADES ATLAS COMPANY' });
  assert.throws(() => plan(state), /explicit merge/);
});

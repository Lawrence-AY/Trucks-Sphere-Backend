const test = require('node:test');
const assert = require('node:assert/strict');
const { selectBridgePurchaseOrder: select } = require('../src/utils/bridgePurchaseOrder');
const context = { vendor: 'WELLSELECT', material: 'RIVER SAND', siteId: 'S1', siteName: 'MANDA BAY', origin: 'MALINDI' };
test('site and origin narrow PO candidates before selecting a duplicate', () => {
  const orders = [{ id: 'P1', siteId: 'S2' }, { id: 'P2', siteId: 'S1', quarryName: 'HINDI' }, { id: 'P3', siteId: 'S1', quarryName: 'MALINDI' }];
  assert.equal(select(orders, context).id, 'P3');
});
test('orders with distinct unresolved commercial contexts remain ambiguous', () => {
  assert.equal(select([{ id: 'P1', siteId: 'S2' }, { id: 'P2', siteId: 'S3' }], context), null);
});
test('manual PO is preferred to bridge-created duplicates', () => {
  assert.equal(select([{ id: 'P1', bridgeCreated: true }, { id: 'P2' }], context).id, 'P2');
});

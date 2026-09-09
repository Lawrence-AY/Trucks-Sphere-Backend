const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('job creation rejects closed purchase orders before assignment or ID allocation', async () => {
 for (const status of ['COMPLETED', ' excess ', 'over_delivered', 'canceled']) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/delivery-orders/service'), 'utf8'), {
   module, exports: module.exports, console: { error() {} },
   require: name => name === '../../../config/firebase' ? { db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ status }) }) }) }) } } : {},
  });
  await assert.rejects(module.exports.create({ purchaseOrderId: 'po1' }), { code: 'PURCHASE_ORDER_CLOSED', statusCode: 409 });
 }
});

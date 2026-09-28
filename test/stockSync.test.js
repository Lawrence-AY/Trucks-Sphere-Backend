const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('existing and changed app deliveries automatically synchronize stock from fresh documents', async () => {
  let listener;
  const writes = [];
  const deliveries = new Map([['old', { quantity: 10 }], ['new', { quantity: 20 }]]);
  const db = {
    collection: () => ({ doc: (id) => ({ id }) }),
    runTransaction: async (fn) => fn({ get: async (ref) => ({ id: ref.id, exists: deliveries.has(ref.id), data: () => deliveries.get(ref.id) }) }),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/stocks/sync'), 'utf8'), {
    module, console, setTimeout, clearTimeout,
    require: (name) => name.includes('firebase') ? { db } : { prepare: async (_, record) => () => writes.push(record) },
  });
  const stop = module.exports.startStockSync({ subscribe: (name, fn) => { assert.equal(name, 'deliveryOrders'); listener = fn; return () => {}; } });
  listener({ type: 'added', id: 'old', record: { quantity: 1 } });
  listener({ type: 'added', id: 'new' });
  await new Promise(setImmediate);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].quantity, 10);
  deliveries.set('old', { quantity: 12 });
  listener({ type: 'modified', id: 'old' });
  await new Promise(setImmediate);
  assert.equal(writes[2].quantity, 12);
  stop();
});

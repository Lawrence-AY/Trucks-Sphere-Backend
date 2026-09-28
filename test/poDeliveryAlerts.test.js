const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildDeliverySummary } = require('../src/modules/purchase-orders/deliverySummary');

const po = { id: 'po1', vendorId: 'V001', poNumber: 'PO001', quantity: 100, unit: 'Tonnes' };
const trip = (id, quantity, extra = {}) => ({ id, purchaseOrderId: po.id, status: 'COMPLETED', siteNetWeight: quantity, ...extra });

test('PO variance totals all linked trips once and exceeds only above the ordered quantity', () => {
  const trips = Array.from({ length: 60 }, (_, i) => trip(`job${i}`, 2));
  trips.push(trips[0], trip('cancelled', 1000, { status: 'CANCELLED' }), trip('active', 1000, { status: 'DISPATCHED' }), trip('other', 1000, { purchaseOrderId: 'po2' }));
  const result = buildDeliverySummary(po, trips);
  assert.equal(result.tripCount, 60);
  assert.equal(result.totals[0].deliveredQuantity, 120);
  assert.equal(result.totals[0].variance, 20);
  assert.equal(result.overDelivered, true);
  assert.equal(buildDeliverySummary(po, [trip('exact', 100)]).overDelivered, false);
  assert.equal(buildDeliverySummary(po, [trip('short', 95)]).totals[0].variance, -5);
});

test('multi-material PO quantities are summed without repeating trip weight per material', () => {
  const order = { ...po, quantity: 30, materials: [{ quantity: 30, unit: 't' }, { quantity: 70, unit: 'tonnes' }] };
  const result = buildDeliverySummary(order, [trip('one', 60), trip('two', 50)]);
  assert.equal(result.totals[0].orderedQuantity, 100);
  assert.equal(result.totals[0].deliveredQuantity, 110);
  assert.equal(result.totals[0].variance, 10);
});

test('site weights take precedence; zero and fractional totals do not invent an excess', () => {
  assert.equal(buildDeliverySummary(po, [trip('zero', 0, { quantityDelivered: 200 })]).totals[0].deliveredQuantity, 0);
  const legacy = trip('legacy', undefined, { status: 'delivered', siteWeighInWeight: 40, siteWeighOutWeight: 15 });
  assert.equal(buildDeliverySummary(po, [legacy]).totals[0].deliveredQuantity, 25);
  assert.equal(buildDeliverySummary(po, [trip('quarry', undefined, { netWeight: 200 })]).totals[0].deliveredQuantity, 0);
  assert.equal(buildDeliverySummary({ ...po, quantity: 0.3 }, [trip('a', 0.1), trip('b', 0.2)]).overDelivered, false);
  assert.deepEqual(buildDeliverySummary({ ...po, isWarehouseMaterial: true, quantity: null }, []).totals, []);
});

function fixture() {
  const records = new Map();
  let sequence = 0;
  let queue = Promise.resolve();
  const ref = (collection, id) => ({ collection, id, key: `${collection}/${id}` });
  const db = {
    collection: (collection) => ({ collection, doc: (id) => ref(collection, id || `generated${++sequence}`), where: (field, op, value) => ({ collection, field, value }) }),
    runTransaction: (fn) => {
      const result = queue.then(async () => {
        let written = false;
        const writes = [];
        const snapshot = (key, value) => ({ id: key.split('/')[1], exists: value != null, data: () => structuredClone(value) });
        const value = await fn({
          get: async (target) => {
            assert.equal(written, false, 'transaction reads precede writes');
            if (target.key) return snapshot(target.key, records.get(target.key));
            return { docs: [...records].filter(([key, data]) => key.startsWith(target.collection + '/') && (!target.field || data[target.field] === target.value)).map(([key, data]) => snapshot(key, data)) };
          },
          update: (target, value) => { written = true; writes.push(() => records.set(target.key, { ...records.get(target.key), ...structuredClone(value) })); },
          set: (target, value) => { written = true; writes.push(() => records.set(target.key, structuredClone(value))); },
        });
        writes.forEach((write) => write());
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/purchase-orders/deliveryAlerts'), 'utf8'), {
    module, console, setTimeout, clearTimeout,
    require: (name) => name.includes('firebase') ? { db } : { buildDeliverySummary },
  });
  records.set('purchaseOrders/po1', po);
  records.set('users/admin', { role: 'admin' });
  records.set('users/vendor', { role: 'vendor', entityId: 'v1' });
  records.set('users/otherVendor', { role: 'vendor', vendorId: 'V002' });
  return { records, ...module.exports, notifications: () => [...records].filter(([key]) => key.startsWith('notifications/')).map(([, value]) => value) };
}

test('concurrent/retried reconciliation alerts the owning vendor and admin once per increase', async () => {
  const f = fixture();
  f.records.set('deliveryOrders/one', trip('one', 60));
  f.records.set('deliveryOrders/two', trip('two', 50));
  await Promise.all([f.reconcileDeliverySummary('po1'), f.reconcileDeliverySummary('po1')]);
  assert.equal(f.notifications().length, 2);
  assert.deepEqual(f.notifications().map((n) => n.userId).sort(), ['admin', 'vendor']);
  assert.match(f.notifications()[0].message, /variance \+10 Tonnes/);
  f.records.set('deliveryOrders/three', trip('three', 5));
  await f.reconcileDeliverySummary('po1');
  assert.equal(f.notifications().length, 4);
  f.records.set('deliveryOrders/three', trip('three', 5, { status: 'CANCELLED' }));
  await f.reconcileDeliverySummary('po1');
  assert.equal(f.notifications().length, 4);
  assert.equal(f.records.get('purchaseOrders/po1').deliverySummary.totals[0].variance, 10);
});

test('snapshot synchronization handles existing POs and deleted trips', async () => {
  const f = fixture();
  const listeners = {};
  const stop = f.startDeliveryAlertSync({ subscribe: (name, listener) => { listeners[name] = listener; return () => {}; } });
  f.records.set('deliveryOrders/one', trip('one', 120));
  listeners.purchaseOrders({ type: 'added', id: 'po1', record: po });
  await new Promise(setImmediate);
  assert.equal(f.records.get('purchaseOrders/po1').deliverySummary.overDelivered, true);
  f.records.delete('deliveryOrders/one');
  listeners.deliveryOrders({ type: 'removed', id: 'one', record: trip('one', 120) });
  await new Promise(setImmediate);
  assert.equal(f.records.get('purchaseOrders/po1').deliverySummary.overDelivered, false);
  stop();
});

test('material breakdown separates materials sharing a unit and sums completed trips', () => {
  const order = { ...po, materials: [{ materialId: 'sand', materialName: 'Sand', quantity: 20, unit: 'Tonnes' }, { materialId: 'stone', materialName: 'Stone', quantity: 30, unit: 'Tonnes' }] };
  const trips = [trip('one', 10, { materialId: 'sand' }), trip('two', 5, { materialId: 'sand' }), trip('three', 32, { materialId: 'stone' }), trip('pending', 100, { materialId: 'sand', status: 'DISPATCHED' })];
  trips.push(trips[0]);
  const result = buildDeliverySummary(order, trips);
  assert.equal(result.materials[0].materialName, 'Sand');
  assert.equal(result.materials[0].deliveredQuantity, 15);
  assert.equal(result.materials[0].variance, -5);
  assert.equal(result.materials[1].deliveredQuantity, 32);
  assert.equal(result.materials[1].variance, 2);
  assert.equal(result.totals[0].deliveredQuantity, 47);
  const ambiguous = buildDeliverySummary(order, [trip('unknown', 8)]);
  assert.equal(ambiguous.totals[0].deliveredQuantity, 8);
  assert.equal(ambiguous.materials.reduce((sum, line) => sum + line.deliveredQuantity, 0), 0);
});

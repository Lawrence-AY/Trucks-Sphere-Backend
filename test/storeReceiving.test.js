const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const workflow = require('../src/modules/delivery-orders/storeReceiving');
const model = require('../src/modules/stocks/model');
const actor = { uid: 'store-user', role: 'storeman', siteId: 'site1', displayName: 'Receiving team' };
const job = {
  id: 'job1', jobId: 'WH001/J0001', status: 'SITE_WEIGHED_OUT', siteId: 'site1', isWarehouseDelivery: true,
  warehouseAcceptedAt: '2026-10-06T07:00:00Z', vendorName: 'Vendor', driverName: 'Driver', plateNumber: 'KAA123A',
  materials: [{ materialId: 'bolts', materialName: 'Bolts', quantity: 10, unit: 'Pieces' }, { materialId: 'paint', materialName: 'Paint', quantity: 2, unit: 'Litres' }],
  receivingEvidence: [{ lineIndex: 0, url: 'https://example.test/bolts.jpg' }, { lineIndex: 1, url: 'https://example.test/paint.jpg' }],
};
const intake = { quantities: ['9', '2'], condition: 'Pass', deliveredByName: 'Delivery person', requestId: 'receiving_request_1' };
const approval = { result: 'Pass', qualityChecks: Object.fromEntries(workflow.METRICS.map(key => [key, true])), requestId: 'inspection_request_1' };
const now = '2026-10-06T08:00:00Z';
const pending = () => ({ ...job, ...workflow.receiveUpdates(job, intake, actor, now) });

test('intake stores quantity, evidence, personnel and server time without releasing inventory', () => {
  const received = pending();
  assert.equal(received.receivingStatus, 'received_pending_inspection');
  assert.equal(received.status, job.status);
  assert.equal(received.storeReceiving.receivedByUid, actor.uid);
  assert.equal(received.storeReceiving.receivedAt, now);
  assert.equal(received.storeReceiving.deliveredByName, 'Delivery person');
  assert.equal(received.storeReceiving.materialReceipts[0].receivedQuantity, 9);
  assert.equal(received.storeReceiving.materialReceipts[0].photoURLs[0], job.receivingEvidence[0].url);
  assert.ok(model.stockRows(received).every(row => row.usableQuantity === 0));
});
test('receiving requires all counts and photos; rejection requires a reason and cannot be inspected', () => {
  for (const quantities of [[], ['9'], ['', '2'], [-1, 2], [true, 2], ['NaN', 2]]) {
    assert.throws(() => workflow.receiveUpdates(job, { ...intake, quantities }, actor, now));
  }
  assert.throws(() => workflow.receiveUpdates({ ...job, receivingEvidence: [job.receivingEvidence[0]] }, intake, actor, now), /photo/);
  assert.throws(() => workflow.receiveUpdates(job, { ...intake, condition: 'Failed', reason: ' ' }, actor, now), /reason/);
  const rejected = { ...job, ...workflow.receiveUpdates(job, { ...intake, condition: 'Failed', reason: 'Damaged packaging' }, actor, now) };
  assert.equal(rejected.receivingStatus, 'receiving_rejected');
  assert.equal(rejected.receivingFlag.status, 'flagged');
  assert.throws(() => workflow.inspectionUpdates(rejected, approval, actor, now), /Only passed/);
  assert.ok(model.stockRows(rejected).every(row => row.usableQuantity === 0));
});
test('quality approval requires every checkbox and uses sealed receiving quantities', () => {
  assert.throws(() => workflow.inspectionUpdates(job, approval, actor, now), /Only passed/);
  for (const key of workflow.METRICS) assert.throws(() => workflow.inspectionUpdates(pending(), { ...approval, qualityChecks: { ...approval.qualityChecks, [key]: false } }, actor, now), /every quality metric/);
  const approved = { ...pending(), ...workflow.inspectionUpdates(pending(), { ...approval, quantities: [999, 999] }, actor, now) };
  assert.equal(approved.receivingStatus, 'inventory_added');
  assert.deepEqual(model.stockRows(approved).map(row => row.usableQuantity), [9, 2]);
  const rejected = { ...pending(), ...workflow.inspectionUpdates(pending(), { result: 'Failed', reason: 'Contamination' }, actor, now) };
  assert.equal(rejected.receivingFlag.stage, 'inspection');
  assert.ok(model.stockRows(rejected).every(row => row.usableQuantity === 0));
  assert.throws(() => workflow.inspectionUpdates(rejected, approval, actor, now));
});
test('site, role, acceptance and generic update checks cannot bypass the stages', () => {
  assert.throws(() => workflow.receiveUpdates(job, intake, { ...actor, siteId: 'other-site' }, now), error => error.statusCode === 404);
  assert.throws(() => workflow.receiveUpdates(job, intake, { ...actor, role: 'vendor' }, now), error => error.statusCode === 403);
  assert.throws(() => workflow.receiveUpdates(job, intake, { ...actor, role: 'inspector' }, now));
  assert.throws(() => workflow.receiveUpdates({ ...job, warehouseAcceptedAt: null }, intake, actor, now));
  assert.throws(() => workflow.receiveUpdates({ ...job, siteWeighInWeight: 12, siteWeighOutWeight: null }, intake, actor, now));
  assert.throws(() => workflow.receiveUpdates({ ...job, status: 'CANCELLED' }, intake, actor, now));
  for (const key of workflow.PROTECTED_FIELDS) assert.throws(() => workflow.assertGenericUpdate(job, { [key]: null }));
  assert.throws(() => workflow.assertGenericUpdate(job, { materialInspection: { materialReceipts: [] } }));
  assert.throws(() => workflow.assertGenericUpdate(pending(), { materials: [] }));
});
test('completed countable deliveries without inspection do not inflate stock; bulk stays unchanged', () => {
  assert.equal(model.stockRows({ id: 'counted', status: 'COMPLETED', materialName: 'Bolts', unit: 'Pieces', quantityDelivered: 99 }).length, 0);
  assert.equal(model.stockRows({ id: 'bulk', status: 'COMPLETED', materialName: 'Sand', unit: 'Tonnes', siteNetWeight: 12 })[0].usableQuantity, 12);
});

function fixture() {
  const records = new Map([['deliveryOrders/job1', structuredClone(job)]]);
  let queue = Promise.resolve();
  const ref = (collection, id) => ({ id, key: `${collection}/${id}` });
  const db = { collection: name => ({ doc: id => ref(name, id), where: (field, op, value) => ({ collection: name, field, value }) }), runTransaction: fn => {
    const run = queue.then(async () => {
      const writes = [];
      let writing = false;
      const result = await fn({
        get: async ref => { assert.equal(writing, false, 'Firestore reads must precede all writes');
          if (ref.collection) return { docs: [...records].filter(([key, record]) => key.startsWith(ref.collection + '/') && record[ref.field] === ref.value).map(([key, record]) => ({ id: key.split('/')[1], data: () => structuredClone(record) })) };
          return { id: ref.id, exists: records.has(ref.key), data: () => structuredClone(records.get(ref.key)) }; },
        set: (ref, value, options) => { writing = true; writes.push(() => records.set(ref.key, { ...(options?.merge ? records.get(ref.key) : {}), ...structuredClone(value) })); },
        update: (ref, value) => { writing = true; writes.push(() => records.set(ref.key, { ...records.get(ref.key), ...structuredClone(value) })); },
      });
      writes.forEach(fn => fn());
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } };
  function load(relative, overrides) {
    const filename = require.resolve(relative), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => name in overrides ? overrides[name] : require(path.resolve(path.dirname(filename), name)) });
    return module.exports;
  }
  const stock = load('../src/modules/stocks/service', { '../../../config/firebase': { db } });
  const service = load('../src/modules/delivery-orders/storeReceivingService', {
    '../../../config/firebase': { db }, '../stocks/service': stock, '../../utils/snapshotStore': { applyCommittedUpdate() {} },
  });
  return { records, service, stock, ref };
}
test('atomic approvals, retry deduplication and competing inspectors add inventory exactly once', async () => {
  const { records, service, stock } = fixture();
  await Promise.all([service.transition(job.id, intake, actor, 'receiving'), service.transition(job.id, intake, actor, 'receiving')]);
  assert.equal(records.get('deliveryOrders/job1').receivingStatus, 'received_pending_inspection');
  const attempts = await Promise.allSettled([service.transition(job.id, approval, actor, 'inspection'), service.transition(job.id, { ...approval, requestId: 'other_inspection' }, { ...actor, uid: 'other-inspector' }, 'inspection')]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rows = [...records].filter(([key]) => key.startsWith('stocks/')).map(([, value]) => value);
  assert.deepEqual(rows.map(row => row.remainingQuantity), [9, 2]);
  await stock.change(rows[0].id, { type: 'usage', quantity: 3, reason: 'Installation', requestId: 'usage_request_1' }, actor);
  await service.transition(job.id, approval, actor, 'inspection');
  assert.equal(records.get(`stocks/${rows[0].id}`).remainingQuantity, 6);
  assert.equal(records.get('counters/materialInspectionReceiptForm').value, 1);
});
test('failed approval is atomic and generic writes, receipt adjustments and deletion cannot bypass pending inspection', async () => {
  const { records, service, stock, ref } = fixture();
  await service.transition(job.id, intake, actor, 'receiving');
  await assert.rejects(service.transition(job.id, { ...approval, qualityChecks: {} }, actor, 'inspection'));
  assert.equal(records.get('deliveryOrders/job1').receivingStatus, 'received_pending_inspection');
  assert.equal(records.has('counters/materialInspectionReceiptForm'), false);
  const row = [...records].find(([key]) => key.startsWith('stocks/'))[1];
  await assert.rejects(stock.change(row.id, { type: 'receipt', quantity: 100, reason: 'Bypass', requestId: 'bad_receipt_1' }, actor));
  await assert.rejects(stock.persistDelivery(ref('deliveryOrders', job.id), { receivingStatus: 'inventory_added' }));
  await assert.rejects(stock.deleteDelivery(ref('deliveryOrders', job.id)));
  assert.equal(records.get(`stocks/${row.id}`).remainingQuantity, 0);
});

test('inventory commit atomically fulfills the PO, records excess and remains idempotent', async () => {
  const { records, service } = fixture();
  records.set('deliveryOrders/job1', { ...job, purchaseOrderId: 'po1' });
  records.set('purchaseOrders/po1', { id: 'po1', status: 'approved', vendorId: 'V1', materials: job.materials });
  await service.transition(job.id, { ...intake, quantities: ['12', '2'] }, actor, 'receiving');
  assert.equal(records.get('purchaseOrders/po1').status, 'approved');
  await service.transition(job.id, approval, actor, 'inspection');
  const po = records.get('purchaseOrders/po1');
  assert.equal(po.status, 'completed');
  assert.equal(po.deliverySummary.materials[0].excessQuantity, 2);
  assert.equal(po.deliverySummary.overDelivered, true);
  assert.ok(po.fulfilledAt);
  await service.transition(job.id, approval, actor, 'inspection');
  assert.equal(records.get('purchaseOrders/po1').fulfilledAt, po.fulfilledAt);
  assert.equal(records.get('purchaseOrders/po1').deliverySummary.materials[0].deliveredQuantity, 12);
});

test('an excess on one material cannot fulfill a different short material', async () => {
  const { records, service } = fixture();
  records.set('deliveryOrders/job1', { ...job, purchaseOrderId: 'po1' });
  records.set('purchaseOrders/po1', { id: 'po1', status: 'approved', materials: job.materials });
  await service.transition(job.id, { ...intake, quantities: ['20', '1'] }, actor, 'receiving');
  await service.transition(job.id, approval, actor, 'inspection');
  assert.equal(records.get('purchaseOrders/po1').status, 'approved');
  assert.equal(records.get('purchaseOrders/po1').deliverySummary.overDelivered, true);
});

test('multiple approved deliveries accumulate toward a PO without counting failed or pending jobs', async () => {
  const { records, service } = fixture();
  records.set('deliveryOrders/job1', { ...job, purchaseOrderId: 'po1' });
  records.set('deliveryOrders/job2', { ...job, id: 'job2', jobId: 'WH001/J0002', purchaseOrderId: 'po1' });
  records.set('purchaseOrders/po1', { id: 'po1', status: 'approved', materials: job.materials });
  await service.transition('job1', { ...intake, quantities: ['6', '1'] }, actor, 'receiving');
  await service.transition('job2', { ...intake, quantities: ['5', '1'] }, actor, 'receiving');
  await service.transition('job1', approval, actor, 'inspection');
  assert.equal(records.get('purchaseOrders/po1').status, 'approved');
  assert.equal(records.get('purchaseOrders/po1').deliverySummary.materials[0].deliveredQuantity, 6);
  await service.transition('job2', approval, actor, 'inspection');
  assert.equal(records.get('purchaseOrders/po1').status, 'completed');
  assert.equal(records.get('purchaseOrders/po1').deliverySummary.materials[0].deliveredQuantity, 11);
  assert.equal(records.get('purchaseOrders/po1').deliverySummary.materials[0].excessQuantity, 1);
});

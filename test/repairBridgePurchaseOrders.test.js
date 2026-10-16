const test = require('node:test');
const assert = require('node:assert/strict');
const { COLLECTIONS, planRepairs, counterRepair, pairChanges, readState, applyPair, applyBatch, repairCounter, planMergedDeletions, deleteMergedBatch } = require('../scripts/lib/repairBridgePurchaseOrders');
const { parseArgs } = require('../scripts/repair-access-bridge-pos');
const now = '2026-10-16T12:00:00.000Z';
function fixture() {
  const state = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  state.autoIds = { purchase_order_v2_counter: 1, vendor_counter: 99 };
  state.vendors = [{ id: 'V001', name: 'HINDI GEN AGENCY LIMITED' }];
  state.materials = [{ id: 'MAT001', name: 'MURRAM' }];
  state.purchaseOrders = [
    { id: 'PO0001-V001', poNumber: 'PO0001/V001', vendorId: 'V001', materialId: 'MAT001', materialName: 'MURRAM',
      vendorName: 'HINDI GEN AGENCY LIMITED', siteId: 'S001', status: 'approved', quantity: 100, unit: 'tonnes', createdAt: '2026-01-01', pendingQualityControl: 5 },
    { id: 'PO0020-V001', poNumber: 'PO0020/V001', vendorId: 'V001', materialId: 'MAT001', materialName: 'MUURRRAAM',
      vendorName: 'HINDI GEN AGENCY LTD', siteId: 'S001', status: 'open', unit: 'tonnes', bridgeCreated: true, createdBy: 'access_bridge', pendingQualityControl: 10 },
  ];
  state.deliveryOrders = [{ id: 'trip', jobId: 'PO0020/V001/D001/T001/J0007', purchaseOrderId: 'PO0020-V001', poNumber: 'PO0020/V001',
    materialId: 'MAT001', materialName: 'MURRAM', unit: 'tonnes', status: 'SITE_WEIGHED_OUT', weightUnit: 'kg', siteNetWeight: 10000,
    receiptNoteId: 'PO0020/V001/D001/T001/J0007/RN001', accessBridgeKey: 'capture-key' }];
  state.stocks = [{ id: 'stock', deliveryOrderId: 'trip', purchaseOrderId: 'PO0020-V001', poNumber: 'PO0020/V001', remainingQuantity: 8, receivedQuantity: 10 }];
  state.stockMovements = [{ id: 'movement', purchaseOrderId: 'PO0020-V001', poNumber: 'PO0020/V001', quantity: 2 }];
  state.accessBridgeTickets = [{ id: 'ticket', purchaseOrderId: 'PO0020-V001', poNumber: 'PO0020/V001', netKg: 10000 }];
  state.jobCounters = [{ id: 'PO0001-V001', nextJobNumber: 3 }, { id: 'PO0020-V001', nextJobNumber: 9 }];
  return state;
}
function fakeDB(state) {
  const records = new Map(COLLECTIONS.flatMap(name => state[name].map(row => {
    const { id, ...data } = structuredClone(row);
    return [`${name}/${id}`, data];
  })));
  records.set('counters/auto_ids', structuredClone(state.autoIds));
  const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const query = (name, filters = []) => ({ name,
    doc(id) { return { path: `${name}/${id}`, get: async () => snapshot(`${name}/${id}`) }; },
    where(field, operator, values) { assert.equal(operator, 'in'); return query(name, [...filters, [field, values]]); },
    async get() { return { docs: [...records.keys()].filter(path => path.startsWith(name + '/')
      && filters.every(([field, values]) => values.includes(records.get(path)[field]))).map(snapshot) }; },
  });
  const db = { collection: name => query(name),
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({ get: ref => { assert.equal(writes.length, 0); return ref.get(); },
        delete: ref => writes.push([ref.path, null]),
        set: (ref, patch, options) => { assert.equal(options.merge, true); writes.push([ref.path, structuredClone(patch)]); } });
      for (const [path, patch] of writes) { if (patch === null) records.delete(path); else records.set(path, { ...records.get(path), ...patch }); }
      return result;
    } };
  return { db, records };
}
test('dry run identifies bridge duplicate, preserves manual commercial PO and previews counter high-water mark', () => {
  const state = fixture(), before = structuredClone(state);
  const plan = planRepairs(state);
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.pairs[0].keepId, 'PO0001-V001');
  assert.equal(plan.pairs[0].sourceId, 'PO0020-V001');
  assert.equal(plan.counter.after.purchase_order_v2_counter, 20);
  assert.deepEqual(state, before);
});
test('merge moves every reference but preserves issued job/receipt identifiers, weights and stock quantities', async () => {
  const state = fixture(), { db, records } = fakeDB(state);
  const pair = planRepairs(state).pairs[0];
  const backups = [];
  await applyPair(db, pair, async changes => { backups.push(changes); });
  const trip = records.get('deliveryOrders/trip');
  assert.equal(trip.purchaseOrderId, pair.keepId);
  assert.equal(trip.poNumber, 'PO0001/V001');
  assert.equal(trip.jobId, state.deliveryOrders[0].jobId);
  assert.equal(trip.receiptNoteId, state.deliveryOrders[0].receiptNoteId);
  assert.equal(trip.siteNetWeight, 10000);
  assert.equal(trip.accessBridgeKey, 'capture-key');
  assert.equal(records.get('stocks/stock').remainingQuantity, 8);
  assert.equal(records.get('stocks/stock').purchaseOrderId, pair.keepId);
  assert.equal(records.get('stockMovements/movement').purchaseOrderId, pair.keepId);
  assert.equal(records.get('accessBridgeTickets/ticket').purchaseOrderId, pair.keepId);
  const keeper = records.get(`purchaseOrders/${pair.keepId}`);
  assert.equal(keeper.pendingQualityControl, 15);
  assert.equal(keeper.quantity, 100);
  assert.equal(keeper.quantityDelivered, 10);
  assert.equal(keeper.status, 'approved');
  assert.equal(records.get(`purchaseOrders/${pair.sourceId}`).status, 'archived');
  assert.equal(records.get(`purchaseOrders/${pair.sourceId}`).pendingQualityControl, 0);
  assert.equal(records.get(`jobCounters/${pair.keepId}`).nextJobNumber, 9);
  assert.ok(backups[0].every(change => change.existed));
  assert.equal(backups[0].find(change => change.path === 'purchaseOrders/' + pair.sourceId).before.pendingQualityControl, 10);
  const after = structuredClone([...records]);
  assert.equal(await applyPair(db, pair, async () => assert.fail('No second backup needed')), 0);
  assert.deepEqual([...records], after);
  const reloaded = (await readState({ get: ref => ref.get() }, db)).state;
  assert.equal(planRepairs(reloaded).pairs.length, 0);
});
test('a failed backup prevents all database writes', async () => {
  const state = fixture(), { db, records } = fakeDB(state), before = structuredClone([...records]);
  await assert.rejects(applyPair(db, planRepairs(state).pairs[0], async () => { throw Error('disk full'); }), /disk full/);
  assert.deepEqual([...records], before);
});
test('PO counters include retired numbers, warehouse sequence and orphaned trip references; never decrease', async () => {
  const state = fixture();
  state.purchaseOrders.push({ id: 'WH0050-V001', status: 'archived' });
  state.deliveryOrders.push({ id: 'orphan', jobId: 'PO0070/V001/D001/T001/J0001' });
  state.autoIds.purchase_order_counter = 90;
  const { db, records } = fakeDB(state);
  await repairCounter(db, async changes => assert.equal(changes[0].before.vendor_counter, 99));
  assert.equal(records.get('counters/auto_ids').purchase_order_v2_counter, 70);
  assert.equal(records.get('counters/auto_ids').purchase_order_counter, 90);
  assert.equal(records.get('counters/auto_ids').vendor_counter, 99);
  assert.equal(await repairCounter(db, async () => assert.fail()), 0);
});
test('manual duplicates, nonzero contractual duplicates and warehouse POs are not retired', () => {
  for (const patch of [{ bridgeCreated: false, createdBy: 'admin' }, { quantity: 25 }, { isWarehouseMaterial: true }]) {
    const state = fixture();
    Object.assign(state.purchaseOrders[1], patch);
    assert.equal(planRepairs(state).pairs.length, 0);
  }
});
test('site conflicts and distinct material IDs stay separate, while filters can select a group', () => {
  const state = fixture();
  state.purchaseOrders[1].siteId = 'S002';
  assert.equal(planRepairs(state).pairs.length, 0);
  assert.equal(planRepairs(fixture(), { vendor: 'NO SUCH VENDOR' }).pairs.length, 0);
  assert.equal(planRepairs(fixture(), { vendor: 'HINDI', material: 'MURRAM' }).pairs.length, 1);
  const materials = fixture();
  materials.purchaseOrders[1].materialId = 'MAT002';
  assert.equal(planRepairs(materials).pairs.length, 0);
});
test('closed target is not reopened and changed source eligibility fails atomically', async () => {
  const state = fixture(), pair = planRepairs(state).pairs[0];
  state.purchaseOrders[0].status = 'closed';
  assert.equal(planRepairs(state, { keepPO: pair.keepId }).pairs.length, 0);
  const { db, records } = fakeDB(state), before = structuredClone([...records]);
  await assert.rejects(applyPair(db, pair, async () => assert.fail()), /eligibility changed/);
  assert.deepEqual([...records], before);
});
test('PO numbers on legacy references are repaired; genuinely conflicting IDs are respected', () => {
  const state = fixture();
  state.accessBridgeTickets = [{ id: 'legacy', purchaseOrderNumber: 'PO0020/V001' },
    { id: 'different', purchaseOrderId: 'another', poNumber: 'PO0020/V001' }];
  const changes = pairChanges(state, planRepairs(state).pairs[0], now);
  assert.equal(changes.find(change => change.id === 'legacy').patch.purchaseOrderNumber, 'PO0001/V001');
  assert.equal(changes.some(change => change.id === 'different'), false);
});
test('oversized atomic repairs and invalid counters are rejected without changes', () => {
  const state = fixture();
  state.stocks = Array.from({ length: 450 }, (_, i) => ({ id: 'stock' + i, purchaseOrderId: 'PO0020-V001' }));
  assert.throws(() => pairChanges(state, planRepairs(state).pairs[0], now), /450-write/);
  state.autoIds.purchase_order_v2_counter = 'invalid';
  assert.throws(() => counterRepair(state), /Invalid counter/);
});
test('CLI defaults to dry run and permits the configured project for writes', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--counters-only', '--apply']).countersOnly, true);
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.equal(parseArgs(['--apply']).project, undefined);
  assert.equal(parseArgs(['--apply', '--project', 'demo', '--env-file', '.env.env']).envFile, '.env.env');
  assert.throws(() => parseArgs(['--vendor']), /Missing value/);
});

test('sequential duplicate merges accumulate balances and trip counters exactly once', async () => {
  const state = fixture();
  state.purchaseOrders.push({ ...state.purchaseOrders[1], id: 'PO0021-V001', poNumber: 'PO0021/V001', pendingQualityControl: 4 });
  state.deliveryOrders.push({ ...state.deliveryOrders[0], id: 'trip2', purchaseOrderId: 'PO0021-V001',
    poNumber: 'PO0021/V001', jobId: 'PO0021/V001/D001/T001/J0012', siteNetWeight: 4000 });
  const plan = planRepairs(state), { db, records } = fakeDB(state);
  for (const pair of plan.pairs) await applyPair(db, pair, async () => {});
  const keeper = records.get('purchaseOrders/PO0001-V001');
  assert.equal(keeper.pendingQualityControl, 19);
  assert.equal(keeper.quantityDelivered, 14);
  assert.equal(records.get('jobCounters/PO0001-V001').nextJobNumber, 12);
  assert.equal(records.get('purchaseOrders/PO0021-V001').status, 'archived');
  const reloaded = (await readState({ get: ref => ref.get() }, db)).state;
  assert.equal(planRepairs(reloaded).pairs.length, 0);
});
test('job counter covers many one-trip duplicate orders even when all old J suffixes are one', () => {
  const state = fixture();
  state.jobCounters = [];
  state.deliveryOrders = Array.from({ length: 20 }, (_, i) => ({ ...state.deliveryOrders[0], id: 'trip' + i, jobId: `PO0020/V001/D${i}/T001/J0001` }));
  const changes = pairChanges(state, planRepairs(state).pairs[0], now);
  assert.equal(changes.find(change => change.collection === 'jobCounters').patch.nextJobNumber, 20);
});

test('scoped merge includes raw PO-number IDs and ignores unrelated records', async () => {
  const state = fixture();
  state.accessBridgeTickets.push({ id: 'raw-number', purchaseOrderId: 'PO0020/V001' });
  state.stocks.push({ id: 'unrelated', purchaseOrderId: 'other', remainingQuantity: 100 });
  const { db, records } = fakeDB(state);
  await applyPair(db, planRepairs(state).pairs[0], async () => {});
  assert.equal(records.get('accessBridgeTickets/raw-number').purchaseOrderId, 'PO0001-V001');
  assert.deepEqual(records.get('stocks/unrelated'), { purchaseOrderId: 'other', remainingQuantity: 100 });
});

test('atomic batches transfer multiple source balances once and are idempotent', async () => {
  const state = fixture();
  state.purchaseOrders.push({ ...state.purchaseOrders[1], id: 'PO0021-V001', poNumber: 'PO0021/V001', pendingQualityControl: 4 });
  state.deliveryOrders.push({ ...state.deliveryOrders[0], id: 'trip2', purchaseOrderId: 'PO0021-V001',
    poNumber: 'PO0021/V001', jobId: 'PO0021/V001/D001/T001/J0012', siteNetWeight: 4000 });
  const pairs = planRepairs(state).pairs, { db, records } = fakeDB(state);
  let backups = 0;
  await applyBatch(db, pairs, async changes => { backups++; assert.equal(changes.filter(c => c.path === 'purchaseOrders/PO0001-V001').length, 1); });
  assert.equal(backups, 1);
  assert.equal(records.get('purchaseOrders/PO0001-V001').pendingQualityControl, 19);
  assert.equal(records.get('purchaseOrders/PO0001-V001').quantityDelivered, 14);
  assert.equal(records.get('jobCounters/PO0001-V001').nextJobNumber, 12);
  assert.equal(await applyBatch(db, pairs, async () => assert.fail()), 0);
});
test('batch backup failure leaves every source and the keeper unchanged', async () => {
  const state = fixture(), { db, records } = fakeDB(state), before = structuredClone([...records]);
  await assert.rejects(applyBatch(db, planRepairs(state).pairs, async () => { throw Error('backup failed'); }), /backup failed/);
  assert.deepEqual([...records], before);
});

test('merged duplicates are deleted with backups, redirect history, and preserved counter reservations', async () => {
  const state = fixture(), { db, records } = fakeDB(state), pair = planRepairs(state).pairs[0];
  await applyBatch(db, [pair], async () => {});
  const fresh = (await readState({ get: ref => ref.get() }, db)).state;
  assert.equal(planMergedDeletions(fresh).pairs.length, 1);
  let saved;
  await deleteMergedBatch(db, [pair], async changes => { saved = changes; });
  assert.equal(records.has('purchaseOrders/' + pair.sourceId), false);
  assert.equal(records.has('jobCounters/' + pair.sourceId), false);
  assert.equal(records.get('purchaseOrderMerges/' + pair.sourceId).mergedIntoPurchaseOrderId, pair.keepId);
  assert.equal(records.get('purchaseOrders/' + pair.keepId).pendingQualityControl, 15);
  assert.equal(records.get('deliveryOrders/trip').purchaseOrderId, pair.keepId);
  assert.equal(saved.find(change => change.path === 'purchaseOrders/' + pair.sourceId).operation, 'delete');
  assert.equal(saved.find(change => change.path === 'purchaseOrders/' + pair.sourceId).before.status, 'archived');
  assert.equal(await deleteMergedBatch(db, [pair], async () => assert.fail()), 0);
  await repairCounter(db, async () => {});
  assert.equal(records.get('counters/auto_ids').purchase_order_v2_counter, 20);
});
test('deletion refuses references that arrived after merging and leaves all data intact', async () => {
  const state = fixture(), { db, records } = fakeDB(state), pair = planRepairs(state).pairs[0];
  await applyBatch(db, [pair], async () => {});
  records.set('deliveryOrders/late-trip', { purchaseOrderId: pair.sourceId });
  const before = structuredClone([...records]);
  await assert.rejects(deleteMergedBatch(db, [pair], async () => assert.fail()), /still has live references/);
  assert.deepEqual([...records], before);
});
test('deletion backup failure prevents permanent changes', async () => {
  const state = fixture(), { db, records } = fakeDB(state), pair = planRepairs(state).pairs[0];
  await applyBatch(db, [pair], async () => {});
  const before = structuredClone([...records]);
  await assert.rejects(deleteMergedBatch(db, [pair], async () => { throw Error('disk full'); }), /disk full/);
  assert.deepEqual([...records], before);
});

test('PO merge also updates nested material and receipt PO references', async () => {
  const state = fixture();
  state.deliveryOrders[0].materials = [{ materialId: 'MAT001', poNumber: 'PO0020/V001', purchaseOrderId: 'PO0020-V001', quantity: 10 }];
  state.deliveryOrders[0].materialInspection = { materialReceipts: [{ materialId: 'MAT001', purchaseOrderNumber: 'PO0020/V001' }] };
  const { db, records } = fakeDB(state);
  await applyPair(db, planRepairs(state).pairs[0], async () => {});
  const trip = records.get('deliveryOrders/trip');
  assert.equal(trip.materials[0].poNumber, 'PO0001/V001');
  assert.equal(trip.materials[0].purchaseOrderId, 'PO0001-V001');
  assert.equal(trip.materialInspection.materialReceipts[0].purchaseOrderNumber, 'PO0001/V001');
  assert.equal(trip.materials[0].quantity, 10);
});

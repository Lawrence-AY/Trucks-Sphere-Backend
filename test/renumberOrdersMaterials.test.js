const test = require('node:test');
const assert = require('node:assert/strict');
const { stockRows } = require('../src/modules/stocks/model');
const { matchMaterial } = require('../src/utils/materialMatching');
const { counterRepair } = require('../scripts/lib/repairBridgePurchaseOrders');
const { buildMaterialChanges } = require('../scripts/lib/repairMaterials');
const { COLLECTIONS, planNumbering, buildNumbering, readNumbering, applyNumbering } = require('../scripts/lib/renumberOrdersMaterials');
function fixture() {
  const s = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  s.materials = [{ id: 'MAT001', name: 'MURRAM', mergedMaterialIds: ['MAT002', 'MAT003'], aliases: ['MUURRAM'] },
    { id: 'MAT003', name: 'CLEAN WATER' }, { id: 'MAT004', name: 'RIVER SAND' }];
  s.purchaseOrders = [{ id: 'PO0001-V001', poNumber: 'PO0001/V001', vendorId: 'V001', materialId: 'MAT001', quantity: 100 },
    { id: 'PO0007-V002', poNumber: 'PO0007/V002', vendorId: 'V002', materialId: 'MAT003', materials: [{ materialId: 'MAT003', materialNumber: '003', quantity: 20 }] },
    { id: 'PO0318-V009', poNumber: 'PO0318/V009', vendorId: 'V009', materialId: 'MAT004' }];
  s.deliveryOrders = [{ id: 'delivery', jobId: 'PO0318/V009/D1/T1/J0007', purchaseOrderId: 'PO0318-V009', poNumber: 'PO0318/V009',
    materialId: 'MAT004', materialName: 'RIVER SAND', unit: 'tonnes', status: 'SITE_WEIGHED_OUT', siteNetWeight: 10, receiptNoteId: 'PO0318/V009/J0007/RN001' },
    { id: 'historical-prefix', jobId: 'PO0002/V002/D9/T9/J0012', purchaseOrderId: 'PO0001-V001', poNumber: 'PO0001/V001', materialId: 'MAT001' }];
  s.stocks = [{ ...stockRows(s.deliveryOrders[0])[0], remainingQuantity: 7, consumedQuantity: 3, unitCost: 25, currency: 'KES' }];
  s.stockMovements = [{ id: 'movement', stockId: s.stocks[0].id, quantity: 3 }];
  s.jobCounters = [{ id: 'PO0001-V001', nextJobNumber: 20 }, { id: 'PO0007-V002', nextJobNumber: 2 }, { id: 'PO0318-V009', nextJobNumber: 9 }];
  s.purchaseOrderMerges = [{ id: 'PO0999-V009', originalPoNumber: 'PO0999/V009', originalPurchaseOrderId: 'PO0999-V009', mergedIntoPurchaseOrderId: 'PO0318-V009', mergedIntoPoNumber: 'PO0318/V009' }];
  s.materialMerges = [{ id: 'MAT099', originalMaterialId: 'MAT099', mergedIntoMaterialId: 'MAT004' }];
  s.autoIds = { material_counter: 99, purchase_order_counter: 1783, purchase_order_v2_counter: 1783, receipt_note_counter: 45 };
  return s;
}
function fakeDB(state) {
  const records = new Map(COLLECTIONS.flatMap(name => state[name].map(row => [name + '/' + row.id, structuredClone(row)])));
  records.set('counters/auto_ids', structuredClone(state.autoIds));
  const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const db = { collection(name) { return { name, doc(id) { return { path: name + '/' + id }; } }; }, async runTransaction(fn) {
    const writes = [];
    const result = await fn({ async get(ref) { assert.equal(writes.length, 0); return ref.path ? snapshot(ref.path)
      : { docs: [...records.keys()].filter(path => path.startsWith(ref.name + '/')).map(snapshot) }; },
      set(ref, data, options) { writes.push([ref.path, structuredClone(data), options]); }, delete(ref) { writes.push([ref.path, null]); } });
    for (const [path, data, options] of writes) { if (data === null) records.delete(path); else records.set(path, options?.merge ? { ...records.get(path), ...data } : data); }
    return result;
  } };
  return { db, records };
}
test('numbering plan compacts gaps deterministically and preserves PO vendor suffixes', () => {
  const plan = planNumbering(fixture());
  assert.deepEqual(plan.materials.map(row => row.to), ['MAT001', 'MAT002', 'MAT003']);
  assert.deepEqual(plan.orders.map(row => row.poNumber), ['PO0001/V001', 'PO0002/V002', 'PO0003/V009']);
  assert.equal(plan.counters.purchase_order_v2_counter, 3);
});
test('atomic renumbering handles overlapping material paths, references, stock IDs and counters', async () => {
  const s = fixture(), { db, records } = fakeDB(s);
  let backup;
  await applyNumbering(db, 'revision', async data => { backup = data; });
  assert.equal(records.get('materials/MAT002').name, 'CLEAN WATER');
  assert.equal(records.get('materials/MAT003').name, 'RIVER SAND');
  assert.equal(records.has('materials/MAT004'), false);
  assert.equal(records.has('purchaseOrders/PO0318-V009'), false);
  assert.equal(records.get('purchaseOrders/PO0002-V002').materials[0].materialId, 'MAT002');
  assert.equal(records.get('purchaseOrders/PO0002-V002').materials[0].materialNumber, '002');
  const trip = records.get('deliveryOrders/delivery');
  assert.equal(trip.purchaseOrderId, 'PO0003-V009');
  assert.equal(trip.poNumber, 'PO0003/V009');
  assert.equal(trip.materialId, 'MAT003');
  assert.equal(trip.jobId, s.deliveryOrders[0].jobId);
  assert.equal(trip.receiptNoteId, s.deliveryOrders[0].receiptNoteId);
  assert.equal(trip.siteNetWeight, 10);
  const stock = records.get('stocks/' + stockRows(trip)[0].id);
  assert.equal(stock.remainingQuantity, 7); assert.equal(stock.consumedQuantity, 3); assert.equal(stock.unitCost, 25);
  assert.equal(records.get('stockMovements/movement').stockId, stock.id);
  assert.equal(records.get('jobCounters/PO0003-V009').nextJobNumber, 9);
  assert.equal(records.get('jobCounters/PO0002-V002').nextJobNumber, 12);
  assert.equal(records.get('counters/auto_ids').purchase_order_v2_counter, 3);
  assert.equal(records.get('counters/auto_ids').material_counter, 3);
  assert.equal(records.get('counters/auto_ids').receipt_note_counter, 45);
  assert.equal(records.get('purchaseOrderMerges/PO0999-V009').originalPoNumber, 'PO0999/V009');
  assert.equal(records.get('purchaseOrderMerges/PO0999-V009').mergedIntoPurchaseOrderId, 'PO0003-V009');
  assert.ok(backup.changes.some(row => row.path === 'materials/MAT003' && row.before.name === 'CLEAN WATER' && row.after.name === 'RIVER SAND'));
});
test('reused material numbers do not remain aliases of different canonical materials', async () => {
  const { db, records } = fakeDB(fixture());
  await applyNumbering(db, 'revision', async () => {});
  const materials = [...records].filter(([key]) => key.startsWith('materials/')).map(([, row]) => row);
  assert.equal(matchMaterial('CLEAN WATER', 'MAT002', materials).id, 'MAT002');
  assert.equal(matchMaterial('MUURRAM', '', materials).id, 'MAT001');
});
test('repairs respect compact numbering and ignore retired numbers and issued trip prefixes', async () => {
  const { db } = fakeDB(fixture());
  await applyNumbering(db, 'revision', async () => {});
  // Read through the same transactional reader used by production migration.
  await db.runTransaction(async tx => {
    const { state: current } = await readNumbering(tx, db);
    assert.equal(counterRepair(current).after.purchase_order_v2_counter, 3);
    assert.equal(buildMaterialChanges(current, [], 'now').length, 0);
  });
});
test('failed backup causes no changes and rerunning a completed migration is a no-op', async () => {
  const { db, records } = fakeDB(fixture());
  const before = structuredClone([...records]);
  await assert.rejects(applyNumbering(db, 'revision', async () => { throw Error('disk full'); }), /disk full/);
  assert.deepEqual([...records], before);
  await applyNumbering(db, 'revision', async () => {});
  const after = structuredClone([...records]);
  assert.equal((await applyNumbering(db, 'second-revision', async () => assert.fail())).writes, 0);
  assert.deepEqual([...records], after);
});
test('oversized migration cannot exceed atomic write limits', () => {
  const s = fixture();
  s.accessBridgeTickets = Array.from({ length: 451 }, (_, index) => ({ id: 'ticket' + index, materialId: 'MAT004' }));
  assert.throws(() => buildNumbering(s, 'revision', 'now'), /450-write/);
});

test('nested references to previously merged POs resolve through history and can be repaired after compaction', async () => {
  const s = fixture(), { db, records } = fakeDB(s);
  await applyNumbering(db, 'revision', async () => {});
  const trip = records.get('deliveryOrders/delivery');
  trip.materials = [{ materialId: 'MAT003', poNumber: 'PO0999/V009', purchaseOrderId: 'PO0999-V009' }];
  records.set('deliveryOrders/delivery', trip);
  const result = await applyNumbering(db, 'followup', async () => {});
  assert.equal(result.writes, 1);
  assert.equal(records.get('deliveryOrders/delivery').materials[0].poNumber, 'PO0003/V009');
  assert.equal(records.get('deliveryOrders/delivery').materials[0].purchaseOrderId, 'PO0003-V009');
  assert.equal(records.get('counters/auto_ids').numberingRevision.id, 'revision');
  assert.equal((await applyNumbering(db, 'third', async () => assert.fail())).writes, 0);
});

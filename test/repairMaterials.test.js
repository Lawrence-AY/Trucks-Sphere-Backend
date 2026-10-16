const test = require('node:test');
const assert = require('node:assert/strict');
const { stockRows } = require('../src/modules/stocks/model');
const { COLLECTIONS, planMaterials, buildMaterialChanges, applyMaterials } = require('../scripts/lib/repairMaterials');
function fixture() {
  const state = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  state.autoIds = { material_counter: 2, vendor_counter: 9 };
  state.materials = [{ id: 'MAT001', name: 'MURRAM', unit: 'tonnes' },
    { id: 'MAT004', name: 'MUURRAM', unit: 'tonnes' }, { id: 'MAT005', name: 'MURRRAM', unit: 'tonnes' },
    { id: 'MAT012', name: 'BALLAST 20MM', unit: 'tonnes' }, { id: 'MAT013', name: 'BALLAST 40MM', unit: 'tonnes' }];
  state.purchaseOrders = [{ id: 'PO1', materialId: 'MAT004', materialName: 'MUURRAM', quantity: 50,
    materials: [{ materialId: 'MAT004', materialName: 'MUURRAM', quantity: 50 }] }];
  state.deliveryOrders = [{ id: 'delivery1', jobId: 'PO1/D1/T1/J0001', status: 'SITE_WEIGHED_OUT', unit: 'tonnes',
    materialId: 'MAT004', materialName: 'MUURRAM', siteNetWeight: 10, receiptNoteId: 'RN001' }];
  const row = stockRows(state.deliveryOrders[0])[0];
  state.stocks = [{ ...row, consumedQuantity: 3, remainingQuantity: 7, unitCost: 250, currency: 'KES' }];
  state.stockMovements = [{ id: 'movement1', stockId: row.id, materialName: 'MUURRAM', quantity: 3 }];
  state.accessBridgeTickets = [{ id: 'ticket', materialId: 'MAT005', materialName: 'MURRRAM', netKg: 1000 }];
  return state;
}
function fakeDB(state) {
  const records = new Map(COLLECTIONS.flatMap(name => state[name].map(row => [name + '/' + row.id, structuredClone(row)])));
  records.set('counters/auto_ids', structuredClone(state.autoIds));
  const snapshot = path => ({ id: path.split('/').at(-1), exists: records.has(path), data: () => structuredClone(records.get(path)) });
  const db = { collection(name) { return { doc(id) { return { path: name + '/' + id }; } }; }, async runTransaction(fn) {
    const writes = [];
    const result = await fn({ async get(ref) {
      assert.equal(writes.length, 0);
      if (ref.path) return snapshot(ref.path);
      return { docs: [...records.keys()].filter(path => path.startsWith(ref.name + '/')).map(snapshot) };
    }, set(ref, data, options) { writes.push([ref.path, structuredClone(data), options]); }, delete(ref) { writes.push([ref.path, null]); } });
    for (const [path, data, options] of writes) { if (data === null) records.delete(path); else records.set(path, options?.merge ? { ...records.get(path), ...data } : data); }
    return result;
  } };
  const collection = db.collection;
  db.collection = name => ({ ...collection(name), name });
  return { db, records };
}
test('plans one canonical MURRAM group while preserving numeric material grades', () => {
  const state = fixture(), before = structuredClone(state);
  const plan = planMaterials(state);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].keepId, 'MAT001');
  assert.deepEqual(plan[0].sources.map(m => m.id), ['MAT004', 'MAT005']);
  assert.deepEqual(state, before);
});
test('warehouse designations, conflicting codes and units prevent unsafe grouping', () => {
  for (const patch of [{ isWarehouseMaterial: true }, { unit: 'pieces' }]) {
    const state = fixture(); Object.assign(state.materials[1], patch);
    assert.ok(!planMaterials(state)[0].sources.some(m => m.id === 'MAT004'));
  }
});
test('migration moves material refs, rekeys stocks, preserves quantities and updates movement identities', async () => {
  const state = fixture(), { db, records } = fakeDB(state), plan = planMaterials(state), before = structuredClone(state);
  let backup;
  const count = await applyMaterials(db, plan, async rows => { backup = rows; });
  assert.ok(count > 0);
  assert.deepEqual(state, before);
  assert.equal(records.has('materials/MAT004'), false);
  assert.equal(records.has('materials/MAT005'), false);
  assert.equal(records.get('materials/MAT001').aliases.includes('MUURRAM'), true);
  assert.deepEqual(records.get('materials/MAT001').mergedMaterialIds, ['MAT004', 'MAT005']);
  assert.equal(records.get('purchaseOrders/PO1').materials[0].materialId, 'MAT001');
  const delivery = records.get('deliveryOrders/delivery1');
  assert.equal(delivery.materialId, 'MAT001');
  assert.equal(delivery.jobId, before.deliveryOrders[0].jobId);
  assert.equal(delivery.receiptNoteId, 'RN001');
  const stockId = stockRows(delivery)[0].id;
  assert.equal(records.has('stocks/' + before.stocks[0].id), false);
  const stock = records.get('stocks/' + stockId);
  assert.equal(stock.consumedQuantity, 3); assert.equal(stock.remainingQuantity, 7); assert.equal(stock.receivedQuantity, 10);
  assert.equal(stock.unitCost, 250); assert.equal(stock.currency, 'KES');
  assert.equal(records.get('stockMovements/movement1').stockId, stockId);
  assert.equal(records.get('accessBridgeTickets/ticket').netKg, 1000);
  assert.equal(records.get('counters/auto_ids').material_counter, 13);
  assert.equal(records.get('counters/auto_ids').vendor_counter, 9);
  assert.ok(backup.some(row => row.operation === 'delete' && row.path === 'materials/MAT004' && row.before.name === 'MUURRAM'));
});
test('backup failure prevents all material and inventory writes', async () => {
  const state = fixture(), { db, records } = fakeDB(state), before = structuredClone([...records]);
  await assert.rejects(applyMaterials(db, planMaterials(state), async () => { throw Error('disk full'); }), /disk full/);
  assert.deepEqual([...records], before);
});
test('stock identity collisions abort instead of doubling or discarding inventory', () => {
  const state = fixture();
  const canonical = stockRows({ ...state.deliveryOrders[0], materialId: 'MAT001', materialName: 'MURRAM' })[0];
  state.stocks.push(canonical);
  assert.throws(() => buildMaterialChanges(state, planMaterials(state), 'now'), /collide/);
});
test('rerunning a completed plan cannot duplicate aliases, quantities or inventory', async () => {
  const state = fixture(), { db, records } = fakeDB(state), plan = planMaterials(state);
  await applyMaterials(db, plan, async () => {});
  const before = structuredClone([...records]);
  assert.equal(await applyMaterials(db, plan, async () => assert.fail()), 0);
  assert.deepEqual([...records], before);
});

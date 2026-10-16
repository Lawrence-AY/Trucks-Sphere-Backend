const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadService(purchaseOrders = []) {
  const records = {
    purchaseOrders,
    vendors: [{ id: 'V001', companyName: 'Vendor' }],
    materials: [
      { id: 'MAT001', name: 'Warehouse item', isWarehouseMaterial: true },
      { id: 'MAT002', name: 'Aggregate', defaultUnit: 'Tonnes' },
      { id: 'MAT003', name: 'Steel', measurementType: 'Pieces', defaultUnit: 'Tonnes' },
    ],
  };
  const module = { exports: {} };
  const dependencies = {
    './warehouse': require('../src/modules/purchase-orders/warehouse'),
    '../../../config/firebase': { db: { collection: () => ({ doc: () => ({
      get: async () => ({ exists: false }), set: async () => {},
    }) }) } },
    '../../utils/snapshotStore': { getAll: (name) => records[name] || [] },
    '../../utils/counterService': { getNextId: async () => 'PO0001', peekNextId: async () => 'PO0001' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/purchase-orders/service.js'), 'utf8'), {
    module, require: (name) => dependencies[name], console: { error() {} },
  });
  return module.exports;
}

test('warehouse reference cannot be combined with another PO material in either order', async () => {
  const lines = [{ materialId: 'MAT001' }, { materialId: 'MAT002', quantity: 12, unit: 'Tonnes' }];
  for (const materials of [lines, [...lines].reverse(), [lines[0], lines[0]]]) {
    await assert.rejects(loadService().create({ vendorId: 'V001', materials }),
      (error) => error.code === 'WAREHOUSE_PO_SINGLE_MATERIAL_REQUIRED');
  }
});

test('single warehouse material line saves without quantity or unit', async () => {
  const order = await loadService().create({ vendorId: 'V001', materials: [{ materialId: 'MAT001' }] });
  assert.equal(order.quantity, null);
  assert.equal(order.unit, null);
  assert.equal(order.materials[0].quantity, null);
  assert.equal(order.materials[0].unit, null);
  assert.equal(order.materials.length, 1);
});

test('non-warehouse PO lines still require a positive quantity', async () => {
  await assert.rejects(loadService().create({ vendorId: 'V001', materials: [{ materialId: 'MAT002' }] }),
    (error) => error.statusCode === 400);
});

test('single-material warehouse PO can omit quantity and unit', async () => {
  const order = await loadService().create({ vendorId: 'V001', materialId: 'MAT001' });
  assert.equal(order.quantity, null);
  assert.equal(order.unit, null);
});

test('PO units follow each saved material measurement type despite client overrides', async () => {
  const order = await loadService().create({ vendorId: 'V001', materials: [
    { materialId: 'MAT002', quantity: 2, unit: 'Litres' },
    { materialId: 'MAT003', quantity: 8, unit: 'Kilograms' },
  ] });
  assert.equal(order.unit, 'Tonnes');
  assert.deepEqual(Array.from(order.materials, (line) => line.unit), ['Tonnes', 'Pieces']);
});

 test('purchase orders use PO####/V### and warehouse references retain WH###/V###', async () => {
   for (const materialId of ['MAT001', 'MAT002']) {
     const service = loadService();
     const order = await service.create({ vendorId: 'V001', materialId, quantity: 10, poNumber: 'POMAT999/V001' });
     const reference = materialId === 'MAT001' ? 'WH001' : 'PO0001';
     assert.equal(order.poNumber, `${reference}/V001`);
     assert.equal(order.id, `${reference}-V001`);
     assert.equal(await service.previewNumber('V001', materialId), `${reference}/V001`);
   }
 });

test('order selectors receive all orders by default and explicit pagination still works', () => {
  const orders = Array.from({length: 75}, (_, i) => ({id: 'PO' + i, status: 'open'}));
  const service = loadService(orders);
  assert.equal(service.findAll().data.length, 75);
  const page = service.findAll({page: 2, limit: 50});
  assert.equal(page.data.length, 25);
  assert.equal(page.total, 75);
  assert.equal(page.totalPages, 2);
});

test('new purchase orders are active even when an older client submits open', async () => {
 for (const materialId of ['MAT001', 'MAT002']) {
  const order = await loadService().create({vendorId:'V001',materialId,quantity:10,status:'open'});
  assert.equal(order.status,'active');
 }
});

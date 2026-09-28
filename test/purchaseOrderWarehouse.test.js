const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadService() {
  const records = {
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
    '../../utils/counterService': { getNextId: async () => 'PO0001' },
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

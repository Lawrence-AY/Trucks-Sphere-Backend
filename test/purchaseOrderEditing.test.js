const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function service(existing) {
  let saved;
  const records = { vendors: [{ id: 'V002', companyName: 'New Vendor' }], materials: [
    { id: 'MAT001', name: 'Sand', measurementType: 'Tonnes' },
    { id: 'MAT002', name: 'Cement', measurementType: 'Bags' },
    { id: 'MAT003', name: 'Warehouse', isWarehouseMaterial: true },
  ] };
  const dependencies = {
    '../../../config/firebase': { db: { collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, data: () => existing }), update: async value => { saved = value; },
    }) }) } },
    '../../utils/snapshotStore': { getAll: name => records[name] || [] },
    '../../utils/counterService': {}, './warehouse': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/purchase-orders/service.js'), 'utf8'), {
    module, require: name => dependencies[name], console: { error() {} },
  });
  return { update: data => module.exports.update('PO1', data), saved: () => saved };
}
const po = { id: 'PO1', poNumber: 'PO0001/V001', status: 'active', createdAt: '2026-10-01', materialId: 'MAT001', quantity: 20,
  materials: [{ materialId: 'MAT001', quantity: 20, quantityDelivered: 5, remainingQuantity: 15 }, { materialId: 'MAT002', quantity: 8 }] };

test('multi-line edits update primary fields, resolve vendor and canonical units, preserve order identity', async () => {
  const api = service(po);
  const result = await api.update({ poNumber: 'wrong', id: 'wrong', createdAt: 'wrong', vendorId: 'V002', materials: [
    { materialId: 'MAT001', quantity: 30, unit: 'Bags' }, { materialId: 'MAT002', quantity: 12 },
  ] });
  assert.equal(result.poNumber, po.poNumber);
  assert.equal(result.id, po.id);
  assert.equal(result.createdAt, po.createdAt);
  assert.equal(result.vendorName, 'New Vendor');
  assert.equal(result.quantity, 30);
  assert.equal(result.materials[0].unit, 'Tonnes');
  assert.equal(result.materials[0].quantityDelivered, 5);
  assert.equal(result.materials[0].remainingQuantity, 25);
  assert.equal(result.materials[1].quantity, 12);
  assert.equal(result.materials[1].unit, 'Bags');
});

test('legacy quantity edits retain additional material lines', async () => {
  const result = await service(po).update({ quantity: 40 });
  assert.equal(result.materials.length, 2);
  assert.equal(result.materials[0].quantity, 40);
  assert.equal(result.materials[1].quantity, 8);
});

test('invalid material, vendor, empty lines and invalid quantities never write', async () => {
  for (const data of [{ vendorId: 'missing' }, { materials: [] }, { materials: [{ materialId: 'missing', quantity: 2 }] },
    ...[0, -1, 'bad', Infinity].map(quantity => ({ materials: [{ materialId: 'MAT001', quantity }] })),
    { materials: [{ materialId: 'MAT003' }, { materialId: 'MAT001', quantity: 1 }] }]) {
    const api = service(po);
    await assert.rejects(api.update(data), err => err.statusCode === 400);
    assert.equal(api.saved(), undefined);
  }
});

test('warehouse edits need no quantity and clear primary warehouse unit', async () => {
  const result = await service(po).update({ materials: [{ materialId: 'MAT003' }] });
  assert.equal(result.isWarehouseMaterial, true);
  assert.equal(result.quantity, null);
  assert.equal(result.unit, null);
});

test('closed orders reject detail edits while workflow-only updates continue to work', async () => {
  for (const status of ['cancelled', 'completed', 'archived']) {
    await assert.rejects(service({ ...po, status }).update({ quantity: 10 }), err => err.statusCode === 400);
  }
  assert.equal((await service({ ...po, status: 'completed' }).update({ status: 'archived' })).status, 'archived');
});

test('moving a material line preserves its delivered quantity', async () => {
  const result = await service(po).update({ materials: [{ materialId: 'MAT002', quantity: 8 }, { materialId: 'MAT001', quantity: 30 }] });
  assert.equal(result.materials[1].quantityDelivered, 5);
  assert.equal(result.materials[1].remainingQuantity, 25);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(materials = [], duringReservation) {
  let reserved = 0, writes = 0;
  const snapshot = () => ({ docs: materials.map(material => ({ id: material.id, data: () => material })) });
  const collection = { get: async () => snapshot(), doc: id => ({ id }) };
  const db = { collection: () => collection, async runTransaction(fn) {
    return fn({ get: async () => snapshot(), set(ref, data) { materials.push(data); writes++; } });
  } };
  const filename = path.resolve(__dirname, '../src/modules/materials/service.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console: { error() {} }, require(name) {
    if (name.endsWith('config/firebase')) return { db };
    if (name.endsWith('snapshotStore')) return {};
    if (name.endsWith('counterService')) return { async getNextId() { reserved++; duringReservation?.(materials); return 'MAT099'; } };
    return require(path.resolve(path.dirname(filename), name));
  } });
  return { service: module.exports, materials, get reserved() { return reserved; }, get writes() { return writes; } };
}
test('material creation reuses existing canonical spelling and consumes no material counter', async () => {
  for (const spelling of ['MUURRRAAM', 'MUURRAM', 'MURRRAM']) {
    const f = fixture([{ id: 'MAT001', name: 'MURRAM', unit: 'tonnes' }]);
    assert.equal((await f.service.create({ name: spelling, unit: 'tonnes' })).id, 'MAT001');
    assert.equal(f.reserved, 0); assert.equal(f.writes, 0);
  }
});
test('material creation respects numeric sizes and warehouse designations', async () => {
  const f = fixture([{ id: 'MAT001', name: 'BALLAST 20MM', unit: 'tonnes' }]);
  assert.equal((await f.service.create({ name: 'BALLAST 40MM', unit: 'tonnes' })).id, 'MAT099');
  assert.equal(f.writes, 1);
  const warehouse = fixture([{ id: 'MAT001', name: 'MURRAM', isWarehouseMaterial: true }]);
  assert.equal((await warehouse.service.create({ name: 'MURRAM' })).id, 'MAT099');
});
test('transaction recheck reuses a matching material created during ID reservation', async () => {
  const f = fixture([], materials => materials.push({ id: 'MAT050', name: 'MURRAM' }));
  assert.equal((await f.service.create({ name: 'MUURRAM' })).id, 'MAT050');
  assert.equal(f.writes, 0); assert.equal(f.materials.length, 1);
});

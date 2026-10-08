const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture() {
  const records = new Map([['vehicles/T1', { id: 'T1', registrationNumber: 'KAA123A', plateNumber: 'KAA123A', capacity: 10, status: 'active' }]]);
  const changes = [];
  const ref = (collection, id) => ({ key: `${collection}/${id}`, id });
  const db = { collection: collection => ({ doc: id => ref(collection, id), where: (field, op, value) => ({ collection, field, value }) }), runTransaction: async fn => {
    const writes = []; let writing = false;
    await fn({
      get: async target => {
        assert.equal(writing, false);
        if (target.key) return { exists: records.has(target.key), data: () => records.get(target.key), id: target.id };
        return { docs: [...records].filter(([key, value]) => key.startsWith(target.collection + '/') && value[target.field] === target.value).map(([key, value]) => ({ id: key.split('/')[1], data: () => value })) };
      },
      set: (target, value) => { writing = true; writes.push(() => records.set(target.key, value)); },
      update: (target, value) => { writing = true; writes.push(() => records.set(target.key, { ...records.get(target.key), ...value })); },
      delete: target => { writing = true; writes.push(() => records.delete(target.key)); },
    });
    writes.forEach(fn => fn());
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/vehicles/service'), 'utf8'), { module, console: { error() {} }, require: name => {
    if (name.includes('firebase')) return { db };
    if (name.includes('snapshotStore')) return { applyCommittedUpdate: (collection, id, item) => changes.push({ collection, id, item }) };
    if (name.includes('girService')) return { syncVehicle: async () => {} };
    return {};
  } });
  return { records, changes, service: module.exports };
}
test('vehicle edits normalize plates, persist fields and update realtime cache', async () => {
  const f = fixture();
  const saved = await f.service.update('T1', { registrationNumber: ' kab 456b ', model: 'FVZ', capacity: 25, status: 'in_maintenance' });
  assert.equal(saved.plateNumber, 'KAB456B');
  assert.equal(f.records.get('vehicles/T1').capacity, 25);
  assert.equal(f.records.get('vehicleRegistrations/KAB456B').vehicleId, 'T1');
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].item.status, 'in_maintenance');
});
test('legacy plate duplicates and invalid edits cannot overwrite vehicle records', async () => {
  const f = fixture();
  f.records.set('vehicles/T2', { plateNumber: 'KAB456B' });
  await assert.rejects(f.service.update('T1', { registrationNumber: 'KAB456B' }), error => error.code === 'VEHICLE_REGISTRATION_EXISTS');
  for (const capacity of [-1, 0, '', null, 'bad']) await assert.rejects(f.service.update('T1', { capacity }), error => error.statusCode === 400);
  await assert.rejects(f.service.update('T1', { status: 'bad' }), error => error.statusCode === 400);
  assert.equal(f.records.get('vehicles/T1').registrationNumber, 'KAA123A');
  assert.equal(f.changes.length, 0);
});

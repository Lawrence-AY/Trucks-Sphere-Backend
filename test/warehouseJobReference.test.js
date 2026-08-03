const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWarehouseJobId, buildWarehouseReference, normalizePomatReference } = require('../src/modules/warehouse-jobs/reference');

test('warehouse jobs include the typed POMAT reference, vendor, driver, truck, and job suffix', () => {
  const reference = buildWarehouseReference('POMAT077', { vendorId: 'V003' }, { driverId: 'D014' }, { vehicleId: 'T021' });
  assert.equal(reference, 'POMAT077/V003/D014/T021');
  assert.equal(buildWarehouseJobId(reference, 12), 'POMAT077/V003/D014/T021/J0012');
  assert.equal(normalizePomatReference('mat77'), 'POMAT077');
  assert.equal(normalizePomatReference('wrong'), '');
});

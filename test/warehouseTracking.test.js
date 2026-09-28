const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function service(records) {
  const filename = require.resolve('../src/modules/tracking/service');
  const module = { exports: {} };
  const mocks = {
    '../../../config/firebase': {},
    '../../utils/snapshotStore': {
      getAll: name => records[name] || [],
      getById: (name, id) => (records[name] || []).find(item => item.id === id),
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, console: { log() {} },
    require: name => mocks[name] || require(path.resolve(path.dirname(filename), name)),
  });
  return module.exports;
}

const shipment = { id: 'wh1', deliveryOrderId: 'delivery1', plateNumber: 'KAA 123B', driverName: 'Shipment Driver', dispatchedToSiteAt: '2026-09-27T10:00:00Z', items: [{ materialName: 'Bolts' }, { materialName: 'Paint' }] };
const delivery = { id: 'delivery1', warehouseJobId: 'wh1', isWarehouseDelivery: true, status: 'DISPATCHED', purchaseOrderId: 'po1' };

test('warehouse vehicle lookup supports formatted plates and legacy shipments without tracking IDs', () => {
  const tracking = service({ deliveryOrders: [delivery], warehouseJobs: [shipment] });
  for (const plate of ['kaa123b', 'KAA%20123B', 'KAA-123B']) {
    const record = tracking.findByPlate(plate);
    assert.equal(record.id, delivery.id);
    assert.equal(record.plateNumber, shipment.plateNumber);
    assert.equal(record.driverName, shipment.driverName);
    assert.match(record.trackingId, /^SA-[A-Z0-9]{7}$/);
    assert.equal(tracking.findByTrackingId(record.trackingId).id, delivery.id);
  }
});

test('plate lookup chooses the latest active dispatch across quarry and warehouse trips', () => {
  const old = { id: 'quarry1', plateNumber: shipment.plateNumber, status: 'DISPATCHED', weighOutAt: '2026-09-26T10:00:00Z' };
  const tracking = service({ deliveryOrders: [old, delivery], warehouseJobs: [shipment] });
  assert.equal(tracking.findByPlate('KAA123B').id, delivery.id);
});

test('warehouse public data uses shipped cargo and dispatch time without exposing private fields', () => {
  const tracking = service({ deliveryOrders: [{ ...delivery, internalNotes: 'private' }], warehouseJobs: [shipment], purchaseOrders: [{ id: 'po1', materials: [{ materialName: 'Unshipped product' }] }] });
  const result = tracking.sanitizeForPublic(tracking.findByPlate('KAA123B'));
  assert.equal(result.isWarehouseDelivery, true);
  assert.equal(result.materialSource, 'Warehouse');
  assert.equal(result.materials.map(item => item.materialName).join(', '), 'Bolts, Paint');
  assert.equal(result.dispatchedAt, shipment.dispatchedToSiteAt);
  assert.equal(result.internalNotes, undefined);
  assert.equal(result.warehouseJobId, undefined);
});

test('warehouse tracking expires on acceptance, denial, inspection, completion or cancellation', () => {
  for (const change of [{ warehouseAcceptedAt: 'today' }, { warehouseDeniedAt: 'today' }, { materialInspection: { mrfNumber: 'M1' } }, { status: 'COMPLETED' }, { status: 'CANCELLED' }]) {
    const tracking = service({ deliveryOrders: [{ ...delivery, ...change, trackingId: 'SA-ABC1234' }], warehouseJobs: [shipment] });
    assert.equal(tracking.findByPlate('KAA123B'), null);
    assert.equal(tracking.findByTrackingId('SA-ABC1234'), null);
  }
});

test('quarry tracking keeps its existing dispatch and expiry behavior', () => {
  const quarry = { id: 'q1', plateNumber: 'KBB 456C', trackingId: 'SA-ABC1234', status: 'DISPATCHED' };
  assert.equal(service({ deliveryOrders: [quarry] }).findByPlate('kbb456c').id, 'q1');
  assert.equal(service({ deliveryOrders: [{ ...quarry, status: 'SITE_WEIGHED_IN' }] }).findByPlate('kbb456c'), null);
});

test('warehouse dispatch proof uses the shipping photo, including linked legacy shipments', () => {
  const tracking = service({ deliveryOrders: [{...delivery,driverPhotoURL:'driver-photo'}], warehouseJobs: [{...shipment,packagingPhotoURL:'shipping-photo'}] });
  assert.equal(tracking.sanitizeForPublic(tracking.findByPlate('KAA123B')).dispatchProofPhotoURL,'shipping-photo');
});

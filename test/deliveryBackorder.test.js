const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBackorder,
  deriveBackorderJobKey,
  planSiteNetBackorder,
} = require('../src/modules/delivery-orders/backorder');

test('a short site net creates a backorder plan only on first completion', () => {
  const source = {
    id: 'job-1',
    jobId: 'POMAT001/V001/D001/T001/J0001',
    status: 'SITE_WEIGHED_IN',
    quantityOrdered: 30,
  };
  const updates = { status: 'SITE_WEIGHED_OUT', siteNetWeight: 23.5 };

  assert.deepEqual(planSiteNetBackorder(source, updates), {
    orderedQuantity: 30,
    deliveredQuantity: 23.5,
    remainingQuantity: 6.5,
  });
  assert.equal(planSiteNetBackorder({ ...source, status: 'SITE_WEIGHED_OUT' }, updates), null);
});

test('a full or over delivery does not create a backorder', () => {
  const source = { status: 'SITE_WEIGHED_IN', quantityOrdered: 30 };

  assert.equal(planSiteNetBackorder(source, { status: 'SITE_WEIGHED_OUT', quantityDelivered: 30 }), null);
  assert.equal(planSiteNetBackorder(source, { status: 'SITE_WEIGHED_OUT', quantityDelivered: 31 }), null);
  assert.equal(planSiteNetBackorder(source, { status: 'CANCELLED', quantityDelivered: 20 }), null);
});

test('a backorder retains delivery context but awaits a new driver, truck, and job number', () => {
  const source = {
    id: 'job-1',
    jobId: 'POMAT001/V001/D001/T001/J0001',
    purchaseOrderId: 'POMAT001-V001',
    poNumber: 'POMAT001/V001',
    vendorId: 'V001',
    materialId: 'MAT001',
    materialName: 'Ballast',
    driverId: 'D001',
    driverName: 'Driver',
    vehicleId: 'T001',
    plateNumber: 'KDA 123A',
    unit: 'tonnes',
  };
  const plan = { orderedQuantity: 30, deliveredQuantity: 23.5, remainingQuantity: 6.5 };
  const backorder = buildBackorder({
    source,
    plan,
    id: 'firestore-backorder-id',
    now: '2026-07-31T12:00:00.000Z',
  });

  assert.equal(deriveBackorderJobKey(source), 'POMAT001/V001/D001/T001');
  assert.equal(backorder.quantityOrdered, 6.5);
  assert.equal(backorder.quantityDelivered, 0);
  assert.equal(backorder.backorderOfDeliveryOrderId, 'job-1');
  assert.equal(backorder.status, 'CREATED');
  assert.equal(backorder.jobId, '');
  assert.equal(backorder.driverId, '');
  assert.equal(backorder.vehicleId, '');
  assert.equal(backorder.plateNumber, '');
});

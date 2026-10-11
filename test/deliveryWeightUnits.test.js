const test = require('node:test');
const assert = require('node:assert/strict');
const { toTonnes, toKilograms, storagePatch } = require('../src/utils/deliveryWeightUnits');
const { buildDeliverySummary } = require('../src/modules/purchase-orders/deliverySummary');
const { stockRows } = require('../src/modules/stocks/model');

test('legacy weight migration is idempotent and preserves commercial quantities', () => {
  const legacy = { weighInWeight: 12.5, netWeight: 20, quantityDelivered: 20, unit: 'tonnes' };
  const stored = toKilograms(legacy);
  assert.equal(stored.weighInWeight, 12500);
  assert.equal(stored.netWeight, 20000);
  assert.equal(stored.quantityDelivered, 20);
  assert.deepEqual(toKilograms(stored), stored);
  assert.deepEqual(toTonnes(stored), { ...legacy, weightUnit: 'tonnes' });
});

test('partial updates migrate all existing weights without converting twice', () => {
  const old = { weighInWeight: 12.5, siteArrivalWeightVarianceTolerance: 5 };
  const patch = storagePatch(old, { weighOutWeight: 32500, weightUnit: 'kg' });
  assert.equal(patch.weighInWeight, 12500);
  assert.equal(patch.weighOutWeight, 32500);
  assert.equal(patch.siteArrivalWeightVarianceTolerance, 5000);
  assert.deepEqual(storagePatch(patch, { storageLot: 'A' }), { ...patch, storageLot: 'A' });
  assert.equal(storagePatch(patch, { weighOutWeight: null }).weighOutWeight, null);
});

test('reject unknown units and non-finite weights', () => {
  assert.throws(() => toTonnes({ weightUnit: 'lb', weighInWeight: 10 }), /weightUnit/);
  assert.throws(() => toTonnes({ weightUnit: 'kg', weighInWeight: Infinity }), /finite/);
});

test('kg storage still produces tonne PO totals and stock quantities', () => {
  const delivery = { id: 'trip', purchaseOrderId: 'po', materialName: 'Sand', unit: 'tonnes',
    status: 'SITE_WEIGHED_OUT', quantityOrdered: 20, weightUnit: 'kg',
    siteWeighInWeight: 32000, siteWeighOutWeight: 12000, siteNetWeight: 20000 };
  const summary = buildDeliverySummary({ id: 'po', quantity: 20, unit: 'tonnes' }, [delivery]);
  assert.equal(summary.totals[0].deliveredQuantity, 20);
  assert.equal(stockRows(delivery)[0].receivedQuantity, 20);
});

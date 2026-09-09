const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptanceUpdates, denialUpdates, validateWarehouseUpdate } = require('../src/modules/warehouse-jobs/receipt');
const { warehouseReportFields } = require('../src/modules/reports/warehouseReport');
const { buildWarehouseReference } = require('../src/modules/warehouse-jobs/reference');
const submitted = { isWarehouseDelivery: true, status: 'DISPATCHED', packagingPhotoURL: 'photo.jpg' };

test('warehouse denial requires a reason and prevents subsequent acceptance or repeat decisions', () => {
  const denied = denialUpdates(submitted, { uid: 'receiver' }, '  Wrong products  ', '2026-09-07');
  assert.equal(denied.warehouseDenialReason, 'Wrong products');
  assert.equal(denied.warehouseDeniedByUid, 'receiver');
  assert.equal(denied.status, 'CANCELLED');
  assert.throws(() => denialUpdates(submitted, {}, '  '), (error) => error.statusCode === 400);
  assert.throws(() => acceptanceUpdates({ ...submitted, ...denied }, {}), { code: 'WAREHOUSE_DELIVERY_DENIED' });
  assert.throws(() => denialUpdates({ ...submitted, ...denied }, {}, 'Again'), { code: 'WAREHOUSE_ALREADY_DECIDED' });
  assert.throws(() => denialUpdates({ ...submitted, warehouseAcceptedAt: 'today' }, {}, 'Too late'), { code: 'WAREHOUSE_ALREADY_DECIDED' });
  assert.throws(() => denialUpdates({ ...submitted, isWarehouseDelivery: false }, {}, 'Wrong'), { code: 'WAREHOUSE_DELIVERY_REQUIRED' });
});

test('warehouse acceptance records the actor without inventing weights', () => {
  const changes = acceptanceUpdates(submitted, { uid: 'site-user', displayName: 'Receiver', siteId: 'S001' }, '2026-09-05');
  assert.equal(changes.warehouseAcceptedByUid, 'site-user');
  assert.equal(changes.siteId, 'S001');
  assert.equal(changes.workflowStage, 'awaiting_inspection');
  assert.equal(changes.siteWeighInWeight, undefined);
  assert.equal(acceptanceUpdates({ ...submitted, ...changes }, {}), null);
});

test('warehouse acceptance enforces photo, security and lifecycle checks', () => {
  for (const patch of [{ packagingPhotoURL: '' }, { isFlagged: true }, { status: 'CANCELLED' }]) {
    assert.throws(() => acceptanceUpdates({ ...submitted, ...patch }, {}), error => error.statusCode === 409);
  }
  assert.throws(() => acceptanceUpdates({ status: 'DISPATCHED' }, {}));
});

test('warehouse deliveries cannot be weighed or inspected before acceptance', () => {
  assert.throws(() => validateWarehouseUpdate(submitted, { siteWeighInWeight: 2 }), { code: 'WAREHOUSE_WEIGHING_NOT_APPLICABLE' });
  assert.throws(() => validateWarehouseUpdate(submitted, { siteWeighOutWeight: 1 }), { code: 'WAREHOUSE_WEIGHING_NOT_APPLICABLE' });
  assert.throws(() => validateWarehouseUpdate(submitted, { materialInspection: {} }), { code: 'WAREHOUSE_ACCEPTANCE_REQUIRED' });
  assert.doesNotThrow(() => validateWarehouseUpdate({ ...submitted, warehouseAcceptedAt: 'today' }, { materialInspection: {} }));
  assert.doesNotThrow(() => validateWarehouseUpdate({}, { siteWeighInWeight: 2 }));
});

test('warehouse job references omit driver and truck placeholders', () => {
  assert.equal(buildWarehouseReference('MAT007', { id: 'V001' }), 'POMAT007/V001');
});

test('warehouse reports retain distinct products and units without tonnage', () => {
  const fields = warehouseReportFields({ ...submitted, warehouseAcceptedAt: 'today',
    materials: [{ materialName: 'Bolts', quantity: 20, unit: 'Pieces' }, { materialName: 'Paint', quantity: 5, unit: 'Litres' }],
    materialInspection: { mrfNumber: 'MIF001', materialReceipts: [{ materialName: 'Paint', receivedQuantity: 4, unit: 'Litres' }] },
  });
  assert.equal(fields.siteWeighIn, '');
  assert.equal(fields.quantityDelivered, '');
  assert.match(fields.warehouseItems, /20 Pieces/);
  assert.match(fields.warehouseItems, /5 Litres/);
  assert.match(fields.warehouseReceivedItems, /4 Litres/);
  assert.equal(fields.warehouseReceiptStatus, 'Inspected');
});

test('warehouse creation accepts a mixed PO without fleet and preserves every product', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const records = {
    purchaseOrders: [{ id: 'PO1', poNumber: 'PO0001/V001', vendorId: 'V001', materialId: 'MAT001', materials: [{ materialId: 'MAT001' }, { materialId: 'MAT002' }] }],
    materials: [{ id: 'MAT001' }, { id: 'MAT002', isWarehouseMaterial: true }],
    vendors: [{ id: 'V001', companyName: 'Supplier' }],
  };
  const writes = [];
  const module = { exports: {} };
  const dependencies = {
    '../../../config/firebase': { db: {
      collection: (collection) => ({ doc: (id) => ({ collection, id }) }),
      runTransaction: (fn) => fn({ get: async (ref) => ({ exists: ref.collection === 'counters', data: () => ref.collection === 'counters' ? (writes.filter((entry) => entry.ref.collection === 'counters').at(-1)?.data || { receipt_note_counter: 41 }) : undefined }), set: (ref, data) => writes.push({ ref, data }) }),
    } },
    '../../utils/snapshotStore': { getAll: (name) => records[name] || [] },
    '../../utils/jobLifecycle': require('../src/utils/jobLifecycle'),
    //'../stocks/service': { prepare: async (_tx, delivery) => () => require('../src/modules/stocks/model').stockRows(delivery).forEach((row) => writes.push({ ref: { collection: 'stocks', id: row.id }, data: row })) },
    './reference': require('../src/modules/warehouse-jobs/reference'),
    '../../utils/jobIdService': { generateJobIdForPO: async (_, ref) => ({ jobId: `${ref}/J0001` }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/modules/warehouse-jobs/service.js'), 'utf8'), { module, require: (name) => dependencies[name] });
  const result = await module.exports.create({ purchaseOrderId: 'PO1', items: [
    { productName: 'Paint', quantity: 4, unit: 'Litres' }, { productName: 'Bolts', quantity: 20, unit: 'Pieces' },
  ] });
  assert.equal(result.driverId, undefined);
  assert.equal(result.receiptNoteId, 'PO0001/V001/RN042');
  assert.equal(result.vehicleId, undefined);
  assert.equal(result.jobId, 'POMAT002/V001/J0001');
  const delivery = writes.find((entry) => entry.ref.collection === 'deliveryOrders').data;
  assert.equal(delivery.materialId, 'MAT002');
  assert.equal(delivery.receiptNoteId, result.receiptNoteId);
  assert.equal(delivery.materials.length, 2);
  assert.notEqual(delivery.materials[0].materialId, delivery.materials[1].materialId);
  assert.equal(delivery.status, 'DISPATCHED');
  // assert.equal(writes.filter((entry) => entry.ref.collection === 'stocks').length, 2);
  const next = await module.exports.create({ purchaseOrderId: 'PO1', items: [{ productName: 'Paint', quantity: 1, unit: 'Litres' }] });
  assert.equal(next.receiptNoteId, 'PO0001/V001/RN043');
  // The warehouse picker accepts a material's public ID as well as its doc ID.
  records.materials[1].materialId = 'MAT002';
  records.materials[1].id = 'material-document-2';
  const aliased = await module.exports.create({ purchaseOrderId: 'PO1', items: [{ productName: 'Paint', quantity: 1, unit: 'Litres' }] });
  assert.equal(aliased.receiptNoteId, 'PO0001/V001/RN044');
  records.materials[1].isWarehouseMaterial = false;
  records.purchaseOrders[0].isWarehouseMaterial = true;
  await module.exports.create({ purchaseOrderId: 'PO1', items: [{ productName: 'Paint', quantity: 1, unit: 'Litres' }] });
  records.purchaseOrders[0].isWarehouseMaterial = false;
  await assert.rejects(module.exports.create({ purchaseOrderId: 'PO1', items: [{ productName: 'Paint', quantity: 1 }] }), { code: 'WAREHOUSE_MATERIAL_REQUIRED' });
});

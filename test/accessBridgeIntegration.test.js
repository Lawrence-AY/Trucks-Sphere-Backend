const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createProcessor } = require('../src/integrations/access-bridge/processor');

// Run the actual delivery, numbering and stock services against an isolated store.
// No Firebase credentials, production writes or network services are involved.
function fixture() {
  const records = new Map();
  const snapshot = (key) => ({ id: key.split('/').at(-1), exists: records.has(key), data: () => structuredClone(records.get(key)) });
  const ref = (key) => ({ id: key.split('/').at(-1),
    get: async () => snapshot(key),
    set: async (value, options) => records.set(key, structuredClone(options?.merge ? { ...records.get(key), ...value } : value)),
    update: async value => { assert.ok(records.has(key), key); records.set(key, { ...records.get(key), ...structuredClone(value) }); },
  });
  function collection(name, filters = []) {
    return {
      doc: id => ref(`${name}/${id}`),
      where: (field, operator, value) => { assert.equal(operator, '=='); return collection(name, [...filters, [field, value]]); },
      limit() { return this; },
      async get() {
        const docs = [...records.keys()].filter(key => key.startsWith(name + '/') && filters.every(([field, value]) => records.get(key)[field] === value)).map(snapshot);
        return { docs, forEach: fn => docs.forEach(fn) };
      },
    };
  }
  const db = { collection, async runTransaction(fn) {
    const writes = [];
    const result = await fn({ get: ref => ref.get(), set: (ref, data, options) => writes.push(() => ref.set(data, options)), update: (ref, data) => writes.push(() => ref.update(data)) });
    for (const write of writes) await write();
    return result;
  } };
  const cache = new Map();
  function load(filename) {
    filename = require.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, console: { log() {}, debug() {}, warn() {}, error() {} },
      process: { env: { ENABLE_DELIVERY_BACKORDERS: 'false' } },
      require(name) {
        if (name.endsWith('config/firebase')) return { db, admin: { firestore: { FieldValue: { delete: () => null } } } };
        if (name.endsWith('girService')) return { clearFuelSession: async () => {}, setJobReference: async () => {} };
        if (name.endsWith('snapshotStore')) return {
          getAll: name => [...records].filter(([key]) => key.startsWith(name + '/')).map(([key, value]) => ({ ...value, id: key.split('/').at(-1) })),
          getById: (name, id) => records.get(`${name}/${id}`),
        };
        return name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name);
      },
    }, { filename });
    return module.exports;
  }
  records.set('vehicles/T001', { plateNumber: 'KAA123A' });
  records.set('drivers/D001', { name: 'Driver' });
  records.set('sites/S001', { name: 'Site', weighbridgeWeightUnit: 'kg' });
  records.set('purchaseOrders/PO1', { poNumber: 'POMAT001/V001', vendorId: 'V001', siteId: 'S001', materialId: 'MAT001', materialName: 'Sand', quantity: 20, unit: 'tonnes', status: 'open' });
  records.set('jobCounters/PO1', { nextJobNumber: 7 });
  const deliveries = load('../src/modules/delivery-orders/service');
  const repository = {
    all: async name => (await collection(name).get()).docs.map(doc => ({ ...doc.data(), id: doc.id })),
    async bind(id, key, source, siteId) {
      const doc = collection('deliveryOrders').doc(id);
      await doc.update({ accessBridgeKey: key, accessBridgeSource: source, siteId });
      return { ...(await doc.get()).data(), id };
    },
  };
  return { records, repository, deliveries, process: createProcessor({ repository, deliveries, config: { sourceId: 'integration', utcOffset: '+03:00' } }) };
}
const row = { PLAKA: 'KAA123A', DIGER3_ISIM: 'Driver', DIGER5_ISIM: 'POMAT001/V001', TARTIM1: 30000, TARIH1: '2026-10-02', SAAT1: '10:00:00' };
const event = row => ({ event_type: 'INSERT', table_name: row.TARTIM2 ? 'KAYITLAR' : 'ICERIDEKI_ARACLAR', payload: JSON.stringify(row) });

test('unscheduled capture uses real shared job and receipt counters and survives a failed weigh-in', async () => {
  const f = fixture();
  const update = f.deliveries.updateFresh;
  f.deliveries.updateFresh = async () => { throw new Error('temporary failure'); };
  await assert.rejects(f.process(event(row)), /temporary failure/);
  assert.equal((await f.repository.all('deliveryOrders')).length, 1);
  f.deliveries.updateFresh = update;
  const first = await f.process(event(row));
  const job = f.records.get(`deliveryOrders/${first.jobId}`);
  assert.equal(job.jobId, 'POMAT001/V001/D001/T001/J0008');
  assert.equal(job.isUnscheduled, true);
  assert.equal(job.siteArrivalCompleted, true);
  assert.equal(job.status, 'SITE_WEIGHED_IN');
  const second = event({ ...row, TARTIM2: 10000, TARIH2: '2026-10-02', SAAT2: '11:00:00' });
  const result = await f.process(second);
  await f.process(second);
  const completed = f.records.get(`deliveryOrders/${first.jobId}`);
  assert.equal(completed.status, 'SITE_WEIGHED_OUT');
  assert.match(result.receiptNoteId, /^POMAT001\/V001\/D001\/T001\/J0008\/RN\d+$/);
  assert.equal(f.records.get('jobCounters/PO1').nextJobNumber, 8);
  assert.equal(f.records.get('purchaseOrders/PO1').pendingQualityControl, 20);
  assert.equal((await f.repository.all('deliveryOrders')).length, 1);
});

test('real delivery service preserves scheduled numbering, arrival markers, receipt and retries', async () => {
  const f = fixture();
  f.records.set('deliveryOrders/scheduled', { jobId: 'POMAT001/V001/D001/T001/J0008', purchaseOrderId: 'PO1', poNumber: 'POMAT001/V001', driverId: 'D001', vehicleId: 'T001', status: 'DISPATCHED' });
  const first = await f.process(event(row));
  let job = f.records.get(`deliveryOrders/${first.jobId}`);
  assert.equal(job.jobId, 'POMAT001/V001/D001/T001/J0008');
  assert.equal(job.status, 'SITE_WEIGHED_IN');
  assert.equal(job.siteArrivalCompleted, true);
  assert.equal(job.workflowStage, 'ready_for_site_weights');
  assert.equal(job.receiptNoteId, undefined);
  const second = { ...row, TARTIM2: 10000, TARIH2: '2026-10-02', SAAT2: '11:00:00' };
  const completed = await f.process(event(second));
  job = f.records.get(`deliveryOrders/${first.jobId}`);
  assert.equal(job.siteWeighOutWeight, 10);
  assert.equal(job.quantityDelivered, 20);
  assert.equal(job.status, 'SITE_WEIGHED_OUT');
  assert.match(completed.receiptNoteId, /^POMAT001\/V001\/D001\/T001\/J0008\/RN\d+$/);
  await f.process(event(second));
  assert.equal(f.records.get('jobCounters/PO1').nextJobNumber, 7);
  assert.equal(f.records.get('purchaseOrders/PO1').pendingQualityControl, 20);
  assert.equal((await f.repository.all('deliveryOrders')).length, 1);
});

test('real delivery service preserves warehouse products and creates the receipt after weigh-out', async () => {
  const f = fixture();
  f.records.set('deliveryOrders/warehouse', {
    jobId: 'WH0001/V001/D001/T001/J0001', isWarehouseDelivery: true,
    purchaseOrderId: 'PO1', driverId: 'D001', vehicleId: 'T001', status: 'DISPATCHED',
    quantityDelivered: 8, unit: 'pieces', materials: [{ materialId: 'MAT001', materialName: 'Product', quantity: 8, unit: 'pieces' }],
  });
  await f.process(event(row));
  const result = await f.process(event({ ...row, TARTIM2: 10000, TARIH2: '2026-10-02', SAAT2: '11:00:00' }));
  const job = f.records.get('deliveryOrders/warehouse');
  assert.equal(job.siteId, 'S001');
  assert.equal(job.quantityDelivered, 8);
  assert.equal(job.materials[0].quantity, 8);
  assert.equal(job.workflowStage, 'awaiting_inspection');
  assert.ok(job.warehouseAcceptedAt);
  assert.match(result.receiptNoteId, /\/RN\d+$/);
});

test('warehouse shipment with a registered plate and no site retains security checks', async () => {
  const f = fixture();
  f.records.delete('vehicles/T001'); f.records.delete('drivers/D001'); f.records.delete('sites/S001');
  f.records.set('vehicles/T002', { plateNumber: 'KHG236G' });
  f.records.set('deliveryOrders/warehouse', {
    jobId: 'WH0009/V010/J0008', isWarehouseDelivery: true, plateNumber: 'KHG236G', driverName: 'jason',
    status: 'DISPATCHED', quantityDelivered: 8, unit: 'pieces', siteId: '',
    materials: [{ materialId: 'MAT001', quantity: 8, unit: 'pieces' }], isFlagged: true,
  });
  const process = createProcessor({ repository: f.repository, deliveries: f.deliveries, config: { sourceId: 'integration', utcOffset: '+03:00', sourceWeightUnit: 'tonnes' } });
  const capture = event({ ...row, DIGER5_ISIM: '', PLAKA: 'KHG236G', DIGER3_ISIM: 'jason', TARTIM1: 23, TARTIM2: 12, TARIH2: '2026-10-02', SAAT2: '11:00:00' });
  await assert.rejects(process(capture), { code: 'SECURITY_FLAG_UNRESOLVED' });
  f.records.get('deliveryOrders/warehouse').isFlagged = false;
  const result = await process(capture);
  const job = f.records.get('deliveryOrders/warehouse');
  assert.equal(job.siteNetWeight, 11);
  assert.equal(job.quantityDelivered, 8);
  assert.equal(job.status, 'SITE_WEIGHED_OUT');
  assert.equal(job.workflowStage, 'awaiting_inspection');
  assert.ok(result.receiptNoteId);
  await process(capture);
  assert.equal(f.records.get('deliveryOrders/warehouse').receiptNoteId, result.receiptNoteId);
});


test('PO0017 first weight 2300 persists on the same trip through failure, retry, refresh and weigh-out', async () => {
  const f = fixture();
  const id = 'PO0017-V008-D007-T006-J0001';
  const original = { jobId: 'PO0017/V008/D007/T006/J0001', poNumber: 'PO0017/V008', purchaseOrderId: 'PO0017-V008',
    vendorId: 'V008', vendorName: 'Abdifattah Ali Kurawa', driverId: 'D007', driverName: 'Kibaki Kubaki',
    vehicleId: 'T006', plateNumber: 'KDD678L', materialName: 'Ballast', quarryLocation: 'Ngomeni',
    status: 'DISPATCHED', createdAt: '2026-10-03T05:43:38.457Z', weighInWeight: 1000, weighOutWeight: 2300 };
  f.records.set('deliveryOrders/' + id, original);
  f.records.set('vehicles/T006', { plateNumber: 'KDD678L' });
  f.records.set('drivers/D007', { name: 'Kibaki Kubaki' });
  const config = { sourceId: 'integration', utcOffset: '+03:00', sourceWeightUnit: 'tonnes' };
  const captureRow = { PLAKA: 'KDD 678L', DIGER3_ISIM: 'Kibaki Kubaki', FIRMA_ADI: 'Abdifattah Ali Kurawa',
    DIGER1_ISIM: 'Ngomeni', MALZEME_ADI: 'Ballast', DIGER4_ISIM: 'Ngomeni Trials', OPERATOR_ADI: 'HIM',
    TARTIM1: '2300.', TARIH1: '2026-10-03 00:00:00', SAAT1: '1899-12-30 08:42:44' };
  const first = { ...event(captureRow), observed_utc: '2026-10-03T05:46:28.319Z' };
  const failed = createProcessor({ repository: f.repository, deliveries: { updateFresh: async () => { throw new Error('database unavailable'); } }, config });
  await assert.rejects(failed(first), /database unavailable/);
  assert.equal(f.records.get('deliveryOrders/' + id).status, 'DISPATCHED');
  assert.equal(f.records.get('deliveryOrders/' + id).siteWeighInWeight, undefined);
  const process = createProcessor({ repository: f.repository, deliveries: f.deliveries, config });
  assert.equal((await process(first)).jobId, id);
  await createProcessor({ repository: f.repository, deliveries: f.deliveries, config })(first);
  const job = (await f.repository.all('deliveryOrders')).find(j => j.id === id);
  assert.equal(job.status, 'SITE_WEIGHED_IN');
  assert.equal(job.siteWeighInWeight, 2300);
  assert.equal(job.siteArrivalWeight, 2300);
  assert.equal(job.workflowStage, 'ready_for_site_weights');
  assert.equal(job.siteWeighInByName, 'HIM');
  assert.equal(job.accessCapture.explanation, 'Ngomeni Trials');
  assert.equal(job.receiptNoteId, undefined);
  for (const key of ['jobId', 'poNumber', 'purchaseOrderId', 'vendorId', 'vendorName', 'driverId', 'driverName', 'vehicleId', 'plateNumber', 'materialName', 'quarryLocation']) assert.equal(job[key], original[key]);
  assert.equal((await f.repository.all('deliveryOrders')).length, 1);
  const second = event({ ...captureRow, TARTIM2: 1000, TARIH2: '2026-10-03', SAAT2: '09:00:00' });
  await process(second);
  await process(second);
  const finished = f.records.get('deliveryOrders/' + id);
  assert.equal(finished.status, 'SITE_WEIGHED_OUT');
  assert.equal(finished.siteNetWeight, 1300);
  assert.equal((await f.repository.all('deliveryOrders')).length, 1);
});

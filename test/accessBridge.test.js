const test = require('node:test');
const assert = require('node:assert/strict');
const { createProcessor, capture } = require('../src/integrations/access-bridge/processor');
const { readConfig } = require('../src/integrations/access-bridge/config');
const { validateWarehouseUpdate, warehouseWeighOutUpdates } = require('../src/modules/warehouse-jobs/receipt');
const config = { sourceId: 'bridge', utcOffset: '+03:00' };
const first = { PLAKA: 'KAA 123A', TARTIM1: 30000, TARIH1: '2026-10-02', SAAT1: '1899-12-30T10:00:00', TARTIM2: 0 };
const second = { ...first, KAYIT_NO: 10, TARTIM2: 10000, TARIH2: '2026-10-02', SAAT2: '1899-12-30T11:00:00' };
test('Tunaylar kilogram weights and legacy dates retain correct tonnes and local time',()=>{
 const row={PLAKA:'KDQ532V',TARTIM1:34100,TARTIM2:11150,TARIH1:'2026-08-10T00:00:00',SAAT1:'1899-12-30T14:29:18',TARIH2:'2026-08-10T00:00:00',SAAT2:'1899-12-30T14:42:53'};
 const result=capture(row,config,'kg');
 assert.equal(result.first,34.1);assert.equal(result.second,11.15);
 assert.equal(Number((result.first-result.second).toFixed(2)),22.95);
 assert.equal(result.firstAt,'2026-08-10T11:29:18.000Z');
});
const scheduled = { id: 'scheduled', jobId: 'POMAT001/V001/D001/T001/J0001', siteId: 'S001', driverId: 'D001', vehicleId: 'T001', plateNumber: first.PLAKA, status: 'DISPATCHED', createdAt: '2026-10-01T00:00:00Z' };
function fixture(jobs = [scheduled]) {
  const data = {
    deliveryOrders: structuredClone(jobs), vehicles: [{ id: 'T001', plateNumber: first.PLAKA }],
    drivers: [{ id: 'D001', nationalId: '12345678', name: 'Driver' }], sites: [{ id: 'S001', name: 'Site', weighbridgeWeightUnit: 'kg' }],
    purchaseOrders: [{ id: 'PO1', poNumber: 'POMAT001/V001', vendorId: 'V001', siteId: 'S001', status: 'open', materialName: 'Sand' }],
  };
  const writes = [];
  const repository = {
    all: async name => structuredClone(data[name]),
    async bind(id, key) { const job = data.deliveryOrders.find(j => j.id === id); job.accessBridgeKey = key; return structuredClone(job); },
  };
  const deliveries = {
    async create(payload) {
      const job = { ...payload, id: 'custom', jobId: payload.jobKey + '/J0002' };
      data.deliveryOrders.push(job); writes.push({ create: payload }); return structuredClone(job);
    },
    async updateFresh(id, payload) {
      const job = data.deliveryOrders.find(j => j.id === id);
      validateWarehouseUpdate(job, payload);
      const warehouse = warehouseWeighOutUpdates(job, payload);
      Object.assign(job, payload, warehouse);
      if (payload.siteWeighInWeight != null) job.status = 'SITE_WEIGHED_IN';
      if (payload.siteWeighOutWeight != null) job.receiptNoteId = job.jobId + '/RN001';
      writes.push(payload); return structuredClone(job);
    },
  };
  const process = createProcessor({ repository, deliveries, config });
  const event = (row, type = 'INSERT', table = row.KAYIT_NO ? 'KAYITLAR' : 'ICERIDEKI_ARACLAR') => ({ payload: JSON.stringify(row), event_type: type, table_name: table });
  return { data, writes, process, event, repository, deliveries };
}
test('scheduled first and second weighs update one job and generate one receipt across retries', async () => {
  const f = fixture();
  await f.process(f.event(first));
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, 30);
  assert.equal(f.data.deliveryOrders[0].siteWeighInAt, '2026-10-02T07:00:00.000Z');
  const result = await f.process(f.event(second));
  assert.match(result.receiptNoteId, /RN001$/);
  assert.equal(f.data.deliveryOrders[0].siteWeighOutWeight, 10);
  assert.equal(f.data.deliveryOrders[0].quantityDelivered, 20);
  const restarted = createProcessor({ repository: f.repository, deliveries: f.deliveries, config });
  await restarted(f.event(second, 'UPDATE'));
  assert.equal(f.writes.length, 2);
});
test('Access ODBC space-separated times match ISO captures and process waiting vehicles', async () => {
  const f = fixture();
  const odbc = { ...first, TARIH1: '2026-10-02 00:00:00', SAAT1: '1899-12-30 10:00:00' };
  assert.deepEqual(capture(odbc, config, 'kg'), capture(first, config, 'kg'));
  assert.equal((await f.process(f.event(odbc, 'BASELINE'))).status, 'processed');
  assert.equal(f.data.deliveryOrders[0].siteWeighInAt, '2026-10-02T07:00:00.000Z');
});

test('unscheduled registered truck creates one job using the matched PO', async () => {
  const f = fixture([]);
  const row = { ...first, DIGER3_ISIM: 'Driver', DIGER5_ISIM: 'POMAT001/V001' };
  await f.process(f.event(row));
  await f.process(f.event(row));
  assert.equal(f.data.deliveryOrders.length, 1);
  assert.equal(f.data.deliveryOrders[0].isUnscheduled, true);
  assert.equal(f.data.deliveryOrders[0].purchaseOrderId, 'PO1');
  assert.equal(f.data.deliveryOrders[0].jobId, 'POMAT001/V001/D001/T001/J0002');
  assert.equal(f.data.deliveryOrders[0].status, 'SITE_WEIGHED_IN');
});





test('a supplied different driver blocks a scheduled capture', async () => {
  const f = fixture();
  await assert.rejects(f.process(f.event({ ...first, DIGER3_ISIM: 'Unknown' })), { code: 'SCHEDULE_CONTEXT_MISMATCH' });
  assert.equal(f.writes.length, 0);
});



test('restart after binding but before weigh-in reuses the scheduled job', async () => {
  const f = fixture();
  const update = f.deliveries.updateFresh;
  f.deliveries.updateFresh = async () => { throw new Error('interrupted'); };
  const row = { ...first, DIGER3_ISIM: 'Driver', };
  await assert.rejects(f.process(f.event(row)), /interrupted/);
  f.deliveries.updateFresh = update;
  await f.process(f.event(row));
  assert.equal(f.data.deliveryOrders.length, 1);
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, 30);
});

test('app-entered arrival created just after the capture is reused', async () => {
  const f = fixture([{ ...scheduled, createdAt: '2026-10-02T07:00:30Z', siteWeighInAt: '2026-10-02T07:00:30Z', siteWeighInWeight: 30 }]);
  await f.process(f.event(second));
  assert.equal(f.data.deliveryOrders.length, 1);
  assert.equal(f.data.deliveryOrders[0].siteWeighOutWeight, 10);
});

test('scheduled first weighing tolerates two minutes of Access clock skew after the schedule exists at upload', async () => {
  const f = fixture([{ ...scheduled, createdAt: '2026-10-02T07:00:54Z' }]);
  await f.process({ ...f.event(first), observed_utc: '2026-10-02T07:03:44Z' });
  assert.equal(f.data.deliveryOrders.length, 1);
  assert.equal(f.data.deliveryOrders[0].status, 'SITE_WEIGHED_IN');
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, 30);
});

test('clock skew does not attach historical captures to future schedules', async () => {
  for (const [createdAt, observed_utc] of [
    ['2026-10-02T07:02:01Z', '2026-10-02T07:03:44Z'],
    ['2026-10-02T07:00:54Z', '2026-10-02T07:00:53Z'],
    ['2026-10-02T07:00:54Z', undefined],
  ]) {
    const f = fixture([{ ...scheduled, createdAt }]);
    await assert.rejects(f.process({ ...f.event(first), observed_utc }), { code: 'UNMATCHED_SCHEDULE' });
    assert.equal(f.writes.length, 0);
  }
});

test('clock skew retains ambiguity and driver checks', async () => {
  const job = { ...scheduled, createdAt: '2026-10-02T07:00:54Z' };
  const f = fixture([job, { ...job, id: 'another' }]);
  await assert.rejects(f.process({ ...f.event(first), observed_utc: '2026-10-02T07:03:44Z' }), { code: 'AMBIGUOUS_SCHEDULE' });
  assert.equal(f.writes.length, 0);
  f.data.deliveryOrders.pop();
  f.data.drivers.push({ id: 'D002', name: 'Other' });
  await assert.rejects(f.process({ ...f.event({ ...first, DIGER3_ISIM: 'Other' }), observed_utc: '2026-10-02T07:03:44Z' }), { code: 'SCHEDULE_DRIVER_MISMATCH' });
  assert.equal(f.writes.length, 0);
});
test('an entered scheduled plate requires a fleet registry record', async () => {
  const f = fixture(); f.data.vehicles = [];
  await assert.rejects(f.process(f.event(first)), { code: 'UNKNOWN_TRUCK' });
  assert.equal(f.writes.length, 0);
});

test('warehouse completion preserves product quantities and inspection workflow', async () => {
  const f = fixture([{ ...scheduled, isWarehouseDelivery: true, quantityDelivered: 8, unit: 'pieces' }]);
  await f.process(f.event(second));
  const job = f.data.deliveryOrders[0];
  assert.equal(job.quantityDelivered, 8);
  assert.equal(job.siteNetWeight, 20);
  assert.equal(job.workflowStage, 'awaiting_inspection');
  assert.match(job.receiptNoteId, /RN001$/);
});
test('capture weight unit comes from the matched TruckSphere site', async () => {
  const f = fixture();
  f.data.sites[0].weighbridgeWeightUnit = 'tonnes';
  await f.process(f.event(first));
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, 30000);
});

test('warehouse schedule accepts a registered plate and entered driver without a site', async () => {
  const f = fixture([{ ...scheduled, isWarehouseDelivery: true, vehicleId: undefined, driverId: undefined, driverName: 'Jason', siteId: '', quantityDelivered: 8 }]);
  f.data.drivers = []; f.data.sites = [];
  const process = createProcessor({ repository: f.repository, deliveries: f.deliveries, config: { ...config, sourceWeightUnit: 'tonnes' } });
  const record = { ...second, TARTIM1: 23, TARTIM2: 12, DIGER3_ISIM: 'jason' };
  assert.equal((await process(f.event(record))).status, 'processed');
  assert.equal(f.data.deliveryOrders[0].siteNetWeight, 11);
  assert.equal(f.data.deliveryOrders[0].quantityDelivered, 8);
  await process(f.event(record));
  assert.equal(f.writes.length, 2);
});

test('warehouse schedule does not accept a different entered driver', async () => {
  const f = fixture([{ ...scheduled, isWarehouseDelivery: true, driverId: undefined, driverName: 'Jason' }]);
  await assert.rejects(f.process(f.event({ ...first, DIGER3_ISIM: 'Other' })), { code: 'SCHEDULE_CONTEXT_MISMATCH' });
  assert.equal(f.writes.length, 0);
});

test('existing schedule without site uses explicitly configured source unit', async () => {
  const f = fixture([{ ...scheduled, siteId: '' }]);
  f.data.sites = [];
  const process = createProcessor({ repository: f.repository, deliveries: f.deliveries, config: { ...config, sourceWeightUnit: 'tonnes' } });
  assert.equal((await process(f.event({ ...second, TARTIM1: 23, TARTIM2: 12 }))).status, 'processed');
  assert.equal(f.data.deliveryOrders[0].siteNetWeight, 11);
});
test('capture blocks when the matched site has no weighbridge unit', async () => {
  const f = fixture();
  delete f.data.sites[0].weighbridgeWeightUnit;
  await assert.rejects(f.process(f.event(first)), { code: 'WEIGHT_UNIT_REQUIRED' });
  assert.equal(f.writes.length, 0);
});
test('completed historical baseline is ignored but waiting baseline is captured', async () => {
  const f = fixture();
  assert.equal((await f.process(f.event(second, 'BASELINE'))).status, 'ignored');
  await f.process(f.event(first, 'BASELINE'));
  assert.equal(f.writes.length, 1);
});
test('ambiguous schedule is held without changing a job', async () => {
  const f = fixture([scheduled, { ...scheduled, id: 'other' }]);
  await assert.rejects(f.process(f.event(first)), { code: 'AMBIGUOUS_SCHEDULE' });
  assert.equal(f.writes.length, 0);
});
test('conflicting operator weight and invalid weights are not overwritten', async () => {
  const f = fixture([{ ...scheduled, siteWeighInWeight: 31 }]);
  await assert.rejects(f.process(f.event(first)), { code: 'APP_WEIGHT_CONFLICT' });
  assert.equal(f.writes.length, 0);
  assert.throws(() => capture({ ...second, TARTIM2: 40000 }, config, 'kg'), { code: 'INVALID_SITE_WEIGHT' });
  assert.throws(() => capture({ ...second, SAAT2: '09:00:00' }, config, 'kg'), { code: 'INVALID_CAPTURE_CHRONOLOGY' });
});

test('a registered capture driver cannot overwrite another driver schedule', async () => {
  const f = fixture();
  f.data.drivers.push({ id: 'D002', name: 'Another Driver' });
  await assert.rejects(f.process(f.event({ ...first, DIGER3_ISIM: 'Another Driver' })), { code: 'SCHEDULE_DRIVER_MISMATCH' });
  assert.equal(f.writes.length, 0);
});

test('invalid units cannot modify a scheduled weighing', async () => {
  const f = fixture(); delete f.data.sites[0].weighbridgeWeightUnit;
  await assert.rejects(f.process(f.event(first)), { code: 'WEIGHT_UNIT_REQUIRED' });
  assert.equal(f.writes.length, 0);
});

test('enabled config requires a bridge credential but reads site and unit from app data', () => {
  assert.throws(() => readConfig({ TARTIM_ENABLED: 'true' }), /TARTIM_API_KEY/);
  const enabled = readConfig({ TARTIM_ENABLED: 'true', TARTIM_API_KEY: 'x'.repeat(32) });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.siteId, undefined);
  assert.equal(enabled.weightUnit, undefined);
  assert.equal(enabled.driverField, 'DIGER3_ISIM');
  assert.equal(enabled.poField, 'DIGER5_ISIM');
  assert.equal(readConfig({}).enabled, false);
});


test('plate is primary and PO or trip context resolves multiple active schedules', async () => {
  for (const reference of ['PO0017/V008', 'PO0017/V008/D007/T006/J0001']) {
    const f = fixture([{ ...scheduled, poNumber: 'PO0016/V008' }, { ...scheduled, id: 'target', poNumber: 'PO0017/V008', jobId: 'PO0017/V008/D007/T006/J0001' }]);
    const result = await f.process(f.event({ ...first, DIGER5_ISIM: reference }));
    assert.equal(result.jobId, 'target');
    assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, undefined);
    assert.equal(f.data.deliveryOrders.length, 2);
  }
});

test('conflicting context never changes or creates a job', async () => {
  for (const patch of [{ DIGER5_ISIM: 'wrong-trip' }, { FIRMA_ADI: 'Wrong vendor' }, { MALZEME_ADI: 'Wrong material' }, { DIGER1_ISIM: 'Wrong origin' }, { DIGER2_ISIM: 'Wrong site' }]) {
    const f = fixture([{ ...scheduled, vendorName: 'Vendor', materialName: 'Ballast', quarryLocation: 'Ngomeni', siteName: 'Site' }]);
    await assert.rejects(f.process(f.event({ ...first, ...patch })), { code: 'SCHEDULE_CONTEXT_MISMATCH' });
    assert.equal(f.writes.length, 0);
    assert.equal(f.data.deliveryOrders[0].accessBridgeKey, undefined);
  }
});

test('a vehicle ID cannot override a conflicting scheduled plate or a pre-dispatch job', async () => {
  for (const patch of [{ plateNumber: 'OTHER' }, { status: 'CREATED' }]) {
    const f = fixture([{ ...scheduled, ...patch }]);
    await assert.rejects(f.process(f.event(first)), { code: 'UNMATCHED_SCHEDULE' });
    assert.equal(f.writes.length, 0);
  }
});

test('custom captures require a registered driver and one open order before any writes', async () => {
  for (const reason of ['REGISTERED_DRIVER_REQUIRED', 'PURCHASE_ORDER_REQUIRED', 'PURCHASE_ORDER_CLOSED', 'AMBIGUOUS_PURCHASE_ORDER', 'WEIGHT_UNIT_REQUIRED']) {
    const f = fixture([]);
    const row = { ...first, DIGER3_ISIM: 'Driver', DIGER5_ISIM: 'POMAT001/V001' };
    if (reason === 'REGISTERED_DRIVER_REQUIRED') row.DIGER3_ISIM = '';
    if (reason === 'PURCHASE_ORDER_REQUIRED') row.DIGER5_ISIM = 'UNKNOWN';
    if (reason === 'PURCHASE_ORDER_CLOSED') f.data.purchaseOrders[0].status = 'closed';
    if (reason === 'AMBIGUOUS_PURCHASE_ORDER') f.data.purchaseOrders.push({ ...f.data.purchaseOrders[0], id: 'PO2' });
    if (reason === 'WEIGHT_UNIT_REQUIRED') delete f.data.sites[0].weighbridgeWeightUnit;
    await assert.rejects(f.process(f.event(row)), { code: reason });
    assert.equal(f.writes.length, 0);
  }
});

test('custom capture resolves destination and material without an explicit PO', async () => {
  const f = fixture([]);
  await f.process(f.event({ ...first, DIGER3_ISIM: '12345678', DIGER2_ISIM: 'S001', MALZEME_ADI: 'Sand' }));
  assert.equal(f.data.deliveryOrders[0].purchaseOrderId, 'PO1');
});

test('weigh-out cannot switch a bound job to a different plate or truck', async () => {
  const f = fixture();
  await f.process(f.event(first));
  f.data.deliveryOrders[0].plateNumber = 'OTHER';
  await assert.rejects(f.process(f.event(second)), { code: 'CAPTURE_PLATE_MISMATCH' });
  assert.equal(f.data.deliveryOrders[0].siteWeighOutWeight, undefined);
});

test('warehouse captures require a registered truck too', async () => {
  const f = fixture([{ ...scheduled, isWarehouseDelivery: true }]);
  f.data.vehicles = [];
  await assert.rejects(f.process(f.event(second)), { code: 'UNKNOWN_TRUCK' });
  assert.equal(f.writes.length, 0);
});

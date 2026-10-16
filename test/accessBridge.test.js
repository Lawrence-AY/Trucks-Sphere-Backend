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
    vendors: [], materials: [],
  };
  const writes = [];
  const nextIds = { vendor: 0, driver: 0, truck: 0, purchase_order_v2: 0 };
  const repository = {
    all: async name => structuredClone(data[name] || []),
    async create(name, id, record) {
      data[name] = data[name] || [];
      data[name].push({ ...record, id });
      return { ...record, id };
    },
    async nextId(type) {
      nextIds[type] = (nextIds[type] || 0) + 1;
      const prefix = type === 'vendor' ? 'V' : type === 'driver' ? 'D' : type === 'truck' ? 'T' : 'PO';
      const width = type === 'purchase_order_v2' ? 4 : 3;
      return `${prefix}${String(nextIds[type]).padStart(width, '0')}`;
    },
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

test('historical captures that predate a schedule are recorded as unscheduled, not attached', async () => {
  for (const [createdAt, observed_utc] of [
    ['2026-10-02T07:02:01Z', '2026-10-02T07:03:44Z'],
    ['2026-10-02T07:00:54Z', '2026-10-02T07:00:53Z'],
    ['2026-10-02T07:00:54Z', undefined],
  ]) {
    const f = fixture([{ ...scheduled, createdAt }]);
    const row = { ...first, DIGER3_ISIM: 'New Driver' };
    await f.process({ ...f.event(row), observed_utc });
    assert.equal(f.data.deliveryOrders.length, 2);
    assert.equal(f.data.deliveryOrders[1].isUnscheduled, true);
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

test('a conflicting scheduled plate or pre-dispatch job does not block the unscheduled capture', async () => {
  for (const patch of [{ plateNumber: 'OTHER' }, { status: 'CREATED' }]) {
    const f = fixture([{ ...scheduled, ...patch }]);
    const row = { ...first, DIGER3_ISIM: 'New Driver' };
    await f.process(f.event(row));
    assert.equal(f.data.deliveryOrders.length, 2);
    assert.equal(f.data.deliveryOrders[1].isUnscheduled, true);
  }
});

test('custom captures auto-provision entities and only block on ambiguity or a missing driver', async () => {
  // A missing driver name still blocks without any writes.
  const noDriver = fixture([]);
  await assert.rejects(noDriver.process(noDriver.event({ ...first, DIGER3_ISIM: '' })), { code: 'DRIVER_NAME_REQUIRED' });
  assert.equal(noDriver.writes.length, 0);

  // Multiple matching open POs remain ambiguous and write nothing.
  const ambiguous = fixture([]);
  ambiguous.data.purchaseOrders.push({ ...ambiguous.data.purchaseOrders[0], id: 'PO2' });
  await assert.rejects(ambiguous.process(ambiguous.event({ ...first, DIGER3_ISIM: 'Driver', DIGER5_ISIM: 'POMAT001/V001' })), { code: 'AMBIGUOUS_PURCHASE_ORDER' });
  assert.equal(ambiguous.writes.length, 0);

  // With no registered truck, driver, vendor, material or PO, everything is
  // auto-provisioned and the capture resolves into a custom unscheduled job.
  const auto = fixture([]);
  auto.data.vehicles = []; auto.data.drivers = []; auto.data.sites = []; auto.data.purchaseOrders = [];
  const outcome = await auto.process(auto.event({ ...first, DIGER3_ISIM: 'New Driver', DIGER2_ISIM: 'MANDA BAY', MALZEME_ADI: 'MURRAM', FIRMA_ADI: 'HINDI GEN AGENCY LTD' }));
  assert.equal(outcome.status, 'processed');
  assert.equal(auto.data.deliveryOrders.length, 1);
  assert.equal(auto.data.deliveryOrders[0].isUnscheduled, true);
  assert.ok(auto.data.vehicles.length >= 1);
  assert.ok(auto.data.drivers.length >= 1);
  assert.ok(auto.data.vendors.length >= 1);
  assert.ok(auto.data.materials.length >= 1);
  assert.ok(auto.data.purchaseOrders.length >= 1);
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

test('duplicate driver names resolve to the registered profile instead of stalling', async () => {
  const f = fixture([]);
  f.data.vehicles = []; f.data.drivers = [
    { id: 'D-stub', name: 'Onesmus Kasyoka', registrationIncomplete: true, bridgeCreated: true },
    { id: 'D-reg', name: 'Onesmus Kasyoka', fullName: 'Onesmus Kasyoka', nationalId: '99999999' },
  ];
  f.data.sites = []; f.data.purchaseOrders = []; f.data.materials = []; f.data.vendors = [];
  const row = { ...first, DIGER3_ISIM: 'Onesmus Kasyoka', DIGER2_ISIM: 'MANDA BAY', MALZEME_ADI: 'MURRAM', FIRMA_ADI: 'HINDI GEN AGENCY LTD' };
  await f.process(f.event(row));
  assert.equal(f.data.deliveryOrders.length, 1);
  assert.equal(f.data.deliveryOrders[0].driverId, 'D-reg');
  assert.equal(f.data.deliveryOrders[0].isUnscheduled, true);
});

test('driver names with irregular spacing reuse the same driver record', async () => {
  const f = fixture([]);
  f.data.vehicles = []; f.data.drivers = [{ id: 'D-drv', name: 'ABDALLA ALI', fullName: 'ABDALLA ALI' }];
  f.data.sites = []; f.data.purchaseOrders = []; f.data.materials = []; f.data.vendors = [];
  const row = { ...first, DIGER3_ISIM: 'ABDALLA  ALI', DIGER2_ISIM: 'MANDA BAY', MALZEME_ADI: 'MURRAM', FIRMA_ADI: 'HINDI GEN AGENCY LTD' };
  await f.process(f.event(row));
  assert.equal(f.data.drivers.length, 1);
  assert.equal(f.data.deliveryOrders[0].driverId, 'D-drv');
});

test('completed weigh-out attaches to an already weighed-in job even when the first-weigh time drifted', async () => {
  const f = fixture();
  await f.process(f.event(first)); // weigh-in records siteWeighInWeight + accessBridgeKey
  // Completed record with a drifted first-weigh time -> different identity key,
  // so it cannot match via accessBridgeKey; it must still weigh out.
  const drifted = { ...second, SAAT1: '1899-12-30T10:00:30' };
  await f.process(f.event(drifted));
  assert.equal(f.data.deliveryOrders[0].siteWeighOutWeight, 10);
  assert.equal(f.data.deliveryOrders[0].siteNetWeight, 20);
  assert.equal(f.data.deliveryOrders[0].quantityDelivered, 20);
});

test('weigh-out does not fire for a waiting record with no second weigh', async () => {
  const f = fixture();
  await f.process(f.event(first));
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, 30);
  assert.equal(f.data.deliveryOrders[0].siteWeighOutWeight, undefined);
});

for (const spelling of ['MURRAM', 'MUURRRAAM', 'MUURRAM', 'MURRRAM']) {
  test(`custom trips reuse the Hindi MURRAM PO for ${spelling}`, async () => {
    const f = fixture([]);
    f.data.vendors = [{ id: 'V001', name: 'HINDI GEN AGENCY LIMITED' }];
    f.data.materials = [{ id: 'M001', name: 'MURRAM' }];
    Object.assign(f.data.purchaseOrders[0], { materialId: 'M001', materialName: 'MURRAM', vendorName: 'HINDI GEN AGENCY LIMITED' });
    const row = { ...first, FIRMA_ADI: 'HINDI GEN AGENCY LTD', MALZEME_ADI: spelling,
      DIGER3_ISIM: 'Driver', DIGER2_ISIM: 'Site', DIGER5_ISIM: 'stale-reference' };
    await f.process(f.event(row));
    await f.process(f.event(row));
    await f.process(f.event({ ...row, PLAKA: 'KBB456B', SAAT1: '12:00:00' }));
    assert.equal(f.data.purchaseOrders.length, 1);
    assert.equal(f.data.materials.length, 1);
    assert.equal(f.data.vendors.length, 1);
    assert.equal(f.data.deliveryOrders.length, 2);
    assert.ok(f.data.deliveryOrders.every(job => job.purchaseOrderId === 'PO1'));
  });
}
test('closed matching PO does not generate a replacement PO', async () => {
  const f = fixture([]);
  f.data.purchaseOrders[0].status = 'closed';
  await assert.rejects(f.process(f.event({ ...first, DIGER3_ISIM: 'Driver' })), { code: 'PURCHASE_ORDER_CLOSED' });
  assert.equal(f.data.purchaseOrders.length, 1);
  assert.equal(f.data.deliveryOrders.length, 0);
});

function suppliedCaptureFixture({ vendor = 'WELLSELECT ENTERPRISES LIMITED', material = 'RIVER SAND', driver = 'STEPHEN KAHINDI', registration = 'KDW838F', code = 'SAND', firstWeight = 49000, lastWeight = 18600 } = {}) {
  const f = fixture([]);
  f.data.vehicles = [{ id: 'T001', plateNumber: registration }];
  f.data.drivers = [{ id: 'D001', name: driver }];
  f.data.sites = [{ id: 'S001', name: 'MANDA BAY', weighbridgeWeightUnit: 'kg' }];
  f.data.vendors = [{ id: 'V001', name: vendor }];
  f.data.materials = [{ id: 'M001', name: material, code }];
  f.data.purchaseOrders = [{ id: 'PO1', poNumber: 'PO0001/V001', vendorId: 'V001', vendorName: vendor,
    materialId: 'M001', materialName: material, siteId: 'S001', siteName: 'MANDA BAY', status: 'open', createdAt: '2026-01-01T00:00:00Z' }];
  const row = { PLAKA: registration, FIRMA_ADI: vendor, MALZEME_ADI: material, MALZEME_KODU: code,
    DIGER1_ISIM: 'MALINDI', DIGER2_ISIM: 'MANDA BAY', DIGER3_ISIM: driver, DIGER5_ISIM: '',
    TARTIM1: firstWeight, TARTIM2: lastWeight, NET: Math.abs(firstWeight - lastWeight),
    TARIH1: '2026-10-16T00:00:00', SAAT1: '1899-12-30T08:22:27',
    TARIH2: '2026-10-16T00:00:00', SAAT2: '1899-12-30T08:30:08', KAYIT_NO: 2261 };
  return { f, row };
}
test('WELLSELECT river sand captures reuse the oldest duplicate PO across retries and registry order', async () => {
  for (const reverse of [false, true]) {
    const { f, row } = suppliedCaptureFixture();
    f.data.purchaseOrders.push({ ...f.data.purchaseOrders[0], id: 'PO2', poNumber: 'PO0002/V001', createdAt: '2026-10-01T00:00:00Z' });
    if (reverse) f.data.purchaseOrders.reverse();
    const result = await f.process(f.event(row));
    await f.process(f.event(row));
    assert.equal(result.status, 'processed');
    assert.equal(f.data.deliveryOrders[0].purchaseOrderId, 'PO1');
    assert.equal(f.data.deliveryOrders[0].siteNetWeight, 30.4);
    assert.equal(f.data.purchaseOrders.length, 2);
    assert.equal(f.data.deliveryOrders.length, 1);
  }
});
test('external SAND code resolves the scheduled material rather than comparing code to its ID', async () => {
  const { f, row } = suppliedCaptureFixture();
  f.data.deliveryOrders = [{ ...scheduled, plateNumber: row.PLAKA, purchaseOrderId: 'PO1', vendorId: 'V001',
    vendorName: row.FIRMA_ADI, materialId: 'M001', materialName: row.MALZEME_ADI, driverName: row.DIGER3_ISIM }];
  assert.equal((await f.process(f.event(row))).jobId, 'scheduled');
  assert.equal(f.data.deliveryOrders.length, 1);
});
test('a completed capture conflicting with a single old same-plate schedule becomes a separate trip', async () => {
  const { f, row } = suppliedCaptureFixture();
  f.data.deliveryOrders = [{ ...scheduled, plateNumber: row.PLAKA, vendorName: 'OTHER COMPANY', materialName: 'BALLAST' }];
  await f.process(f.event(row));
  assert.equal(f.data.deliveryOrders.length, 2);
  assert.equal(f.data.deliveryOrders[0].siteWeighInWeight, undefined);
  assert.equal(f.data.deliveryOrders[1].siteNetWeight, 30.4);
});
test('SPADES ATLAS increasing weights preserve raw weighs and record a verified positive 9.9 tonne net', async () => {
  const { f, row } = suppliedCaptureFixture({ vendor: 'SPADES ATLAS COMPANY LIMITED', material: 'CLEAN WATER', driver: 'JULIUS KIARIE', registration: 'KDZ577T', code: '', firstWeight: 6100, lastWeight: 16000 });
  await f.process(f.event(row));
  await f.process(f.event(row));
  const job = f.data.deliveryOrders[0];
  assert.equal(job.siteWeighInWeight, 6.1);
  assert.equal(job.siteWeighOutWeight, 16);
  assert.equal(job.siteNetWeight, 9.9);
  assert.equal(job.accessWeighDirection, 'loading');
  assert.equal(f.data.deliveryOrders.length, 1);
});
test('HINDI vendor abbreviation uses an existing matching schedule', async () => {
  const { f, row } = suppliedCaptureFixture({ vendor: 'HINDI GEN AGENCY LIMITED', material: 'MURRAM', registration: 'KDV539L', code: '', firstWeight: 31350, lastWeight: 12300 });
  f.data.deliveryOrders = [{ ...scheduled, plateNumber: row.PLAKA, vendorId: 'V001', vendorName: row.FIRMA_ADI,
    materialId: 'M001', materialName: 'MURRAM', purchaseOrderId: 'PO1' }];
  row.FIRMA_ADI = 'HINDI GEN AGENCY LTD';
  assert.equal((await f.process(f.event(row))).jobId, 'scheduled');
});
test('reversed source dates fail before any entity or delivery writes and report both timestamps', async () => {
  for (const [firstDate, secondDate] of [['2026-12-06', '2026-06-13'], ['2026-11-07', '2026-07-15']]) {
    const { f, row } = suppliedCaptureFixture({ vendor: 'HINDI WATER' });
    const before = structuredClone(f.data);
    await assert.rejects(f.process(f.event({ ...row, TARIH1: firstDate, TARIH2: secondDate })), error => {
      assert.equal(error.code, 'INVALID_CAPTURE_CHRONOLOGY');
      assert.equal(error.details.firstDate, firstDate);
      assert.equal(error.details.secondDate, secondDate);
      return true;
    });
    assert.deepEqual(f.data, before);
  }
});
test('incorrect source NET rejects before creating entities', async () => {
  const { f, row } = suppliedCaptureFixture();
  const before = structuredClone(f.data);
  await assert.rejects(f.process(f.event({ ...row, NET: 123 })), { code: 'NET_WEIGHT_MISMATCH' });
  assert.deepEqual(f.data, before);
});

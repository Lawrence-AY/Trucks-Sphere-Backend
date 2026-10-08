const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(relative, overrides) {
  const filename = require.resolve(relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, process,
    require: (name) => Object.hasOwn(overrides, name) ? overrides[name] : require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name),
  });
  return module.exports;
}

test('quarry operators share location-only jobs and retain access isolation', async () => {
  const jobs = [
    { id: 'pending', status: 'CREATED', quarryId: '', quarryName: 'Quarry', quarryLocation: 'Ngomeni', createdByUid: 'other-shift' },
    { id: 'legacy', quarryName: 'Ngomeni' },
    { id: 'different', quarryLocation: 'Another quarry', quarryName: 'Ngomeni' },
    { id: 'unassigned', quarryName: 'Quarry' },
  ];
  const controller = load('../src/modules/delivery-orders/controller', {
    './service': { findAll: () => ({ data: jobs }), findById: async (id) => jobs.find(job => job.id === id) },
    '../../utils/snapshotStore': { getAll: () => jobs },
    '../../../config/firebase': { db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ quarryLocation: ' ngomeni ' }) }) }) }) } },
  });
  const user = { uid: 'current-shift', role: 'operator_quarry' };
  let result;
  let status;
  const res = { json: value => { result = value; }, status: value => { status = value; return res; } };
  const next = error => { throw error; };
  await controller.findAll({ user, query: {} }, res, next);
  assert.deepEqual(Array.from(result.data, job => job.id), ['pending', 'legacy']);
  await controller.findById({ user, params: { id: 'pending' } }, res, next);
  assert.equal(result.id, 'pending');
  await controller.findById({ user, params: { id: 'different' } }, res, next);
  assert.equal(status, 404);
});

test('fuel eligibility retires the previous job when either the driver or truck has a newer assignment', () => {
  const { isFuelReady } = require('../src/utils/fuelEligibility');
  const old = { id: 'old', driverId: 'D1', vehicleId: 'T1', plateNumber: 'KAA 123A', status: 'SITE_WEIGHED_OUT', createdAt: '2026-09-01T10:00:00Z' };
  for (const identity of [{ driverId: 'D1' }, { vehicleId: 'T1' }, { plateNumber: 'kaa123a' }]) {
    const next = { id: 'next', ...identity, status: 'DISPATCHED', createdAt: '2026-09-02T10:00:00Z' };
    assert.equal(isFuelReady(old, [old, next]), false);
    assert.equal(isFuelReady(old, [old, { ...next, status: 'CANCELLED' }]), true);
    assert.equal(isFuelReady(old, [old, { ...next, createdAt: '2026-08-01T10:00:00Z' }]), true);
  }
  assert.equal(isFuelReady(old, [old, { id: 'other', driverId: 'D2', vehicleId: 'T2', createdAt: '2026-09-03T10:00:00Z' }]), true);
});

test('site custom-job origin and material source override inherited quarry information in reports', () => {
  const service = load('../src/modules/reports/service', { '../../utils/snapshotStore': {} });
  for (const createdBy of ['operator_site', { role: 'operator_site' }]) {
    const job = { createdBy, materialSource: 'External supplier yard', quarryName: 'Old quarry' };
    assert.equal(service.getReportOrigin(job, 'Assigned quarry'), 'External supplier yard');
    assert.equal(service.getReportMaterialSource(job, 'Assigned quarry'), 'External supplier yard');
  }
  assert.equal(service.getReportMaterialSource({ createdBy: 'operator_quarry' }, 'Assigned quarry'), 'Assigned quarry');
});

test('warehouse material column contains every product and driver worksheet contains business identifiers', async () => {
  const { warehouseReportFields } = require('../src/modules/reports/warehouseReport');
  assert.equal(warehouseReportFields({ isWarehouseDelivery: true, materials: [{ materialName: 'Cement' }, { materialName: 'Steel' }] }).materialName, 'Cement | Steel');
  const records = { drivers: [{ id: 'driver-doc', driverId: 'D007', name: 'Driver', vendorId: 'vendor-doc' }], vendors: [{ id: 'vendor-doc', vendorId: 'V003', companyName: 'Vendor Company' }] };
  const service = load('../src/modules/reports/service', { '../../utils/snapshotStore': { getAll: (name) => records[name] || [] } });
  const rows = service.buildDriverReport();
  assert.equal(rows[0].driverNumber, 'D007');
  assert.equal(rows[0].vendorNumber, 'V003');
  assert.equal(rows[0].vendorName, 'Vendor Company');
  const { buildExcelWorkbook } = require('../src/modules/reports/excelBuilder');
  const data = Object.fromEntries(['masterAudit', 'materialInspections', 'flagged', 'fuel', 'trucks', 'materials', 'vendors', 'purchaseOrders'].map((key) => [key, []]));
  const workbook = new (require('exceljs').Workbook)();
  await workbook.xlsx.load(await buildExcelWorkbook({ ...data, drivers: rows }));
  const sheet = workbook.worksheets.find((item) => item.name.startsWith('Drivers'));
  assert.deepEqual(sheet.getRow(1).values.slice(1, 5), ['No.', 'Driver Number', 'Vendor Number', 'Vendor Name']);
  assert.deepEqual(sheet.getRow(2).values.slice(1, 5), [1, 'D007', 'V003', 'Vendor Company']);
});

test('delivery board includes more than 50 trips and explicit pagination keeps accurate totals', async () => {
  const jobs = Array.from({ length: 75 }, (_, index) => ({ id: String(index), isWarehouseDelivery: index === 74 }));
  const controller = load('../src/modules/delivery-orders/controller', {
    './service': { findAll: ({ limit }) => ({ data: jobs.slice(0, limit) }) },
    '../../utils/snapshotStore': { getAll: () => jobs },
    '../../../config/firebase': { db: {} },
  });
  let result;
  const res = { json: (data) => { result = data; } };
  const request = { user: { role: 'superadmin' }, query: {} };
  await controller.findAll(request, res, (error) => { throw error; });
  assert.equal(result.data.length, 75);
  assert.equal(result.data[74].isWarehouseDelivery, true);
  await controller.findAll({ ...request, query: { page: '2', limit: '50' } }, res, (error) => { throw error; });
  assert.equal(result.data.length, 25);
  assert.equal(result.total, 75);
  assert.equal(result.totalPages, 2);
});

test('fuel queue excludes all warehouse markers before pagination', () => {
  const deliveries = [
    { id: 'warehouse-flag', status: 'COMPLETED', isWarehouseDelivery: true },
    { id: 'warehouse-origin', status: 'COMPLETED', deliveryOrigin: 'warehouse' },
    { id: 'warehouse-source', status: 'SITE_WEIGHED_OUT', materialSource: ' Warehouse ' },
    { id: 'quarry', status: 'SITE_WEIGHED_OUT' },
    { id: 'unfinished', status: 'DISPATCHED' },
  ];
  const service = load('../src/modules/delivery-orders/service', {
    '../../../config/firebase': { db: { collection: () => ({}) } },
    '../../utils/snapshotStore': { getAll: (name) => name === 'deliveryOrders' ? deliveries : [], getById: () => null },
    '../../utils/counterService': {}, '../../utils/jobIdService': {}, '../../utils/trackingUtils': {},
  });
  const result = service.findAll({ fuelReady: true, limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.data[0].id, 'quarry');
});

test('committed flag clearance immediately updates snapshots, hashes and subscribers', () => {
  const store = load('../src/utils/snapshotStore', {
    '../../config/firebase': { db: {} },
    './cacheService': { generateHash: JSON.stringify, persistSnapshot: async () => {} },
  });
  store.applyCommittedUpdate('deliveryOrders', 'job', { isFlagged: true, driverId: 'driver' });
  const oldHash = store.getHash('deliveryOrders');
  let change;
  store.subscribe('deliveryOrders', (event) => { change = event; });
  store.applyCommittedUpdate('deliveryOrders', 'job', { isFlagged: false, securityFlag: { status: 'cleared' } });
  assert.equal(store.getById('deliveryOrders', 'job').isFlagged, false);
  assert.equal(store.getById('deliveryOrders', 'job').driverId, 'driver');
  assert.notEqual(store.getHash('deliveryOrders'), oldHash);
  assert.equal(change.record.securityFlag.status, 'cleared');
});

test('warehouse denial notifies the owning vendor and management with the reason', async () => {
  const notifications = [];
  const users = [
    { id: 'owner', vendorId: 'V1', role: 'vendor' },
    { id: 'other', vendorId: 'V2', role: 'vendor' },
    { id: 'admin', role: 'admin' },
    { id: 'lite', role: 'management_lite' },
  ];
  const controller = load('../src/modules/tracking/controller', {
    './service': {}, '../../utils/trackingUtils': {},
    '../../../config/firebase': { db: { collection: (name) => name === 'users'
      ? { get: async () => ({ docs: users.map((user) => ({ id: user.id, data: () => user })) }) }
      : { add: async (record) => notifications.push(record) } } },
    '../sms/service': { isSmsConfigured: () => false },
  });
  await controller.notifyWarehouseDenial({ id: 'job', vendorId: 'V1', warehouseDenialReason: 'Wrong products' });
  assert.deepEqual(notifications.map((item) => item.userId).sort(), ['admin', 'lite', 'owner']);
  for (const notification of notifications) {
    assert.equal(notification.type, 'warehouse_delivery_denied');
    assert.match(notification.message, /Wrong products/);
  }
});

test('quarry PO filtering excludes warehouse flags and legacy material references before pagination', () => {
  const records = { materials: [{ id: 'warehouse-doc', materialId: 'MATW', isWarehouseMaterial: true }], purchaseOrders: [
    { id: 'flag', isWarehouseMaterial: true }, { id: 'legacy', materialId: 'MATW' },
    { id: 'lines', materials: [{ materialId: 'MATW' }] }, { id: 'aggregate', materialId: 'MATA' },
  ] };
  const service = load('../src/modules/purchase-orders/service', {
    '../../../config/firebase': { db: { collection: () => ({}) } },
    '../../utils/counterService': {},
    '../../utils/snapshotStore': { getAll: (name) => records[name] || [], getById: (name, id) => records[name]?.find((item) => item.id === id) },
  });
  const result = service.findAll({ excludeWarehouse: true, limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.data[0].id, 'aggregate');
  assert.equal(service.findById('legacy').isWarehouseMaterial, true);
});

test('site flags recognize legacy status and notify only for a new flag or changed reason', () => {
  const { newSiteFlag } = require('../src/modules/tracking/siteFlags');
  const job = { siteArrivalWeightVarianceStatus: 'flagged', siteArrivalWeightVariance: -7, siteFlaggedBy: 'Site receiver' };
  assert.equal(newSiteFlag(job).source, 'operator_site');
  assert.match(newSiteFlag(job).reason, /-7.0T/);
  assert.equal(newSiteFlag(job, job), null);
  assert.ok(newSiteFlag({ ...job, siteFlagReason: 'Rechecked missing load' }, job));
});

test('site flags never send SMS even when an in-app notification fails; warehouse SMS still works', async () => {
  const sent = [];
  const users = [{ id: 'admin', role: 'admin', phone: '0700000001' }, { id: 'super', role: 'superadmin', phoneNumber: '0700000002' }, { id: 'lite', role: 'management_lite', phone: '0700000003' }, { id: 'vendor', role: 'vendor', vendorId: 'V1', phone: '0700000004' }, { id: 'other', role: 'vendor', vendorId: 'V2', phone: '0700000005' }];
  const controller = load('../src/modules/tracking/controller', {
    './service': {}, '../../utils/trackingUtils': {},
    '../../../config/firebase': { db: { collection: (name) => name === 'users' ? { get: async () => ({ docs: users.map((user) => ({ id: user.id, data: () => user })) }) } : name === 'vendors' ? { doc: () => ({ get: async () => ({ exists: false }) }) } : { add: async () => { throw Error('Notification unavailable'); } } } },
    '../sms/service': { isSmsConfigured: () => true, sendSMS: async (phone, message) => { sent.push({ phone, message }); return { success: true }; } },
  });
  await controller.notifySiteFlag({ id: 'job', vendorId: 'V1' }, { source: 'operator_site', reason: 'Missing load', flaggedBy: 'Receiver' });
  assert.equal(sent.length, 0);
  await controller.notifyWarehouseDenial({ id: 'job', vendorId: 'V1', warehouseDenialReason: 'Missing load' });
  assert.deepEqual(sent.map((item) => item.phone).sort(), ['0700000001', '0700000002', '0700000003', '0700000004']);
  assert.ok(sent.every((item) => /Missing load/.test(item.message)));
});

test('security personnel creation stores identity and location with a five-character code and no password', async () => {
  let saved, response;
  const controller = load('../src/modules/tracking/controller', {
    './service': {}, '../../utils/trackingUtils': {}, '../sms/service': {},
    '../../../config/firebase': { db: { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ empty: true }) }) }), doc: (id) => ({ id, create: async (record) => { saved = record; } }) }) } },
  });
  const res = { status() { return this; }, json(value) { response = value; } };
  await controller.createSecurityPersonnel({ body: { name: ' Test Guard ', location: ' Gate 1 ', password: 'ignored' }, user: { uid: 'manager' } }, res, (error) => { throw error; });
  assert.equal(saved.name, 'Test Guard');
  assert.equal(saved.location, 'Gate 1');
  assert.match(saved.securityCode, /^[A-Z0-9]{5}$/);
  assert.equal(saved.password, undefined);
  assert.equal(response.securityCode, saved.securityCode);
});

test('security personnel routes allow editors and superadmins, and deny other roles', () => {
  const routes = [];
  load('../src/modules/tracking/routes', {
    express: { Router: () => ({ get: (route, ...handlers) => routes.push({ route, handlers }), post: (route, ...handlers) => routes.push({ route, handlers }) }) },
    './controller': {}, '../../middleware/authMiddleware': { verifyToken() {} },
  });
  for (const route of routes.filter((entry) => entry.route === '/security-personnel')) {
    for (const role of ['admin', 'management_edit', 'superadmin', 'adminlite', 'vendor', 'operator_site']) {
      let allowed = false;
      route.handlers[1]({ user: { role } }, { status() { return this; }, json() {} }, () => { allowed = true; });
      assert.equal(allowed, ['admin', 'management_edit', 'superadmin'].includes(role));
    }
  }
});

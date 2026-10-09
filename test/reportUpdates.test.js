const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function reports(deliveries, collections = {}) {
  const filename = require.resolve('../src/modules/reports/service');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: name => name === '../../utils/snapshotStore' ? { getAll: collection => collection === 'deliveryOrders' ? deliveries : collections[collection] || [] } : require(path.resolve(path.dirname(filename), name)) });
  return module.exports;
}

test('material report combines exact material selection with the date range and resets to all materials', () => {
  const delivery = (materialId, date, quantity) => ({
    materialId, createdAt: date,
    materialInspection: { materialReceipts: [{ materialId, receivedQuantity: quantity }] },
  });
  const service = reports([
    delivery('m', '2026-10-09T10:00:00Z', 12),
    delivery('m', '2026-09-01T10:00:00Z', 30),
    delivery('s', '2026-10-09T10:00:00Z', 8),
  ], { materials: [{ id: 'm', name: 'Murram' }, { id: 's', name: 'Sand' }] });
  const rows = service.buildMaterialReport({ material: ' MURRAM ', filter: 'custom', startDate: '2026-10-01', endDate: '2026-10-10' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].materialName, 'Murram');
  assert.equal(rows[0].totalDelivered, 12);
  assert.equal(service.buildMaterialReport({ material: 'mur' }).length, 0);
  assert.equal(service.buildMaterialReport({ material: '' }).length, 2);
  assert.equal(service.buildMaterialReport()[0].totalDelivered, 42);
});

test('materials CSV forwards material and date filters to the report service', async () => {
  const filename = require.resolve('../src/modules/reports/controller');
  const module = { exports: {} };
  let options;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: name => name === './service'
      ? { buildMaterialReport: value => { options = value; return [{ materialName: 'Murram' }]; } }
      : name === './csvBuilder' ? { buildCSV: () => 'Material\r\nMurram' } : {},
  });
  let body;
  await module.exports.exportCategoryCSV(
    { params: { category: 'materials' }, query: { material: 'murram', filter: 'month' } },
    { setHeader() {}, send(value) { body = value; } },
    error => { throw error; },
  );
  assert.equal(options.material, 'murram');
  assert.equal(options.filter, 'month');
  assert.ok(body);
});
test('summary counts canonical statuses and excludes warehouse units from tonnage', () => {
  const result = reports([
    { id:'a', status:'DISPATCHED', netWeight:20 },
    { id:'b', status:'SITE_WEIGHED_OUT', netWeight:15 },
    { id:'c', status:'COMPLETED', isWarehouseDelivery:true, quantityDelivered:500, materialInspection:{mrfNumber:'M1'} },
    { id:'d', status:'ARRIVED_AT_SITE', isWarehouseDelivery:true, warehouseAcceptedAt:'today' },
  ]).buildSummary().deliveries;
  assert.equal(result.total,4); assert.equal(result.completed,2); assert.equal(result.inTransit,1); assert.equal(result.totalTonnage,35);
});
test('master audit includes warehouse driver, truck, tracking and denial details without fabricated weights', () => {
  const [row] = reports([{id:'wh',jobId:'WH1',isWarehouseDelivery:true,driverName:'Shipment Driver',plateNumber:'KAA 123B',trackingId:'SA-1234567',dispatchedToSiteAt:'2026-09-27T08:00:00Z',warehouseDeniedAt:'2026-09-27T09:00:00Z',warehouseDenialReason:'Wrong goods',materials:[{materialName:'Paint',quantity:5,unit:'Litres'}]}]).buildMasterAudit();
  assert.equal(row.driverName,'Shipment Driver');assert.equal(row.plateNumber,'KAA 123B');assert.equal(row.trackingId,undefined);
  assert.equal(row.warehouseReceiptStatus,'Denied');assert.equal(row.warehouseDenialReason,'Wrong goods');assert.equal(row.poQuantity,'');assert.equal(row.siteNet,'');assert.match(row.dispatchedAt,/2026/);
});
test('master audit distinguishes listener captures from app entries and exports the source', async () => {
  const rows = reports([
    { id: 'listener', accessBridgeSource: 'TruckSphere-Listener' },
    { id: 'app' },
  ]).buildMasterAudit();
  assert.deepEqual(rows.map(row => row.captureMethod), ['TruckSphere Listener', 'TruckSphere App']);
  const emptyReports = Object.fromEntries(['drivers','materials','fuel','trucks','vendors','purchaseOrders','materialInspections','storeActivity','flagged'].map(key => [key, []]));
  const workbook = new (require('exceljs').Workbook)();
  await workbook.xlsx.load(await require('../src/modules/reports/excelBuilder').buildExcelWorkbook({ ...emptyReports, masterAudit: rows }));
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values;
  const capturedByColumn = headers.indexOf('Captured By');
  assert.ok(capturedByColumn > 0);
  assert.equal(sheet.getRow(2).getCell(capturedByColumn).value, 'TruckSphere Listener');
  assert.equal(sheet.getRow(3).getCell(capturedByColumn).value, 'TruckSphere App');
  assert.match(require('../src/modules/reports/csvBuilder').buildCSV([{ captureMethod: 'TruckSphere Listener' }]), /^No\.,Captured By\r\n1,TruckSphere Listener$/);
});
test('quarry net is not reduced twice and partial site weights do not become a delivered net', () => {
  const [row] = reports([{id:'q',weighInWeight:10,netWeight:20,siteWeighInWeight:30}]).buildMasterAudit();
  assert.equal(row.quarryNet,20);assert.equal(row.siteNet,'');assert.equal(row.quantityDelivered,0);
});
test('Excel sheets and CSV exports have sequential numbers and include warehouse receipt columns', async () => {
  const rows=reports([{id:'wh',jobId:'WH1',isWarehouseDelivery:true,driverName:'Driver',plateNumber:'KAA',warehouseAcceptedAt:'2026-09-27T09:00:00Z'}]).buildMasterAudit();
  const data=Object.fromEntries(['drivers','materials','fuel','trucks','vendors','purchaseOrders','materialInspections','storeActivity','flagged'].map(key=>[key,[]]));
  const workbook=new(require('exceljs').Workbook)();
  await workbook.xlsx.load(await require('../src/modules/reports/excelBuilder').buildExcelWorkbook({...data,masterAudit:rows}));
  const sheet=workbook.worksheets[0];const headers=sheet.getRow(1).values;
  assert.equal(headers[1],'No.');assert.equal(sheet.getRow(2).getCell(1).value,1);
  assert.ok(headers.includes('Warehouse Receipt Status'));assert.ok(headers.includes('Accepted at Site (EAT)'));assert.ok(!headers.includes('Tracking ID'));assert.ok(headers.includes('Tracking Activity'));assert.ok(headers.includes('MRF Number'));
  assert.match(require('../src/modules/reports/csvBuilder').buildCSV([{name:'A'},{name:'B'}]),/^No\.,name\r\n1,A\r\n2,B$/);
});

test('master audit includes security activity, entered warehouse source and MRF, and resolved inspector', () => {
 const [row] = reports([{ id: 'wh', isWarehouseDelivery: true, materials: [{ materialName: 'Shoes', quantity: 4, unit: 'Pairs', source: 'BATA', mrfNo: 'MRF56' }], materialInspection: { mrfNumber: 'MIF1', inspectorUid: 'u1' } }], {
  users: [{ id: 'u1', displayName: 'Store Officer' }],
  trackingReportSessions: [{ orderId: 'wh', personnelName: 'Gate Officer', securityLocation: 'Gate', status: 'verified', decidedAt: '2026-09-28T08:00:00Z', driverPhotoURL: 'photo.jpg' }],
 }).buildMasterAudit();
 assert.equal(row.materialSource, 'BATA'); assert.equal(row.warehouseMrf, 'MRF56');
 assert.equal(row.mrfNumber, 'MIF1'); assert.equal(row.inspectorName, 'Store Officer');
 assert.match(row.trackingActivity, /Gate Officer.*Gate.*verified/);
 assert.equal(row.trackingPhotos, 'photo.jpg');
 assert.match(row.warehouseItems, /BATA.*MRF56/);
 assert.equal(row.trackingId, undefined);
});

test('warehouse reports preserve multiple MRF sources and numbers and recover linked shipment fields', () => {
 const [row] = reports([{ id: 'delivery', warehouseJobId: 'shipment', isWarehouseDelivery: true, materials: [{ materialName: 'Shoes' }, { materialName: 'Gloves' }] }], {
  warehouseJobs: [{ id: 'shipment', items: [{ materialName: 'Shoes', source: 'BATA', mrfNo: 'MRF56' }, { materialName: 'Gloves', source: 'ACME', mrfNo: 'MRF57' }] }],
 }).buildMasterAudit();
 assert.equal(row.mrfSource, 'BATA | ACME');
 assert.equal(row.warehouseMrf, 'MRF56 | MRF57');
 assert.match(row.warehouseItems, /Shoes.*MRF Source: BATA.*MRF: MRF56/);
 assert.match(row.warehouseItems, /Gloves.*MRF Source: ACME.*MRF: MRF57/);
});

test('PO, vendor and master reports expose approved excess while ignoring pending and failed receipts', () => {
  const po = { id: 'po1', poNumber: 'PO1/V1', vendorId: 'V1', status: 'completed', materials: [{ materialId: 'bolts', materialName: 'Bolts', quantity: 10, unit: 'Pieces' }] };
  const approved = { id: 'one', jobId: 'JOB1', vendorId: 'V1', purchaseOrderId: 'po1', status: 'ARRIVED_AT_SITE', receivingStatus: 'inventory_added', storeQualityInspection: { result: 'Pass' }, materialInspection: { materialReceipts: [{ materialId: 'bolts', receivedQuantity: 12, unit: 'Pieces', initialVisualInspection: 'Pass' }] } };
  const report = reports([approved, { ...approved, id: 'two', receivingStatus: 'inspection_rejected' }, { ...approved, id: 'three', receivingStatus: 'received_pending_inspection' }], { purchaseOrders: [po], vendors: [{ id: 'V1', companyName: 'Vendor' }] });
  const row = report.buildPOReport({ fulfilledOnly: true })[0];
  assert.equal(row.deliveredQuantity, 12);
  assert.equal(row.excessQuantity, 2);
  assert.equal(row.excessFlag, true);
  assert.equal(report.buildVendorReport()[0].fulfilledPOs, 1);
  assert.equal(report.buildVendorReport()[0].excessQuantity, '2 pieces');
  assert.equal(report.buildMasterAudit()[0].poExcessQuantity, '2 pieces');
});

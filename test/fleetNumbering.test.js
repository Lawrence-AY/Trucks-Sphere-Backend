const test = require('node:test');
const assert = require('node:assert/strict');
const { planNumbering } = require('../scripts/lib/repairFleetNumbering');
function fixture() {
  return { vendors: [{ id: 'V001', name: 'Vendor One' }], counters: [{ id:'auto_ids', driver_counter: 60, truck_counter: 80 }],
    drivers: [{ id:'D100', vendorId:'V001' }, { id:'AB-driver',name:'Driver One' }],
    vehicles: [{ id:'T090',vendorId:'V001' }, { id:'AB-plate',plateNumber:'KAA123A' }],
    purchaseOrders: [{ id:'PO0001-V001',vendorId:'V001' }],
    deliveryOrders: [{ id:'old-doc', jobId:'PO0001/V001/AB-driver/AB/J0012', jobKey:'PO0001/V001/AB-driver/AB-plate',
      driverId:'AB-driver',vehicleId:'AB-plate',purchaseOrderId:'PO0001-V001',receiptNoteId:'PO0001/V001/AB-driver/AB/J0012/RN001' }],
    stocks: [{ id:'stock',deliveryOrderId:'old-doc', nested:{driverId:'AB-driver'}, references:['AB-plate'] }],
    'accessBridgeSources/source/events': [{id:'event',jobId:'old-doc'}] };
}
function apply(state, plan) {
  const result = structuredClone(state);
  for (const row of plan.changes) {
    result[row.collection] ||= [];
    result[row.collection] = result[row.collection].filter(doc => doc.id !== row.from);
    result[row.collection].push(row.after);
  }
  return result;
}
test('renumbering preserves all linked trip, receipt, stock and bridge event references and is idempotent', () => {
  const state=fixture(), plan=planNumbering(state), result=apply(state,plan);
  assert.equal(plan.mappings['AB-driver'],'D101');
  assert.equal(plan.mappings['AB-plate'],'T091');
  assert.equal(result.drivers.find(row=>row.id==='D101').vendorId,'V001');
  assert.equal(result.vehicles.find(row=>row.id==='T091').vendorId,'V001');
  assert.equal(result.deliveryOrders[0].jobId,'PO0001/V001/D101/T091/J0012');
  assert.equal(result.deliveryOrders[0].receiptNoteId,'PO0001/V001/D101/T091/J0012/RN001');
  assert.equal(result.stocks[0].deliveryOrderId,result.deliveryOrders[0].id);
  assert.equal(result.stocks[0].nested.driverId,'D101');
  assert.deepEqual(result.stocks[0].references,['T091']);
  assert.equal(result['accessBridgeSources/source/events'][0].jobId,result.deliveryOrders[0].id);
  assert.equal(planNumbering(result).changes.length,0);
  assert.equal(state.drivers[1].id,'AB-driver');
});
test('source snapshots establish ownership; missing evidence stays unassigned', () => {
  const state=fixture(); state.deliveryOrders=[];
  let plan=planNumbering(state);
  assert.ok(plan.issues.some(row=>row.reason==='NO_VENDOR_EVIDENCE'));
  state['accessBridgeSources/source/snapshots']=[{id:'s',payload:JSON.stringify({FIRMA_ADI:'Vendor One',PLAKA:'KAA123A',DIGER3_ISIM:'Driver One'})}];
  const result=apply(state,planNumbering(state));
  assert.equal(result.drivers.find(row=>row.id==='D101').vendorId,'V001');
  assert.equal(result.vehicles.find(row=>row.id==='T091').vendorId,'V001');
});
test('shared trucks retain all vendors and ambiguous driver ownership is reported', () => {
  const state=fixture(); state.vendors.push({id:'V002'});
  state.deliveryOrders.push({...state.deliveryOrders[0],id:'other',jobId:'PO0002/V002/AB-driver/AB/J0013',purchaseOrderId:null,vendorId:'V002'});
  const plan=planNumbering(state),result=apply(state,plan);
  assert.deepEqual(result.vehicles.find(row=>row.id==='T091').vendorIds,['V001','V002']);
  assert.equal(result.drivers.find(row=>row.id==='D101').vendorId,undefined);
  assert.ok(plan.issues.some(row=>row.reason==='MULTIPLE_VENDORS'));
});
test('unknown vendor and colliding trip targets fail before mutation', () => {
  const state=fixture(); state.drivers[0].vendorId='V999';
  assert.throws(()=>planNumbering(state),/Unknown vendor/);
  const other=fixture();other.deliveryOrders.push({...other.deliveryOrders[0],id:'second'});
  assert.throws(()=>planNumbering(other),/Duplicate target/);
});

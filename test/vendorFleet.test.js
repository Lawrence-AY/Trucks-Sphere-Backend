const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFleetIndex, withVehicleVendors, vehicleBelongsToVendor, fleetStats } = require('../src/utils/vendorFleet');
const { planFleet, applyFleet } = require('../scripts/repair-vendor-fleet');
const state = { vehicles: [{id:'T1', plateNumber:'KAA 001'}, {id:'T2'}, {id:'T3'}], vendors:[{id:'V001'},{id:'V002'}], purchaseOrders:[{id:'PO1',vendorId:'V001'},{id:'PO2',vendorId:'V002'}], deliveryOrders:[{vehicleId:'T1',purchaseOrderId:'PO1',vendorId:'wrong'}, {vehicleId:'T1',purchaseOrderId:'PO2'}, {vehicleId:'T2',vendorId:'V001'}] };
test('shared truck is visible to each associated vendor, never an unrelated vendor', () => {
 const index = buildFleetIndex(state.vehicles,state.deliveryOrders,state.purchaseOrders);
 const truck = withVehicleVendors(state.vehicles[0], index);
 assert.deepEqual(truck.vendorIds, ['V001','V002']);
 assert.equal(truck.vendorId, undefined);
 assert.equal(vehicleBelongsToVendor(truck,'V1'),true);
 assert.equal(vehicleBelongsToVendor(truck,'V002'),true);
 assert.equal(vehicleBelongsToVendor(truck,'V003'),false);
 assert.equal(vehicleBelongsToVendor(truck,''),false);
 assert.equal(withVehicleVendors(state.vehicles[1],index).vendorId,'V001');
 assert.deepEqual(fleetStats(state.vehicles,state.deliveryOrders,state.purchaseOrders,index).get('V001'),{fleetSize:2,truckCount:2,tripCount:2});
});
test('repair preserves trip assignments, unassigned trucks and shared ownership; is idempotent', () => {
 const original = structuredClone(state);
 const plan = planFleet(state);
 assert.deepEqual(plan.unassigned,['T3']);
 assert.equal(plan.changes.find(c=>c.id==='T1').patch.vendorId,undefined);
 const updated = structuredClone(state);
 for (const change of plan.changes) Object.assign(updated[change.collection].find(row=>row.id===change.id),change.patch);
 assert.equal(planFleet(updated).changes.length,0);
 assert.deepEqual(state,original);
 assert.deepEqual(updated.deliveryOrders,original.deliveryOrders);
});
test('plate fallback requires a unique registration', () => {
 const trips = [{plateNumber:'KAA001', vendorId:'V001'}];
 assert.deepEqual([...buildFleetIndex(state.vehicles,trips).get('T1')],['V001']);
 assert.equal(buildFleetIndex([...state.vehicles,{id:'T4',plateNumber:'KAA001'}],trips).get('T1').size,0);
});
test('backup failure prevents all database writes', async () => {
 let writes=0;
 const db={collection:name=>name,runTransaction:fn=>fn({get:async name=>({docs:state[name].map(row=>({id:row.id,data:()=>row}))}),update:()=>writes++})};
 await assert.rejects(applyFleet(db,async()=>{throw Error('backup failed');}),/backup failed/);
 assert.equal(writes,0);
});

function loadModule(file, deps) {
 const fs = require('node:fs'); const vm = require('node:vm');
 const module = {exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve(file),'utf8'),{module,exports:module.exports,console,require:name=>deps(name)});
 return module.exports;
}
function services() {
 const fleet = require('../src/utils/vendorFleet');
 const deps = name => {
  if(name.includes('vendorFleet')) return fleet;
  if(name.includes('snapshotStore')) return {getAll:name=>state[name]||[],getById:(name,id)=>(state[name]||[]).find(row=>row.id===id)};
  if(name.includes('firebase')) return {db:{collection:()=>({})}};
  if(name==='node:crypto') return require(name);
  return {};
 };
 return {vehicles:loadModule('../src/modules/vehicles/service',deps),vendors:loadModule('../src/modules/vendors/service',deps),deps};
}
test('vehicle and vendor APIs return shared fleet membership and matching counts',()=>{
 const {vehicles,vendors}=services();
 assert.equal(vehicles.findAll({vendorId:'V001'}).total,2);
 assert.equal(vehicles.findAll({vendorId:'V002'}).total,1);
 assert.equal(vehicles.findAll({vendorId:'V003'}).total,0);
 assert.equal(vehicles.findById('T1').vendorIds.length,2);
 assert.equal(vendors.findFleet('V002').total,1);
 assert.equal(vendors.findById('V001').fleetSize,2);
 assert.equal(vendors.findById('V001').tripCount,2);
});
test('vendor vehicle endpoints reject cross-vendor access and query scope overrides',async()=>{
 const {vehicles,deps}=services();
 const controller=loadModule('../src/modules/vehicles/controller',name=>name==='./service'?vehicles:deps(name));
 let body;let status=200;
 const response={json:value=>{body=value;},status:code=>{status=code;return response;}};
 const next=error=>{throw error;};
 await controller.findAll({user:{role:'vendor',entityId:'V002'},query:{vendorId:'V001'}},response,next);
 assert.equal(body.total,1);
 await controller.findById({user:{role:'vendor',entityId:'V003'},params:{id:'T1'}},response,next);
 assert.equal(status,404);
 status=200;
 await controller.findById({user:{role:'vendor',entityId:'V002'},params:{id:'T1'}},response,next);
 assert.equal(status,200);assert.equal(body.id,'T1');
});
test('vendor fleet endpoint rejects another vendor and an account missing vendor scope',async()=>{
 const {vendors,deps}=services();
 const controller=loadModule('../src/modules/vendors/controller',name=>name==='./service'?vendors:deps(name));
 let body;let status=200;
 const response={json:value=>{body=value;},status:code=>{status=code;return response;}};
 const next=error=>{throw error;};
 await controller.findFleet({user:{role:'vendor',entityId:'V002'},params:{id:'V001'}},response,next);
 assert.equal(status,404);
 status=200;
 await controller.findFleet({user:{role:'vendor'},params:{id:'V001'}},response,next);
 assert.equal(status,404);
 status=200;
 await controller.findFleet({user:{role:'vendor',entityId:'V002'},params:{id:'V002'}},response,next);
 assert.equal(status,200);assert.equal(body.total,1);
});

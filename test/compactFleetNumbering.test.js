const test=require('node:test');
const assert=require('node:assert/strict');
const {planCompactFleet}=require('../scripts/lib/compactFleetNumbering');
function fixture(){
 return {drivers:[{id:'D001',name:'First',vendorId:'V001'},{id:'D003',name:'Second',vendorId:'V002'},{id:'D004',name:'Third',vendorId:'V001'}],
 vehicles:[{id:'T001',plateNumber:'KAA123A'},{id:'T004',plateNumber:'KBB456B',vendorIds:['V001','V002']},{id:'T006',plateNumber:'KCC789C'}],
 deliveryOrders:[{id:'issued-doc',driverId:'D004',vehicleId:'T006',jobId:'PO0001/V001/D004/T006/J0012',jobKey:'PO0001/V001/D004/T006',
 receiptNoteId:'PO0001/V001/D004/T006/J0012/RN001',siteWeighInAt:'2026-07-11T05:33:56Z',siteNetWeight:21.65,quantityDelivered:21.65}],
 driverNationalIds:[{id:'national',driverId:'D003'}],vehicleRegistrations:[{id:'KBB456B',vehicleId:'T004'}],
 users:[{id:'user',entityId:'D003'}],stocks:[{id:'stock',deliveryOrderId:'issued-doc',jobId:'PO0001/V001/D004/T006/J0012',remainingQuantity:15}],
 counters:[{id:'auto_ids',driver_counter:90,truck_counter:100,vehicle_counter:91,receipt_note_counter:99}],
 numberingMigrations:[{id:'history',drivers:[{from:'D003',to:'D004'}]}],
 'accessBridgeSources/source/events':[{id:'event',driverId:'D004',jobId:'issued-doc',payload:'{"driverId":"D004"}'}]};
}
function apply(state,plan){
 const final=structuredClone(state);
 // Model one atomic commit: all destination data is prepared from original rows.
 for(const change of plan.changes){
  final[change.collection] ||= [];
  final[change.collection]=final[change.collection].filter(row=>row.id!==change.id);
  if(change.after)final[change.collection].push(change.after);
 }
 return final;
}
test('overlapping old and new IDs compact without losing entities, ownership or delivery links',()=>{
 const state=fixture(),plan=planCompactFleet(state),final=apply(state,plan);
 assert.deepEqual(final.drivers.map(d=>d.id).sort(),['D001','D002','D003']);
 assert.equal(final.drivers.find(d=>d.id==='D002').name,'Second');
 assert.equal(final.drivers.find(d=>d.id==='D003').name,'Third');
 assert.equal(final.drivers.find(d=>d.id==='D002').vendorId,'V002');
 assert.equal(final.vehicles.find(v=>v.id==='T002').plateNumber,'KBB456B');
 assert.deepEqual(final.vehicles.find(v=>v.id==='T002').vendorIds,['V001','V002']);
 const trip=final.deliveryOrders[0];
 assert.equal(trip.driverId,'D003');assert.equal(trip.vehicleId,'T003');
 assert.equal(trip.jobKey,'PO0001/V001/D003/T003');
 for(const key of ['id','jobId','receiptNoteId','siteWeighInAt','siteNetWeight','quantityDelivered'])assert.equal(trip[key],state.deliveryOrders[0][key]);
 assert.equal(final.driverNationalIds[0].driverId,'D002');
 assert.equal(final.vehicleRegistrations[0].vehicleId,'T002');
 assert.equal(final.users[0].entityId,'D002');
 assert.deepEqual(final.stocks,state.stocks);
 assert.deepEqual(final.numberingMigrations,state.numberingMigrations);
 assert.equal(final['accessBridgeSources/source/events'][0].driverId,'D003');
 assert.equal(final['accessBridgeSources/source/events'][0].payload,state['accessBridgeSources/source/events'][0].payload);
 assert.equal(planCompactFleet(final).changes.length,0);
 assert.equal(state.drivers[1].id,'D003');
});
test('counters are compacted to exact maxima without resetting unrelated counters',()=>{
 const final=apply(fixture(),planCompactFleet(fixture()));
 assert.deepEqual(final.counters[0],{id:'auto_ids',driver_counter:3,truck_counter:3,vehicle_counter:3,receipt_note_counter:99});
});
test('numeric ordering works above 999 and repeated planning is deterministic',()=>{
 const state=fixture();state.drivers=[{id:'D1000'},{id:'D999'}];state.deliveryOrders=[];
 const plan=planCompactFleet(state);
 assert.deepEqual(plan.mappings.drivers,[{from:'D999',to:'D001'},{from:'D1000',to:'D002'}]);
 assert.deepEqual(plan,planCompactFleet(state));
});
test('unknown delivery references and noncanonical entity IDs stop the plan',()=>{
 const state=fixture();state.deliveryOrders[0].driverId='D099';
 assert.throws(()=>planCompactFleet(state),/Unknown driver/);
 const other=fixture();other.drivers[0].id='AB-driver';
 assert.throws(()=>planCompactFleet(other),/Noncanonical/);
});

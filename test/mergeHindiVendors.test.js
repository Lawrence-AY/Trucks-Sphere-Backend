const test=require('node:test');
const assert=require('node:assert/strict');
const {planMerge}=require('../scripts/merge-hindi-vendors');
const {matchVendor}=require('../src/utils/vendorMatching');
function fixture(){return {
 vendors:[{id:'V001',name:'HINDI GEN AGENCY LIMITED',companyName:'HINDI GEN AGENCY LIMITED',fleetSize:19},{id:'V008',companyName:'HINDI GENERAL AGENCIES LIMITED'}],
 deliveryOrders:[{id:'TRIP1',vendorId:'V008',vendorName:'HINDI GENERAL AGENCIES LIMITED',vehicleId:'T1',driverId:'D1',siteNetWeight:10,rawPayload:{FIRMA_ADI:'HINDI GEN AGENCY LTD'}}],
 purchaseOrders:[{id:'PO0001-V001',vendorId:'V001',vendorName:'HINDI GEN AGENCY LIMITED',status:'active'}],
 stocks:[{id:'S1',vendorName:'HINDI GEN AGENCY LIMITED',receivedQuantity:10,consumedQuantity:3,remainingQuantity:7}],
 vehicles:[{id:'T1',vendorIds:['V001','V008']}],users:[{id:'U1',vendorId:'V008'}],vendorAliases:[],vendorUniqueKeys:[]
};}
test('merge preserves trip assignments, PO IDs, stock balances and raw capture; remaps accounts',()=>{
 const state=fixture(),original=structuredClone(state);const changes=planMerge(state);
 const trip=changes.find(c=>c.collection==='deliveryOrders').after;
 assert.equal(trip.vendorId,'V001');assert.equal(trip.vehicleId,'T1');assert.equal(trip.driverId,'D1');assert.equal(trip.siteNetWeight,10);assert.deepEqual(trip.rawPayload,original.deliveryOrders[0].rawPayload);
 assert.equal(changes.find(c=>c.collection==='purchaseOrders').after.id,'PO0001-V001');
 assert.equal(changes.find(c=>c.collection==='stocks').after.remainingQuantity,7);
 assert.equal(changes.find(c=>c.collection==='users').after.vendorId,'V001');
 assert.deepEqual(changes.find(c=>c.collection==='vehicles').after.vendorIds,['V001']);
 assert.deepEqual(state,original);
 for(const c of changes){state[c.collection]||=[];state[c.collection]=state[c.collection].filter(row=>row.id!==c.id);if(c.after)state[c.collection].push(c.after);}
 assert.equal(planMerge(state).length,0);
 for(const name of ['HINDI GEN AGENCY LIMITED','HINDI GEN AGENCY LTD','HINDI GENERAL AGENCIES LTD']){
  assert.equal(matchVendor(name,state.vendors).match.id,'V001');
  assert.equal(matchVendor(name,state.vendors).match.companyName,'HINDI GENERAL AGENCIES LIMITED');
 }
});
test('merge refuses conflicting vendor accounts and aliases',()=>{
 const state=fixture();state.vendors[0].userId='U1';state.vendors[1].userId='U2';
 assert.throws(()=>planMerge(state),/account owners/);
});

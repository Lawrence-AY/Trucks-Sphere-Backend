const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {planDates}=require('../scripts/lib/repairCaptureDates');
function fixture() {
 const row={PLAKA:'KAA123A',TARIH1:'2026-11-07T00:00:00',TARIH2:'2026-11-07T00:00:00',SAAT1:'08:33:56',SAAT2:'08:45:25',TARTIM1:33650,TARTIM2:12000};
 const first='2026-11-07T05:33:56.000Z',second='2026-11-07T05:45:25.000Z';
 const key=createHash('sha256').update(JSON.stringify(['source','KAA123A',first])).digest('hex');
 return {deliveryOrders:[{id:'trip',jobId:'PO0001/V001/D001/T001/J0001',accessBridgeSource:'source',accessBridgeKey:key,plateNumber:'KAA123A',
 siteWeighInAt:first,siteWeighOutAt:second,receivedAt:second,siteWeighInWeight:33650,quantityDelivered:21650,
 accessCapture:{capturedAt:first,observedAt:'2026-10-16T00:00:00Z'},createdAt:'2026-10-16T00:00:00Z'}],
 stocks:[{id:'stock',deliveryOrderId:'trip',acceptedAt:second,remainingQuantity:20000}],
 auditLogs:[{id:'audit',date:first}],
 'accessBridgeSources/source/events':[{id:'event',table_name:'KAYITLAR',source_id:'source',jobId:'trip',status:'processed',observed_utc:'2026-10-16T00:00:00Z',payload:JSON.stringify(row)}]};
}
function apply(state,plan) {
 const next=structuredClone(state);
 for(const change of plan.changes) Object.assign(next[change.collection].find(row=>row.id===change.id),change.patch);
 return next;
}
test('source-verified repair updates trip, stock and capture identity without changing quantities or unrelated logs',()=>{
 const state=fixture(),plan=planDates(state),next=apply(state,plan);
 assert.equal(plan.repairs.length,1);assert.equal(plan.changes.length,3);
 assert.equal(next.deliveryOrders[0].siteWeighInAt,'2026-07-11T05:33:56.000Z');
 assert.equal(next.deliveryOrders[0].receivedAt,'2026-07-11T05:45:25.000Z');
 assert.equal(next.deliveryOrders[0].accessCapture.capturedAt,next.deliveryOrders[0].siteWeighInAt);
 assert.equal(next.stocks[0].acceptedAt,next.deliveryOrders[0].receivedAt);
 assert.equal(next.stocks[0].remainingQuantity,20000);
 assert.equal(next.deliveryOrders[0].siteWeighInWeight,33650);
 assert.equal(next.deliveryOrders[0].quantityDelivered,21650);
 assert.equal(next.deliveryOrders[0].createdAt,state.deliveryOrders[0].createdAt);
 assert.deepEqual(next.auditLogs,state.auditLogs);
 assert.notEqual(next.deliveryOrders[0].accessBridgeKey,state.deliveryOrders[0].accessBridgeKey);
 const event=next['accessBridgeSources/source/events'][0];
 assert.equal(event.originalPayload,state['accessBridgeSources/source/events'][0].payload);
 assert.equal(event.status,'processed');
 assert.equal(planDates(next).changes.length,0);
});
test('mixed chronology failures receive corrected payload and retry without creating deliveries',()=>{
 const state=fixture();state.deliveryOrders=[];state.stocks=[];
 const event=state['accessBridgeSources/source/events'][0];
 const row=JSON.parse(event.payload);row.TARIH2='2026-07-15';
 event.payload=JSON.stringify(row);event.status='blocked';event.reason='INVALID_CAPTURE_CHRONOLOGY';
 const plan=planDates(state);
 assert.equal(plan.repairs.length,0);
 assert.equal(plan.changes[0].patch.status,'pending');
 const fixed=JSON.parse(plan.changes[0].patch.payload);
 assert.equal(fixed.TARIH1,'2026-07-11T00:00:00');assert.equal(fixed.TARIH2,'2026-07-15');
});
test('source mismatches and duplicate corrected capture identities abort before writes',()=>{
 const state=fixture();state.deliveryOrders[0].siteWeighInAt='2026-11-07T05:00:00Z';
 assert.throws(()=>planDates(state),/conflicts with source/);
 const duplicate=fixture();const corrected=planDates(duplicate).repairs[0].newKey;
 duplicate.deliveryOrders.push({...duplicate.deliveryOrders[0],id:'duplicate',accessBridgeKey:corrected});
 assert.throws(()=>planDates(duplicate),/already exists/);
});
test('unmatched future trips are reported for review',()=>{
 const state=fixture();state['accessBridgeSources/source/events']=[];
 assert.deepEqual(planDates(state).unresolved,['trip']);
});

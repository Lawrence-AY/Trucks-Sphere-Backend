const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture({ failFirstClear = false } = {}) {
 const cleared=[];
 const auth={status:'authorized',requestedByEmail:'agent@test',jobId:'J1',driverId:'D1',vehicleId:'T1',vendorId:'V001',girDriverCode:'D11234',otp:'012345',fuelCode:'234',authorizedAt:'2026-01-01T00:00:00Z'};
 const records=new Map([['fuelAuthorizations/A1',auth]]);
 const ref=(key)=>({key,get:async()=>({exists:records.has(key),data:()=>records.get(key)})});
 const db={collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>fn({get:r=>r.get(),set:(r,d)=>records.set(r.key,d),update:(r,d)=>records.set(r.key,{...records.get(r.key),...d})})};
 const job={id:'j1',jobId:'J1',receiptNoteId:'J1/RN001'};
 const deps={ '../../utils/receiptReference':require('../src/utils/receiptReference'), '../../utils/fuelEligibility':{isSupersededForFuel:()=>false},'../../../config/firebase':{db},'../../utils/counterService':{},'../../utils/snapshotStore':{getAll:()=>[job]},'../../integrations/girService':{clearFuelSession:async refs=>{cleared.push(refs);if(failFirstClear && cleared.length===1)throw new Error('FMS unavailable');},findFuelTransaction:async expected=>{assert.equal(expected.receiptNoteId,'J1/RN001');return {id:'TX1',volume:21.5};}} };
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/fuel/service'),'utf8'),{module,console:{error(){}},require:name=>deps[name] || require(name)});
 return {service:module.exports,records,cleared};
}
test('finalization uses FMS volume and records the transaction once on retry',async()=>{
 const {service,records,cleared}=fixture(); const request={authorizationId:'A1',jobId:'J1',dispensedByEmail:'agent@test',fmsTransactionId:'TX1',fuelAmount:999,vendorId:'V001',otp:'forged',authorizationCode:'forged'};
 const first=await service.create(request); const second=await service.create(request);
 assert.equal(first.otp,'234'); assert.equal(first.authorizationCode,'012345'); assert.equal(cleared.length,2); assert.equal(cleared[0].driverId,'D1'); assert.equal(cleared[0].vehicleId,'T1'); assert.equal(first.driverCode,'D1'); assert.equal(first.fuelAmount,21.5); assert.equal(first.receiptNoteId,'J1/RN001'); assert.equal(first.id,second.id);
 assert.equal([...records.keys()].filter(k=>k.startsWith('fuelRecords/')).length,1);
});
test('confirmation cannot use another operator authorization',async()=>{
 const {service}=fixture();await assert.rejects(service.confirm('A1','other@test'),{statusCode:403});
});
test('confirmation rejects references from a different driver or job',async()=>{
 const {service}=fixture();
 await assert.rejects(service.confirm('A1','agent@test',{driverId:'D2'}),{code:'FMS_REFERENCE_MISMATCH'});
 await assert.rejects(service.confirm('A1','agent@test',{jobId:'J2'}),{code:'FMS_REFERENCE_MISMATCH'});
});
test('finalization rejects an unconfirmed transaction',async()=>{
 const {service,records}=fixture();await assert.rejects(service.create({authorizationId:'A1',jobId:'J1',dispensedByEmail:'agent@test',fmsTransactionId:'wrong'}),{statusCode:409});
 assert.equal([...records.keys()].filter(k=>k.startsWith('fuelRecords/')).length,0);
});
test('failed FMS deactivation can be retried without duplicating the fuel record',async()=>{
 const {service,records,cleared}=fixture({failFirstClear:true});
 const request={authorizationId:'A1',jobId:'J1',dispensedByEmail:'agent@test',fmsTransactionId:'TX1'};
 await assert.rejects(service.create(request),/FMS unavailable/);
 const saved=await service.create(request);
 assert.equal(saved.fuelAmount,21.5);
 assert.equal(cleared.length,2);
 assert.equal([...records.keys()].filter(k=>k.startsWith('fuelRecords/')).length,1);
});
test('confirmation endpoint returns pending without an HTTP conflict',async()=>{
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/fuel/controller'),'utf8'),{module,exports:module.exports,require:name=>name==='./service'?{confirm:async()=>{throw Object.assign(new Error('Waiting'),{code:'FMS_TRANSACTION_PENDING'});}}:{normalizeRole:x=>x}});
 let body;
 await module.exports.confirm({query:{authorizationId:'A1'},user:{email:'agent@test'}},{json:value=>{body=value;}},error=>{throw error;});
 assert.equal(body.status,'pending');
});

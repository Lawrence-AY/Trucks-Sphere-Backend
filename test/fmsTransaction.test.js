const test = require('node:test');
const assert = require('node:assert/strict');
const { selectFuelTransaction } = require('../src/utils/fmsTransaction');
const expected = {receiptNoteId:'PO0011/V012/D006/T005/J0003/RN011',activeDriverCode:'D0061234',driverId:'D006',vehicleId:'T005',vendorId:'V012',authorizedAt:'2026-01-01T10:00:00Z'};
const row = {id:'tx1',volume:42.5,date:'2026-01-01T10:05:00Z',driver:{code:'D0061234'},xfields:{jobid:expected.receiptNoteId,driverid:'D006',vehicleid:'T005',vendorid:'V012'}};

test('matches GIR combined or reversed driver display name with registration and exact code',()=>{
 const refs={...expected,fmsDriver:{first_name:'Raha',name:'Raha Tupu'},fmsVehicle:{name:'KDS822X'}};
 const pump={...row,xfields:{},driver:{name:'Raha Raha Tupu',code:expected.activeDriverCode},vehicle:{name:'KDS822X'},volume:'1.25'};
 assert.equal(selectFuelTransaction([pump],refs).volume,1.25);
 assert.equal(selectFuelTransaction([{...pump,driver:{...pump.driver,name:'Raha Tupu Raha'}}],refs).volume,1.25);
 for(const patch of [{vehicle:{name:'OTHER'}},{driver:{...pump.driver,code:'OLD'}},{driver:{...pump.driver,name:'Other'}},{volume:Infinity}]) assert.throws(()=>selectFuelTransaction([{...pump,...patch}],refs));
});
test('returns volume from the unique matching issued receipt and authorization',()=>assert.deepEqual(selectFuelTransaction([row],expected),{id:'tx1',volume:42.5}));
test('does not match a bare job ID, stale code, wrong vehicle or old timestamp',()=>{
 for(const patch of [{xfields:{...row.xfields,jobid:'PO0011/V012/D006/T005/J0003'}},{driver:{code:'D006'}},{xfields:{...row.xfields,vehicleid:'T006'}},{date:'2026-01-01T09:00:00Z'},{volume:0}]) assert.throws(()=>selectFuelTransaction([{...row,...patch}],expected));
});
test('rejects ambiguous matches and missing identifiers',()=>{
 assert.throws(()=>selectFuelTransaction([row,{...row,id:'tx2'}],expected));
 assert.throws(()=>selectFuelTransaction([row],{...expected,receiptNoteId:''}));
});
test('accepts the authorized job reference and narrows by fuel transaction ID',()=>{
 const jobRow={...row,xfields:{...row.xfields,jobid:'J1'}};
 assert.equal(selectFuelTransaction([jobRow],{...expected,jobId:'J1',fmsTransactionId:'tx1'}).volume,42.5);
 assert.throws(()=>selectFuelTransaction([jobRow],{...expected,jobId:'J1',fmsTransactionId:'other'}),{code:'FMS_TRANSACTION_PENDING'});
});
test('no completed transaction is a pending state with a specific code',()=>{
 assert.throws(()=>selectFuelTransaction([],expected),{code:'FMS_TRANSACTION_PENDING'});
});
test('resolves FMS relational identities without nested TruckSphere xfields',()=>{
 const linked={...row,driver:{id:17},vehicle:{id:24},xfields:{jobid:expected.receiptNoteId}};
 const refs={...expected,fmsDriverId:17,fmsVehicleId:24};
 assert.equal(selectFuelTransaction([linked],refs).volume,42.5);
 assert.equal(selectFuelTransaction([{...linked,driver:17,vehicle:24}],refs).id,'tx1');
 assert.throws(()=>selectFuelTransaction([{...linked,vehicle:{id:25}}],refs));
 assert.throws(()=>selectFuelTransaction([{...linked,_deleted:true}],refs));
});

test('recovers blank pump xfields only with exact temporary code and both mapped identities',()=>{
 const pump={...row,driver:{id:17,code:expected.activeDriverCode},vehicle:{id:24},xfields:{jobid:'',otp:'',authorizationcode:''}};
 const refs={...expected,fmsDriverId:17,fmsVehicleId:24};
 assert.equal(selectFuelTransaction([pump],refs).volume,42.5);
 for(const patch of [{driver:{id:17}}, {driver:{id:17,code:'OLD'}}, {vehicle:{id:25}}, {date:'2026-01-01T09:00:00Z'}, {xfields:{jobid:'another-job'}}]) {
   assert.throws(()=>selectFuelTransaction([{...pump,...patch}],refs),{code:'FMS_TRANSACTION_PENDING'});
 }
 assert.throws(()=>selectFuelTransaction([pump,{...pump,id:'tx2'}],refs),{code:'FMS_TRANSACTION_AMBIGUOUS'});
});

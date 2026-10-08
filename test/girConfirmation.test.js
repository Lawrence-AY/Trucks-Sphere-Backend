const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const expected = {jobId:'J1',receiptNoteId:'J1/RN001',driverId:'D1',vehicleId:'V1',activeDriverCode:'D1ABC',authorizedAt:'2026-01-01T00:00:00Z'};
function fixture(vehicleJob = 'J1/RN001') {
 const calls=[];
 const module={exports:{}};
 const row={id:'line2',transac_id:'physical1',date:'2026-01-01T01:00:00Z',volume:1.25,driver:{id:'driver1',code:'D1ABC'},vehicle:{id:'vehicle1'},xfields:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../src/integrations/girService'),'utf8'),{
  module,process:{env:{GIR_FMS_BASE_URL:'https://fms.test',GIR_FMS_API_KEY:'test'}},AbortSignal,
  require:name=>require('../src/utils/fmsTransaction'),
  fetch:async(url)=>{
   calls.push(url);
   let body;
   if(url.includes('/drivers')) body={result:[{id:'driver1',xfields:{driverid:'D1',jobid:'J1/RN001'}}]};
   else if(url.includes('/vehicles')) body={result:[{id:'vehicle1',xfields:{vehicleid:'V1',jobid:vehicleJob}}]};
   else if(url.includes('last_id=line1')) body={result:[row],more:false};
   else body={result:[{...row,id:'line1',volume:0}],more:true};
   return {ok:true,json:async()=>body};
  },
 });
 return {service:module.exports,calls};
}
test('confirmation reads subsequent pages and uses latest physical transaction volume',async()=>{
 const {service,calls}=fixture();
 const result=await service.findFuelTransaction(expected);
 assert.equal(result.id,'line2');assert.equal(result.volume,1.25);
 assert.ok(calls.some(url=>url.endsWith('?last_id=line1')));
});
test('confirmation rejects different driver and vehicle job references',async()=>{
 const {service,calls}=fixture('another-job');
 await assert.rejects(service.findFuelTransaction(expected),{code:'FMS_REFERENCE_MISMATCH'});
 assert.ok(!calls.some(url=>url.includes('/transac_fuels')));
});

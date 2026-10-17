const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
test('master-table imports allocate canonical IDs and reuse them on replay', async () => {
  const records = new Map(), allocated = [];
  const db = { collection: name => ({
    get: async () => ({ docs: [...records].filter(([key]) => key.startsWith(name+'/')).map(([key,data]) => ({ id:key.split('/')[1],data:()=>data })) }),
    doc: id => ({ set: async (data,options) => records.set(name+'/'+id,options?.merge ? {...records.get(name+'/'+id),...data} : data) }),
  }) };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/integrations/access-bridge/masterTables'),'utf8'), {
    module, require: name => name === '../../utils/counterService' ? {getNextId:()=>assert.fail('Use injected allocator')}
      : name === '../../modules/vendors/service' ? {} : require(name === '../../utils/vendorMatching' ? '../src/utils/vendorMatching' : name),
  });
  const process = module.exports.createMasterTableProcessor({ db, config:{sourceId:'source'},
    nextId: async type => { allocated.push(type); return type === 'driver' ? 'D058' : 'T056'; } });
  for (let i=0;i<2;i++) {
    assert.equal((await process({table_name:'DIGER3',payload:JSON.stringify({DIGER3_ISIM:'Example Driver'})})).driverId,'D058');
    assert.equal((await process({table_name:'TANIMLI_ARACLAR',payload:JSON.stringify({PLAKA:'KAA 123-A'})})).vehicleId,'T056');
  }
  assert.deepEqual(allocated,['driver','truck']);
  assert.equal(records.size,2);
  assert.equal(records.get('vehicles/T056').plateNumber,'KAA123A');
});

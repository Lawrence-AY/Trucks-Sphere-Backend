const { test } = require('node:test');
const assert = require('node:assert/strict');
const { payloadFor, createClient, syncRecord, validateSchema, startOdooSync } = require('../src/integrations/odooSync');
const contracts = require('../src/integrations/odoo-contract.json');
test('live fuel exports keep driver ID and driver code distinct', () => {
  const live = require('../src/integrations/odoo-live-contract.json').fuels;
  const values = payloadFor('fuels', { id: 'F1', driverId: 'D1', driverCode: 'CODE1', girDriverCode: 'CODE1ABC' }, live);
  assert.equal(values.x_driver_id, 'D1');
  assert.equal(values.x_driver_code, 'CODE1');
  assert.equal(values.x_gir_driver_code, 'CODE1ABC');
});

test('all six payloads preserve source IDs and use declared Odoo fields', () => {
  for (const [slug, contract] of Object.entries(contracts)) {
    const record = { id: 'V001/007' };
    for (const field of contract.fields) {
      if (field.source === 'id') continue;
      record[field.source] = field.encoding === 'JSON' ? [{ nested: 'value' }] : field.type === 'boolean' ? false : field.type === 'float' ? 0 : 'sample';
    }
    const payload = payloadFor(slug, record);
    assert.equal(payload.x_id, 'V001/007');
    assert.ok(payload.x_name);
    assert.deepEqual(Object.keys(payload).sort(), [...new Set(['x_name', ...contract.fields.map(f => f.name)])].sort());
  }
});
test('warehouse items remain JSON and timestamps retain timezone', () => {
  const items = [{ materialId: 'MAT001', quantity: 2, sourceData: { reference: '007' } }];
  const p = payloadFor('warehouse', { id: 'WH1', items, createdAt: '2026-09-26T12:00:00+03:00' });
  assert.deepEqual(JSON.parse(p.x_items), items);
  assert.equal(p.x_created_at, '2026-09-26T12:00:00+03:00');
});
test('missing fields clear remote values while zero and false remain valid', () => {
  const p = payloadFor('materials', { id: 'MAT001', name: 'Steel', unitPrice: 0, active: false });
  assert.equal(p.x_unit_price, 0);
  assert.equal(p.x_active, false);
  assert.equal(p.x_description, false);
  assert.equal(p.x_name, 'Steel');
});
test('invalid types fail instead of silently losing data', () => {
  assert.throws(() => payloadFor('materials', { id: '1', unitPrice: NaN }));
  assert.throws(() => payloadFor('materials', { id: '1', active: 'false' }));
  assert.throws(() => payloadFor('drivers', { id: 1 }));
});
test('create then update uses stable source ID and does not duplicate records', async () => {
  let remote;
  const calls = [];
  const call = async (model, method, body) => {
    calls.push(method);
    if (method === 'search_read') { assert.deepEqual(body.domain, [['x_id', '=', 'D001']]); return remote ? [remote] : []; }
    if (method === 'create') { remote = { id: 81, ...body.vals_list[0] }; return [81]; }
    assert.equal(method, 'write'); assert.deepEqual(body.ids, [81]); remote = { ...remote, ...body.vals }; return true;
  };
  assert.equal(await syncRecord(call, 'drivers', { id: 'D001', fullName: 'First' }), 'created');
  assert.equal(await syncRecord(call, 'drivers', { id: 'D001', fullName: 'Second' }), 'updated');
  assert.equal(await syncRecord(call, 'drivers', { id: 'D001', fullName: 'Second' }), 'unchanged');
  assert.equal(calls.filter(x => x === 'create').length, 1);
});
test('duplicate remote source IDs abort without writing', async () => {
  await assert.rejects(syncRecord(async (_, method) => { assert.equal(method, 'search_read'); return [{ id: 1 }, { id: 2 }]; }, 'vendors', { id: 'V1' }), /DUPLICATE/);
});
test('failed creates can be retried by looking up source ID again', async () => {
  let remote;
  const call = async (_, method, body) => {
    if (method === 'search_read') return remote ? [remote] : [];
    remote = { id: 1, ...body.vals_list[0] };
    throw new Error('response lost after commit');
  };
  await assert.rejects(syncRecord(call, 'vendors', { id: 'V1' }));
  assert.equal(await syncRecord(call, 'vendors', { id: 'V1' }), 'unchanged');
});
test('native Odoo transport sends only POST including updates, never GET', async () => {
  const requests = [];
  const call = createClient({ ODOO_BASE_URL: 'https://odoo.example.test/', ODOO_API_KEY: 'test', ODOO_DATABASE: 'db' }, async (url, options) => {
    requests.push({ url, options }); return { ok: true, json: async () => true };
  });
  for (const method of ['fields_get', 'search_read', 'create', 'write']) await call('x_trucksphere_drivers', method, {});
  assert.ok(requests.every(r => r.options.method === 'POST' && r.options.redirect === 'error'));
  assert.ok(requests[3].url.endsWith('/json/2/x_trucksphere_drivers/write'));
  assert.equal(requests[0].options.headers['X-Odoo-Database'], 'db');
});
test('HTTP failures expose status only', async () => {
  const call = createClient({ ODOO_BASE_URL: 'https://odoo.example.test', ODOO_API_KEY: 'secret' }, async () => ({ ok: false, status: 401 }));
  await assert.rejects(call('model', 'write', {}), /^Error: ODOO_HTTP_401$/);
});
test('schema preflight rejects incompatible module before writes', async () => {
  await assert.rejects(validateSchema(async () => ({})), /SCHEMA_MISMATCH/);
  await validateSchema(async model => {
    const contract = Object.values(contracts).find(c => c.model === model);
    return { x_name: { type: 'char' }, ...Object.fromEntries(contract.fields.map(f => [f.name, { type: f.type }])) };
  });
});
test('disabled integration does not access database or network', () => {
  startOdooSync({ env: { ODOO_ENABLED: 'false' } }).stop();
});

test('fuel export waits for a completed FMS transaction and positive volume', async () => {
  const noRequest = () => assert.fail('Unconfirmed fuel must not reach Odoo');
  for (const record of [{id:'a'}, {id:'a',fuelAmount:10,status:'completed'}, {id:'a',fmsTransactionId:'F1',fuelAmount:0,status:'completed'}, {id:'a',fmsTransactionId:'F1',fuelAmount:10,status:'pending'}]) assert.equal(await syncRecord(noRequest,'fuels',record),'skipped');
});

test('stocks are exported only after inspection and live driver dates retain native field types', async () => {
  assert.equal(await syncRecord(() => assert.fail('Uninspected stock'), 'stocks', {id:'s1',receivedQuantity:20}),'skipped');
  const contract=require('../src/integrations/odoo-live-contract.json').drivers;
  const payload=payloadFor('drivers',{id:'D1',fullName:'Driver',licenseExpiry:'2027-01-20T00:00:00Z',status:'ACTIVE'}, {...contract,preserveMissing:true});
  assert.equal(payload.x_source_id,'D1');assert.equal(payload.x_license_expiry,'2027-01-20');assert.equal(payload.x_status,'active');assert.equal(payload.x_name,'Driver');assert.equal(payload.x_email,undefined);
});

for (const profile of ['', 'spadestest-duplicate']) test('worker retries failed records with mapping profile: ' + (profile || 'default'), async () => {
  const mappings = profile ? require('../src/integrations/odoo-live-contract.json') : contracts;
  let leaseData;
  let failCreate = true;
  let remote;
  const summaries = [];
  let finish;
  const firstPass = new Promise(resolve => { finish = resolve; });
  const leaseRef = {};
  const db = {
    runTransaction: async callback => callback({
      get: async ref => { assert.equal(ref, leaseRef); return { data: () => leaseData }; },
      set: (ref, data) => { assert.equal(ref, leaseRef); leaseData = data; },
      delete: ref => { assert.equal(ref, leaseRef); leaseData = undefined; },
    }),
    collection: name => {
      if (name === 'integrationLocks') return { doc: () => leaseRef };
      const query = {
        orderBy: () => query, limit: () => query,
        get: async () => ({ size: name === 'drivers' ? 1 : 0, docs: name === 'drivers' ? [{ id: 'D001', data: () => ({ fullName: 'Test Driver' }) }] : [] }),
      };
      return query;
    },
  };
  const call = async (model, method, body) => {
    if (method === 'fields_get') {
      const c = Object.values(mappings).find(c => c.model === model);
      return { x_name: { type: 'char' }, ...Object.fromEntries(c.fields.map(f => [f.name, { type: f.type }])) };
    }
    if (method === 'search_read') return remote ? [remote] : [];
    assert.equal(method, 'create');
    if (failCreate) throw new Error('offline');
    remote = { id: 8, ...body.vals_list[0] };
    return [8];
  };
  const worker = startOdooSync({ db, call, watch: false, env: { ODOO_ENABLED: 'true', ODOO_MAPPING_PROFILE: profile }, logger: {
    info: (_, counts) => { summaries.push(counts); finish(); }, error: message => assert.equal(message, '[Odoo] Record export failed'),
  } });
  try {
    await firstPass;
    // Let the first pass release its lease and running flag.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(summaries[0].failed, 1);
    failCreate = false;
    await worker.tick();
    assert.equal(summaries[1].created, 1);
    assert.equal(remote[profile ? 'x_source_id' : 'x_id'], 'D001');
    assert.equal(leaseData, undefined);
  } finally { worker.stop(); }
});

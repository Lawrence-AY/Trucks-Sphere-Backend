const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/integrations/access-bridge/store');

function fakeFirestore() {
  const data = new Map(); let sequence = 0;
  function collection(path) {
    return { doc(id = `event${++sequence}`) { return reference(`${path}/${id}`); } };
  }
  function reference(path) {
    return {
      path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`),
      async get() { return { exists: data.has(path), data: () => structuredClone(data.get(path)) }; },
      async set(value, options) { data.set(path, options?.merge ? { ...data.get(path), ...value } : structuredClone(value)); },
      async update(value) { assert.ok(data.has(path)); data.set(path, { ...data.get(path), ...value }); },
    };
  }
  return { data, collection, async runTransaction(work) {
    const writes = [];
    const result = await work({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)), update: (ref, value) => writes.push(() => ref.update(value)) });
    for (const write of writes) await write();
    return result;
  } };
}
const row = { KAYIT_NO: 1, PLAKA: 'KAA123A', TARTIM1: 30000 };
const records = [{ table: 'KAYITLAR', row }];
const events = db => [...db.data.entries()].filter(([key]) => key.includes('/events/')).map(([key, value]) => ({ id: key.split('/').at(-1), ...value }));

test('Firebase snapshots deduplicate retries, restart uploads, and store changes durably', async () => {
  const db = fakeFirestore();
  const store = createStore(db, 'bridge');
  assert.equal((await store.observe(records)).changed, 1);
  assert.equal(events(db)[0].event_type, 'BASELINE');
  assert.equal((await store.observe(records)).changed, 0);
  await store.observe([], true);
  const restarted = createStore(db, 'bridge');
  assert.equal((await restarted.observe(records)).changed, 0);
  assert.equal((await restarted.observe([{ table: 'KAYITLAR', row: { ...row, TARTIM2: 10000 } }])).changed, 1);
  assert.equal(events(db)[1].event_type, 'UPDATE');
  await restarted.observe([{ table: 'KAYITLAR', row: { ...row, KAYIT_NO: 2 } }]);
  assert.equal(events(db)[2].event_type, 'INSERT');
  await restarted.save(events(db)[2].id, { status: 'processed', jobId: 'J001' });
  assert.equal(events(db)[2].jobId, 'J001');
});
test('Firebase worker lease excludes another owner and releases on shutdown', async () => {
  const store = createStore(fakeFirestore(), 'bridge');
  assert.equal(await store.claim('first'), true);
  assert.equal(await store.claim('second'), false);
  await store.release('second');
  assert.equal(await store.claim('second'), false);
  await store.release('first');
  assert.equal(await store.claim('second'), true);
});
test('a historical upload uses one transaction and retries without duplicate events', async () => {
  const db = fakeFirestore(), run = db.runTransaction;
  let transactions = 0;
  db.runTransaction = work => { transactions++; return run(work); };
  const store = createStore(db, 'bridge');
  const batch = Array.from({ length: 20 }, (_, i) => ({ table: 'KAYITLAR', row: { ...row, KAYIT_NO: i + 1 } }));
  assert.equal((await store.observe(batch, true)).changed, 20);
  assert.equal(transactions, 1);
  assert.ok(events(db).every(event => event.event_type === 'BASELINE'));
  assert.equal((await store.observe(batch)).changed, 0);
  assert.equal(events(db).length, 20);
  await assert.rejects(store.observe([batch[0], batch[0]]), /DUPLICATE_CAPTURE/);
  assert.equal(events(db).length, 20);
});
test('invalid chunk causes no partial observation writes and sources are isolated', async () => {
  const db = fakeFirestore(), store = createStore(db, 'bridge');
  await assert.rejects(store.observe([...records, { table: 'unexpected', row }]), /INVALID/);
  assert.equal(db.data.size, 0);
  await store.observe(records);
  await createStore(db, 'other').observe(records);
  assert.equal(events(db).length, 2);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture() {
  let handler, observations = 0, storeCalls = 0;
  const logs = [], router = { post(route, fn) { if (route === '/captures') handler = fn; }, get() {}, use() {} };
  const apiKey = 'x'.repeat(32);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/integrations/access-bridge/routes.js'), 'utf8'), {
    module: { exports: {} }, console: { log: (...args) => logs.push(args) }, require(name) {
      if (name === 'express') return { Router: () => router };
      if (name.endsWith('authMiddleware')) return { verifyToken() {} };
      if (name.endsWith('authorizationMiddleware')) return { requireRoles: () => () => {} };
      if (name.endsWith('config/firebase')) return { db: new Proxy({}, { get() { throw Error('Unexpected Firestore access'); } }) };
      if (name === './config') return { readConfig: () => ({ enabled: true, apiKey, sourceId: 'bridge' }) };
      if (name === './worker') return { status: () => ({}) };
      if (name === './store') return { createStore() { storeCalls++; return { async observe() { observations++; return { changed: 1 }; } }; } };
      return require(name);
    },
  });
  const invoke = async (body, authorized = true) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ headers: { authorization: `Bearer ${authorized ? apiKey : 'invalid'}` }, body }, res, err => { throw err; });
    return res;
  };
  return { invoke, logs, get observations() { return observations; }, get storeCalls() { return storeCalls; } };
}

test('authenticated empty heartbeat bypasses store and produces no noisy payload log', async () => {
  const f = fixture();
  const res = await f.invoke({ sourceId: 'bridge', records: [], complete: true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changed, 0);
  assert.equal(f.storeCalls, 0);
  assert.equal(f.observations, 0);
  assert.equal(f.logs.length, 0);
  assert.equal((await f.invoke({ sourceId: 'bridge', records: [], complete: true }, false)).statusCode, 401);
});

test('accepted listener payload and every raw row are logged without bearer credentials', async () => {
  const f = fixture();
  const body = { sourceId: 'bridge', records: [{ table: 'ICERIDEKI_ARACLAR', row: { PLAKA: 'KCB292D', DIGER3_ISIM: 'FRANK OCEAN' } }], complete: false };
  await f.invoke(body);
  assert.equal(f.logs[0][0], '[Access bridge] payload:');
  assert.equal(f.logs[0][1], JSON.stringify(body));
  assert.equal(f.logs[1][1], JSON.stringify(body.records[0]));
  assert.equal(JSON.stringify(f.logs).includes('x'.repeat(32)), false);
  assert.equal(f.observations, 1);
});

test('wrong source, malformed arrays and invalid complete flag never reach the store', async () => {
  const f = fixture();
  for (const body of [{ sourceId: 'other', records: [] }, { sourceId: 'bridge', records: null }, { sourceId: 'bridge', records: [], complete: 'true' }]) {
    assert.equal((await f.invoke(body)).statusCode, 400);
  }
  assert.equal(f.storeCalls, 0);
});

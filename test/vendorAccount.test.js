const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const records = new Map();
  const accounts = new Map();
  let sequence = 0;
  const snapshot = (name, id) => ({ id, exists: records.has(`${name}/${id}`), data: () => records.get(`${name}/${id}`) });
  const collection = (name, filters = []) => ({
    name, filters,
    doc: (id) => ({ name, id, get: async () => snapshot(name, id) }),
    where: (field, _operator, value) => collection(name, [...filters, [field, value]]),
    limit() { return this; },
    async get() {
      const docs = [...records].filter(([key, value]) => key.startsWith(`${name}/`) && filters.every(([field, expected]) => value[field] === expected)).map(([key]) => snapshot(name, key.slice(name.length + 1)));
      return { docs, empty: docs.length === 0 };
    },
  });
  const auth = {
    createUser: async (data) => { const uid = `auth-${++sequence}`; accounts.set(uid, data); return { uid }; },
    setCustomUserClaims: async (uid, claims) => { accounts.get(uid).claims = claims; },
    deleteUser: async (uid) => accounts.delete(uid),
  };
  const dependencies = {
    '../../../config/firebase': { db: { collection, runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, data, options) => writes.push(() => records.set(`${ref.name}/${ref.id}`, { ...(options?.merge ? records.get(`${ref.name}/${ref.id}`) : {}), ...data })) });
      writes.forEach((write) => write()); return result;
    } } },
    'firebase-admin/auth': { getAuth: () => auth },
    '../../utils/counterService': { getNextId: async () => `V${++sequence}` },
    '../../utils/snapshotStore': {},
    '../../utils/passwordPolicy': require('../src/utils/passwordPolicy'),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/vendors/service'), 'utf8'), { module, console, require: (name) => dependencies[name] });
  return { service: module.exports, records, accounts };
}
const vendor = { companyName: 'Example', contactPerson: 'Test Person', phone: '0700000000', email: '' };

test('a vendor can receive a username login without a contact email', async () => {
  const { service, accounts, records } = harness();
  const result = await service.createWithAccount({ vendor, account: { password: 'Test7$', isActive: true } });
  assert.equal(result.username, 'testper');
  assert.equal(result.user.email, '');
  assert.equal(result.user.authEmail, 'testper@users.trucksphere.local');
  assert.equal(accounts.get(result.user.uid).password, 'Test7$');
  assert.equal(accounts.get(result.user.uid).claims.role, 'vendor');
  assert.equal(records.get(`vendors/${result.vendor.id}`).userId, result.user.uid);
});

test('repair links an existing vendor without duplicating it or replacing its history', async () => {
  const { service, accounts, records } = harness();
  records.set('vendors/V016', { ...vendor, id: 'V016', createdAt: 'original-date', fleetSize: 4 });
  const result = await service.createAccount('V016', { password: 'Test7$' });
  assert.equal(result.vendor.id, 'V016');
  assert.equal(result.user.vendorId, 'V016');
  assert.equal(records.get('vendors/V016').createdAt, 'original-date');
  assert.equal(records.get('vendors/V016').fleetSize, 4);
  assert.equal([...records.keys()].filter((key) => key.startsWith('vendors/')).length, 1);
  await assert.rejects(service.createAccount('V016', { password: 'Test7$' }), { code: 'VENDOR_ACCOUNT_ALREADY_EXISTS' });
  assert.equal(accounts.size, 1);
});

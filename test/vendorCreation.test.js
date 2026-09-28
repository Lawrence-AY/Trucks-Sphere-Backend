const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const records = new Map();
  let sequence = 0;
  const collection = (name) => ({ name, doc: (id) => ({ name, id }) });
  const dependencies = {
    '../../../config/firebase': { db: {
      collection,
      runTransaction: async (fn) => fn({
        get: async (ref) => ref.id
          ? { exists: records.has(`${ref.name}/${ref.id}`), data: () => records.get(`${ref.name}/${ref.id}`) }
          : { docs: [...records].filter(([key]) => key.startsWith(`${ref.name}/`)).map(([, value]) => ({ data: () => value })) },
        set: (ref, value) => records.set(`${ref.name}/${ref.id}`, value),
      }),
    } },
    'firebase-admin/auth': { getAuth: () => { throw new Error('Profile creation must not create a login'); } },
    '../../utils/counterService': { getNextId: async () => `V${++sequence}` },
    '../../utils/snapshotStore': {},
    '../../utils/passwordPolicy': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/vendors/service'), 'utf8'), {
    module, console: { error() {} }, require: (name) => {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return { service: module.exports, records };
}

const vendor = { companyName: 'Acme Supplies', contactPerson: 'Anne', phone: '0712345678', kraPin: 'A123' };

test('vendor creation saves locally and stale unique keys do not reject it', async () => {
  const { service, records } = harness();
  records.set('vendorUniqueKeys/company:acmesupplies', { vendorId: 'deleted-vendor' });
  const created = await service.create(vendor);
  assert.equal(records.get(`vendors/${created.id}`).companyName, vendor.companyName);
  assert.equal(records.get('vendorUniqueKeys/company:acmesupplies').vendorId, created.id);
});

test('real duplicate company, phone, and KRA PIN remain rejected', async () => {
  const { service } = harness();
  await service.create(vendor);
  for (const data of [
    { ...vendor, companyName: ' ACME Supplies ' },
    { companyName: 'Another company', phone: '+254712345678' },
    { companyName: 'Third company', kraPin: 'a123' },
  ]) await assert.rejects(service.create(data), { code: 'VENDOR_ALREADY_EXISTS' });
});

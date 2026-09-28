const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('driver CSV import accepts an omitted licence column and still verifies identity', async () => {
  const module = { exports: {} };
  let verified = 0;
  let created;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/bulk-import/service'), 'utf8'), {
    module, Buffer,
    require: (name) => {
      if (name.includes('firebase')) return { db: { collection: (collection) => ({ get: async () => ({ docs: collection === 'vendors' ? [{ id: 'V001', data: () => ({ companyName: 'Vendor' }) }] : [] }) }) } };
      if (name.includes('iprsService')) return { verifyDriverIdentity: async () => { verified++; } };
      if (name === '../drivers/service') return { create: async (item) => { created = item; return { id: 'D001' }; } };
      return {};
    },
  });
  const csv = Buffer.from('vendor_id,first_name,surname,phone,national_id\nV001,Anne,Omondi,0700000000,12345678\n');
  const result = await module.exports.commit('drivers', csv, { originalname: 'drivers.csv' });
  assert.equal(result.counts.imported, 1);
  assert.equal(created.licenseNumber, '');
  assert.equal(verified, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/integrations/odooVendorService');

test('Odoo supplier Contacts map to TruckSphere vendor fields', () => {
  const vendor = __testables.odooPartnerToVendor({
    id: 31,
    name: 'Atlas Hauliers Ltd',
    vat: 'P051234567A',
    email: 'dispatch@atlas.example',
    phone: '+254700000000',
    active: true,
  });

  assert.equal(vendor.odooPartnerId, 31);
  assert.equal(vendor.companyName, 'Atlas Hauliers Ltd');
  assert.equal(vendor.contactPerson, 'Atlas Hauliers Ltd');
  assert.equal(vendor.kraPin, 'P051234567A');
  assert.equal(vendor.status, 'active');
  assert.ok(Date.parse(vendor.odooSyncedAt));
});

test('Odoo vendor mapping marks archived Contacts inactive and uses mobile as a fallback', () => {
  const vendor = __testables.odooPartnerToVendor({
    id: 32,
    name: 'Roadworks Supplier',
    mobile: '+254711111111',
    active: false,
  });

  assert.equal(vendor.phone, '+254711111111');
  assert.equal(vendor.status, 'inactive');
  assert.equal(vendor.email, undefined);
});

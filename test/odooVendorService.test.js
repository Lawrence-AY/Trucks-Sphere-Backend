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

test('TruckSphere vendors map to Odoo supplier Contacts for Fleet and Purchase', () => {
  const values = __testables.vendorToPartnerValues({
    id: 'V001',
    companyName: 'Atlas Hauliers Ltd',
    phone: '+254700000000',
    email: 'dispatch@atlas.example',
    kraPin: 'P051234567A',
    status: 'active',
  });

  assert.equal(values.ref, 'TruckSphere:vendor:V001');
  assert.equal(values.is_company, true);
  assert.equal(values.supplier_rank, 1);
  assert.equal(values.active, true);
  assert.equal(values.vat, 'P051234567A');
});

test('TruckSphere vendor contact people map to child Odoo Contacts', () => {
  const values = __testables.contactToPartnerValues({
    companyName: 'Atlas Hauliers Ltd',
    contactPerson: 'Jane Wanjiku',
    phone: '+254700000000',
    email: 'jane@atlas.example',
  }, 51);

  assert.equal(values.name, 'Jane Wanjiku');
  assert.equal(values.parent_id, 51);
  assert.equal(values.type, 'contact');
  assert.equal(values.email, 'jane@atlas.example');
});

test('Odoo supplier Contact people are imported into their TruckSphere vendor', () => {
  const vendor = __testables.odooPartnerToVendor({
    id: 31,
    name: 'Atlas Hauliers Ltd',
    trucksphereContact: { id: 41, name: 'Jane Wanjiku', email: 'jane@atlas.example', mobile: '+254711111111' },
  });

  assert.equal(vendor.contactPerson, 'Jane Wanjiku');
  assert.equal(vendor.odooContactPartnerId, 41);
  assert.equal(vendor.email, 'jane@atlas.example');
  assert.equal(vendor.phone, '+254711111111');
});

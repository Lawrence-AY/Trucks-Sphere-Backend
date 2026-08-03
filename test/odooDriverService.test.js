const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/integrations/odooDriverService');

test('Odoo Authorized Driver records map to TruckSphere drivers and vendor Contacts', () => {
  const driver = __testables.odooDriverToDriver({
    id: 41,
    x_name: 'Jane Driver',
    x_studio_national_id: ' 12345678 ',
    x_studio_vendor: [31, 'Atlas Hauliers Ltd'],
    x_studio_driving_licence: 'DL-12345',
    x_studio_status: 'Authorized',
  });

  assert.equal(driver.odooDriverId, 41);
  assert.equal(driver.odooVendorPartnerId, 31);
  assert.equal(driver.name, 'Jane Driver');
  assert.equal(driver.nationalId, '12345678');
  assert.equal(driver.licenseNumber, 'DL-12345');
  assert.equal(driver.status, 'active');
  assert.equal(driver.availability, true);
});

test('Odoo Draft drivers are retained as inactive', () => {
  const driver = __testables.odooDriverToDriver({
    id: 42,
    x_name: 'Pending Driver',
    x_studio_vendor: [31, 'Atlas Hauliers Ltd'],
    x_studio_status: 'Draft',
  });

  assert.equal(driver.status, 'inactive');
  assert.equal(driver.availability, false);
});

test('Odoo driver mapping excludes empty optional values for Firestore', () => {
  const driver = __testables.odooDriverToDriver({
    id: 43,
    x_name: 'Status Pending',
    x_studio_national_id: '87654321',
    x_studio_vendor: [31, 'Atlas Hauliers Ltd'],
  });

  assert.equal(Object.hasOwn(driver, 'odooDriverStatus'), false);
  assert.equal(Object.hasOwn(driver, 'licenseNumber'), false);
});

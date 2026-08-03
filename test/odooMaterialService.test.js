const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/integrations/odooMaterialService');

test('Odoo product values use native product fields and TruckSphere additions', () => {
  const values = __testables.buildProductValues({
    id: 'MAT001',
    name: 'Ballast',
    category: 'Aggregates',
    measurementType: 'Tonnes',
    status: 'active',
    unitPrice: 1200,
    barcode: '123456',
    properties: [{ name: 'size', type: 'text' }],
  }, { uomId: 3, categoryId: 8, creating: true });

  assert.equal(values.default_code, 'MAT001');
  assert.equal(values.uom_id, 3);
  assert.equal(values.categ_id, 8);
  assert.equal(values.standard_price, 1200);
  assert.equal(values.x_trucksphere_measurement_type, 'Tonnes');
  assert.equal(values.type, 'consu');
});

test('Odoo-only product fields are mapped back to the material record', () => {
  const material = __testables.productFieldsToMaterial({
    id: 12,
    barcode: '123456',
    standard_price: 1200,
    list_price: 1500,
    weight: 4.5,
    volume: 0.2,
    type: 'consu',
    categ_id: [8, 'Aggregates'],
    uom_id: [3, 'Ton(s)'],
    x_trucksphere_properties: '[]',
    x_trucksphere_standard_weight: 50,
    x_trucksphere_diameter_options: '["8mm"]',
  }, 20);

  assert.equal(material.odooProductTemplateId, 12);
  assert.equal(material.odooProductVariantId, 20);
  assert.equal(material.barcode, '123456');
  assert.equal(material.weight, 4.5);
  assert.deepEqual(material.diameterOptions, ['8mm']);
});

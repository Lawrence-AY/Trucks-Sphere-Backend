const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/integrations/odooReceiptService');

test('site receipt quantities use the authoritative delivered site net first', () => {
  assert.equal(__testables.deliveredQuantity({ quantityDelivered: 18.5, siteNetWeight: 19 }), 18.5);
  assert.equal(__testables.deliveredQuantity({ siteNetWeight: 7.25 }), 7.25);
  assert.equal(__testables.deliveredQuantity({ quantityDelivered: 0, netWeight: 0 }), null);
});

test('receipt lookup references prefer the Odoo PO number and do not duplicate values', () => {
  assert.deepEqual(
    __testables.receiptReferences(
      { odooPurchaseOrderNumber: 'P00042', poNumber: 'POMAT001/V001' },
      { poNumber: 'POMAT001/V001' },
    ),
    ['P00042', 'POMAT001/V001'],
  );
});

test('the native Odoo backorder confirmation action is recognized', () => {
  assert.equal(__testables.isBackorderConfirmation({ res_model: 'stock.backorder.confirmation' }), true);
  assert.equal(__testables.isBackorderConfirmation({ res_model: 'stock.immediate.transfer' }), false);
});

test('a delivery note URL is appended once with a stable TruckSphere marker', () => {
  const delivery = { jobId: 'POMAT001/V001/J0001', deliveryNoteURL: 'https://files.example/note.pdf' };
  const note = __testables.withDeliveryNote('Supplier note', delivery);

  assert.match(note, /Supplier note/);
  assert.match(note, /\[TruckSphere POMAT001\/V001\/J0001\]/);
  assert.match(note, /https:\/\/files\.example\/note\.pdf/);
  assert.equal(__testables.withDeliveryNote(note, delivery), note);
});

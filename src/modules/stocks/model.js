const { createHash } = require('node:crypto');
const warehouse = (d) => Boolean(d.isWarehouseDelivery) || d.deliveryOrigin === 'warehouse';
const number = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const round = (n) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
function fail(message) { throw Object.assign(new Error(message), { statusCode: 409 }); }
function stockRows(delivery) {
  const wh = warehouse(delivery);
  const inspected = delivery.materialInspection;
  const completed = ['COMPLETED', 'SITE_WEIGHED_OUT'].includes(String(delivery.status).toUpperCase());
  if (!wh && !inspected?.mrfNumber && !completed) return [];
  const lines = wh ? (delivery.materials?.length ? delivery.materials : [
    { materialId: delivery.materialId, materialName: delivery.materialName, quantity: delivery.quantityOrdered, unit: delivery.unit },
    ...(delivery.additionalItems || []),
  ]) : inspected?.materialReceipts?.length ? inspected.materialReceipts : [
    { materialId: delivery.materialId, materialName: delivery.materialName, quantity: delivery.quantityOrdered, unit: 'Tonnes', receivedQuantity: delivery.siteNetWeight ?? delivery.quantityDelivered },
  ];
  return lines.map((line, index) => {
    const receipt = wh ? inspected?.materialReceipts?.find((r) => String(r.materialId) === String(line.materialId)) : line;
    const hasReceipt = Boolean(receipt && (inspected?.mrfNumber || completed));
    const sent = Math.max(0, number(line.quantity ?? line.orderedQuantity));
    const received = hasReceipt ? Math.max(0, number(receipt.receivedQuantity)) : 0;
    const passed = hasReceipt && (receipt.initialVisualInspection === 'Pass' || (!inspected?.mrfNumber && completed));
    return {
      id: createHash('sha256').update(`${delivery.id}:${line.materialId || index}`).digest('hex'),
      deliveryOrderId: delivery.id, jobId: delivery.jobId || delivery.id, poNumber: delivery.poNumber || '',
      siteId: delivery.siteId || '', siteName: delivery.siteName || delivery.siteId || 'Unassigned',
      materialId: line.materialId || '', materialName: line.materialName || line.productName || delivery.materialName || '',
      vendorName: delivery.vendorName || '', origin: wh ? 'Warehouse' : 'Quarry', unit: line.unit || delivery.unit || '',
      dispatchedQuantity: sent, receivedQuantity: received, usableQuantity: passed ? received : 0,
      quarantinedQuantity: hasReceipt && !passed ? received : 0,
      excessQuantity: wh ? Math.max(0, round(received - sent)) : 0,
      shortageQuantity: wh && hasReceipt ? Math.max(0, round(sent - received)) : 0,
      receiptStatus: hasReceipt ? passed ? 'Inspected - Pass' : 'Quarantined' : delivery.warehouseAcceptedAt ? 'Accepted - awaiting inspection' : 'Dispatched',
      acceptedAt: delivery.warehouseAcceptedAt || delivery.receivedAt || '', acceptedBy: delivery.warehouseAcceptedByName || delivery.receivedByName || '',
      inspectedAt: inspected?.inspectedAt || '', inspectorName: inspected?.inspectorName || '', mifNumber: inspected?.mrfNumber || '',
    };
  });
}
function validateInspection(delivery, inspection) {
  if (!warehouse(delivery)) return;
  const expected = stockRows({ ...delivery, materialInspection: null });
  const receipts = inspection?.materialReceipts;
  if (!Array.isArray(receipts) || receipts.length !== expected.length) fail('Inspect every dispatched warehouse product.');
  const ids = new Set();
  for (const receipt of receipts) {
    const key = String(receipt.materialId || '');
    if (ids.has(key) || !expected.some((r) => String(r.materialId) === key)) fail('Inspection contains a duplicate or unknown product.');
    ids.add(key);
    if (receipt.receivedQuantity === '' || receipt.receivedQuantity == null || !Number.isFinite(Number(receipt.receivedQuantity)) || Number(receipt.receivedQuantity) < 0) fail('Enter a valid received quantity for every product.');
    if (!['Pass', 'Failed'].includes(receipt.initialVisualInspection)) fail('Choose Pass or Failed for every warehouse product.');
    if (receipt.initialVisualInspection === 'Failed' && !String(receipt.failureReason || '').trim()) fail('Enter a reason for each failed product.');
  }
}
function balance(row, existing = {}) {
  const consumedQuantity = number(existing.consumedQuantity);
  if (row.usableQuantity < consumedQuantity) fail('Receipt correction would reduce stock below already recorded usage.');
  const remainingQuantity = round(row.usableQuantity - consumedQuantity);
  const unitCost = existing.unitCost == null ? null : number(existing.unitCost);
  return { ...row, consumedQuantity, remainingQuantity, unitCost, currency: existing.currency || '',
    remainingValue: unitCost == null ? null : round(remainingQuantity * unitCost),
    receivedValue: unitCost == null ? null : round(row.usableQuantity * unitCost),
    valuationStatus: unitCost == null ? 'Unpriced' : 'Priced' };
}
function issue(row, quantity) {
  const amount = Number(quantity);
  if (!Number.isFinite(amount) || amount <= 0) fail('Enter a positive usage quantity.');
  if (amount > row.remainingQuantity) fail('Usage exceeds available stock.');
  return balance(row, { ...row, consumedQuantity: round(number(row.consumedQuantity) + amount) });
}
module.exports = { stockRows, balance, issue, validateInspection };

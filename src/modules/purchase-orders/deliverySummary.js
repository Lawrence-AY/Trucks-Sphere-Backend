const { normalizeJobStatus } = require('../../utils/jobLifecycle');

const round = (value) => Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const quantity = (value) => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
function unitKey(unit) {
  const value = String(unit || 'Tonnes').trim().toLowerCase();
  return ['t', 'ton', 'tons', 'tonne', 'tonnes', 'metric tonnes'].includes(value) ? 'Tonnes' : value;
}

/** Sum each received trip once, never its repeated PO material quantities. */
function buildDeliverySummary(po, deliveries) {
  const lines = po.materials?.length ? po.materials : [po];
  const groups = new Map();
  for (const line of lines) {
    if (line.isWarehouseMaterial || po.isWarehouseMaterial) continue;
    const ordered = quantity(line.quantity);
    if (ordered == null) continue;
    const unit = unitKey(line.unit || po.unit);
    const group = groups.get(unit) || { unit, orderedQuantity: 0, deliveredQuantity: 0 };
    group.orderedQuantity += ordered;
    groups.set(unit, group);
  }
  const seen = new Set();
  let tripCount = 0;
  for (const trip of deliveries) {
    if (String(trip.purchaseOrderId || '') !== String(po.id) || trip.isBackorder) continue;
    if (!['COMPLETED', 'SITE_WEIGHED_OUT'].includes(normalizeJobStatus(trip.status))) continue;
    const id = trip.id || trip.jobId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tripCount += 1;
    if (trip.isWarehouseDelivery || trip.deliveryOrigin === 'warehouse') {
      for (const receipt of trip.materialInspection?.materialReceipts || []) {
        const group = groups.get(unitKey(receipt.unit || trip.unit));
        if (group) group.deliveredQuantity += quantity(receipt.receivedQuantity) || 0;
      }
      continue;
    }
    const weightIn = quantity(trip.siteWeighInWeight);
    const weightOut = quantity(trip.siteWeighOutWeight);
    const delivered = quantity(trip.siteNetWeight)
      ?? (weightIn != null && weightOut != null ? Math.max(0, weightIn - weightOut) : null)
      ?? quantity(trip.quantityDelivered);
    // Quarry weights and ordered quantities are not proof of site delivery.
    const group = groups.get(unitKey(trip.unit));
    if (group && delivered != null) group.deliveredQuantity += delivered;
  }
  const totals = [...groups.values()].map((group) => {
    const orderedQuantity = round(group.orderedQuantity);
    const deliveredQuantity = round(group.deliveredQuantity);
    const variance = round(deliveredQuantity - orderedQuantity);
    return { unit: group.unit, orderedQuantity, deliveredQuantity, variance, overDelivered: variance > 0 };
  });
  return { tripCount, totals, overDelivered: totals.some((group) => group.overDelivered) };
}

module.exports = { buildDeliverySummary };

function isWarehouseReceipt(job) {
  return Boolean(job?.isWarehouseDelivery) || [job?.deliveryOrigin, job?.materialSource].some((value) => String(value || '').trim().toLowerCase() === 'warehouse');
}
function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}
function acceptanceUpdates(job, actor, now = new Date().toISOString()) {
  if (String(actor?.role || '').toLowerCase() === 'storeman') throw conflict('The site operator must accept or deny this shipment before store receiving.', 'SITE_OPERATOR_REQUIRED');
  if (!isWarehouseReceipt(job)) throw conflict('Only warehouse deliveries use acceptance.', 'WAREHOUSE_DELIVERY_REQUIRED');
  if (job.warehouseDeniedAt) throw conflict('This warehouse delivery was denied.', 'WAREHOUSE_DELIVERY_DENIED');
  if (job.warehouseAcceptedAt) return null;
  if (!['DISPATCHED', 'IN_TRANSIT', 'ARRIVED_AT_SITE', 'SITE_WEIGHED_IN', 'SITE_IN', 'WEIGHED_IN'].includes(String(job.status).toUpperCase())) throw conflict('This delivery is not awaiting site acceptance.', 'WAREHOUSE_NOT_AWAITING_ACCEPTANCE');
  if (job.securityFlag?.status === 'flagged' || job.isFlagged === true) throw conflict('Clear the delivery flag before acceptance.', 'SECURITY_FLAG_UNRESOLVED');
  return {
    warehouseAcceptedAt: now, warehouseAcceptedByUid: actor.uid || '',
    warehouseAcceptedByName: actor.displayName || actor.email || '', siteId: job.siteId || actor.siteId || '',
    status: 'ARRIVED_AT_SITE', workflowStage: 'awaiting_inspection', currentStage: 'inspection', updatedAt: now,
  };
}
function denialUpdates(job, actor, reason, now = new Date().toISOString()) {
  if (!String(reason || '').trim()) throw Object.assign(new Error('A denial reason is required.'), { statusCode: 400 });
  if (job.warehouseAcceptedAt || job.warehouseDeniedAt) throw conflict('This delivery already has a site decision.', 'WAREHOUSE_ALREADY_DECIDED');
  acceptanceUpdates(job, actor, now);
  return { warehouseDeniedAt: now, warehouseDeniedByUid: actor.uid || '', warehouseDeniedByName: actor.displayName || actor.email || '', warehouseDenialReason: reason.trim(), status: 'CANCELLED', workflowStage: 'denied', updatedAt: now };
}
function validateWarehouseUpdate(job, data) {
  if (!isWarehouseReceipt(job)) return;
  const weightFields = ['siteWeighInWeight', 'siteWeighOutWeight', 'siteArrivalWeight', 'siteNetWeight'];
  if (weightFields.some((key) => data[key] != null)) {
    if (job.warehouseDeniedAt || ['CANCELLED', 'COMPLETED', 'SITE_WEIGHED_OUT'].includes(String(job.status).toUpperCase()) || job.materialInspection?.mrfNumber) throw conflict('This warehouse delivery is no longer awaiting weighing.', 'WAREHOUSE_WEIGHING_CLOSED');
    if (job.securityFlag?.status === 'flagged' || job.isFlagged) throw conflict('Clear the delivery flag before weighing.', 'SECURITY_FLAG_UNRESOLVED');
    if (weightFields.some((key) => data[key] != null && (!String(data[key]).trim() || !Number.isFinite(Number(data[key])) || Number(data[key]) <= 0))) throw conflict('Enter valid positive site weights.', 'INVALID_SITE_WEIGHT');
    if (data.siteWeighOutWeight != null) {
      const arrival = Number(job.siteWeighInWeight ?? job.siteArrivalWeight);
      if (!Number.isFinite(arrival) || arrival <= 0) throw conflict('Record site weigh-in before weigh-out.', 'SITE_WEIGH_IN_REQUIRED');
      if (Number(data.siteWeighOutWeight) >= arrival) throw conflict('Weigh-out must be less than weigh-in.', 'INVALID_SITE_WEIGHT');
    }
  }
  if (data.materialInspection && !job.warehouseAcceptedAt) throw conflict('Accept the warehouse delivery at site before inspection.', 'WAREHOUSE_ACCEPTANCE_REQUIRED');
  if (data.materialInspection && (job.siteWeighInWeight != null || job.siteArrivalWeight != null) && job.siteWeighOutWeight == null) throw conflict('Complete site weigh-out before inspecting this shipment.', 'SITE_WEIGH_OUT_REQUIRED');
}
function warehouseWeighOutUpdates(job, data, now = new Date().toISOString()) {
  if (!isWarehouseReceipt(job) || data.siteWeighOutWeight == null) return {};
  return {
    siteNetWeight: Number(job.siteWeighInWeight ?? job.siteArrivalWeight) - Number(data.siteWeighOutWeight),
    warehouseAcceptedAt: job.warehouseAcceptedAt || now,
    warehouseAcceptedByUid: job.warehouseAcceptedByUid || data.siteWeighOutByUid || '',
    warehouseAcceptedByName: job.warehouseAcceptedByName || data.siteWeighOutByName || data.receivedBy || '',
    status: 'SITE_WEIGHED_OUT', workflowStage: 'awaiting_inspection', currentStage: 'inspection',
  };
}
module.exports = { isWarehouseReceipt, acceptanceUpdates, denialUpdates, validateWarehouseUpdate, warehouseWeighOutUpdates };

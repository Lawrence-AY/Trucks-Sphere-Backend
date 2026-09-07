function isWarehouseReceipt(job) {
  return Boolean(job?.isWarehouseDelivery) || [job?.deliveryOrigin, job?.materialSource].some((value) => String(value || '').trim().toLowerCase() === 'warehouse');
}
function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}
function acceptanceUpdates(job, actor, now = new Date().toISOString()) {
  if (!isWarehouseReceipt(job)) throw conflict('Only warehouse deliveries use acceptance.', 'WAREHOUSE_DELIVERY_REQUIRED');
  if (job.warehouseDeniedAt) throw conflict('This warehouse delivery was denied.', 'WAREHOUSE_DELIVERY_DENIED');
  if (job.warehouseAcceptedAt) return null;
  if (!['DISPATCHED', 'IN_TRANSIT', 'ARRIVED_AT_SITE', 'SITE_WEIGHED_IN', 'SITE_IN', 'WEIGHED_IN'].includes(String(job.status).toUpperCase())) throw conflict('This delivery is not awaiting site acceptance.', 'WAREHOUSE_NOT_AWAITING_ACCEPTANCE');
  if (job.securityFlag?.status === 'flagged' || job.isFlagged === true) throw conflict('Clear the delivery flag before acceptance.', 'SECURITY_FLAG_UNRESOLVED');
  if (!job.packagingPhotoURL) throw conflict('Upload the packaging photo before acceptance.', 'WAREHOUSE_PHOTO_REQUIRED');
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
  const weightFields = ['siteWeighInWeight', 'siteWeighOutWeight', 'siteArrivalWeight', 'siteNetWeight', 'weighInWeight', 'weighOutWeight', 'netWeight'];
  if (weightFields.some((key) => data[key] != null)) throw conflict('Warehouse deliveries use acceptance and inspection, without weighing.', 'WAREHOUSE_WEIGHING_NOT_APPLICABLE');
  if (data.materialInspection && !job.warehouseAcceptedAt) throw conflict('Accept the warehouse delivery at site before inspection.', 'WAREHOUSE_ACCEPTANCE_REQUIRED');
}
module.exports = { isWarehouseReceipt, acceptanceUpdates, denialUpdates, validateWarehouseUpdate };

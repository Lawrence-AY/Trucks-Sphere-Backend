//backorder.js
const { JOB_STATUS, normalizeJobStatus, TERMINAL_STATUSES } = require('../../utils/jobLifecycle');

const SHORTFALL_EPSILON = 0.001;
const SITE_COMPLETION_STATUSES = new Set([JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED]);

function isBackorderCreationEnabled() {
  return String(process.env.BACKORDERS_ENABLED || '').trim().toLowerCase() === 'true';
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

/**
 * Return the shortfall to schedule after a site finalization, or null when no
 * back order should be created. A terminal job can never create a second
 * back order, making retries and later metadata edits safe.
 */
function planSiteNetBackorder(existing = {}, updates = {}) {
  const previousStatus = normalizeJobStatus(existing.status);
  const nextStatus = normalizeJobStatus(updates.status, previousStatus);
  if (TERMINAL_STATUSES.has(previousStatus) || !SITE_COMPLETION_STATUSES.has(nextStatus)) {
    return null;
  }

  const orderedQuantity = firstFinite(
    existing.quantityOrdered,
    existing.quantity,
    updates.quantityOrdered,
  );
  const deliveredQuantity = firstFinite(
    updates.quantityDelivered,
    updates.siteNetWeight,
    updates.netWeight,
    existing.quantityDelivered,
    existing.siteNetWeight,
    existing.netWeight,
  );

  if (orderedQuantity === null || deliveredQuantity === null || orderedQuantity <= 0) {
    return null;
  }

  const remainingQuantity = orderedQuantity - deliveredQuantity;
  if (remainingQuantity <= SHORTFALL_EPSILON) return null;

  return {
    orderedQuantity,
    deliveredQuantity: Math.max(0, deliveredQuantity),
    remainingQuantity,
  };
}

function deriveBackorderJobKey(source = {}) {
  const currentKey = String(source.jobKey || source.jobId || '').trim();
  const strippedKey = currentKey
    .replace(/\/J\d+(-\w+)?$/, '')
    .replace(/-\w+$/, '');
  if (strippedKey) return strippedKey;

  return `${String(source.poNumber || source.purchaseOrderId || 'BACKORDER').trim()}/BO`;
}

/**
 * Build an unassigned backorder for a shortfall. It is deliberately not a
 * truck job yet: dispatch must choose a driver and vehicle before creating a
 * new job number for the next trip.
 */
function buildBackorder({ source, plan, id, now }) {
  const rootDeliveryOrderId = source.rootDeliveryOrderId || source.backorderOfDeliveryOrderId || source.id;

  return {
    id,
    jobId: '',
    jobKey: '',
    purchaseOrderId: source.purchaseOrderId || '',
    poNumber: source.poNumber || '',
    vendorId: source.vendorId || '',
    vendorName: source.vendorName || '',
    companyName: source.companyName || '',
    materialId: source.materialId || '',
    materialName: source.materialName || '',
    materialSource: source.materialSource || null,
    quantityOrdered: plan.remainingQuantity,
    quantityDispatched: 0,
    quantityDelivered: 0,
    remainingQuantity: plan.remainingQuantity,
    unit: source.unit || 'units',
    quarryId: source.quarryId || '',
    quarryName: source.quarryName || '',
    siteId: source.siteId || '',
    siteName: source.siteName || '',
    // A backorder must never inherit the completed trip's driver or truck.
    // It awaits a fresh dispatch assignment and job-number allocation.
    driverId: '',
    driverName: '',
    driverPhotoURL: '',
    licenseNumber: '',
    vehicleId: '',
    plateNumber: '',
    status: JOB_STATUS.CREATED,
    isBackorder: true,
    backorderOfDeliveryOrderId: source.id,
    backorderOfJobId: source.jobId || '',
    rootDeliveryOrderId,
    backorderDepth: Number(source.backorderDepth || 0) + 1,
    sourceOrderedQuantity: plan.orderedQuantity,
    sourceDeliveredQuantity: plan.deliveredQuantity,
    createdBy: 'site_net_backorder',
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = {
  SHORTFALL_EPSILON,
  isBackorderCreationEnabled,
  planSiteNetBackorder,
  deriveBackorderJobKey,
  buildBackorder,
};

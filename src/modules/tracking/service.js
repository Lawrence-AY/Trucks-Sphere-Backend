/**
 * Public Tracking Service
 *
 * Handles retrieval of delivery order data for public tracking pages.
 * Only returns data for jobs that are in-transit (active tracking state).
 */

const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { isTrackableJob, normalizeJobStatus } = require('../../utils/jobLifecycle');
const { isWarehouseReceipt } = require('../warehouse-jobs/receipt');
const { generateDeterministicTrackingId } = require('../../utils/trackingUtils');

const COLLECTION_NAME = 'deliveryOrders';

function trackingOrders() {
  const shipments = snapshotStore.getAll('warehouseJobs');
  const byId = new Map(shipments.map(item => [item.id, item]));
  const byDelivery = new Map(shipments.filter(item => item.deliveryOrderId).map(item => [item.deliveryOrderId, item]));
  return snapshotStore.getAll(COLLECTION_NAME).map((order) => {
    const shipment = byId.get(order.warehouseJobId) || byDelivery.get(order.id) || byId.get(order.id);
    if (!shipment && !isWarehouseReceipt(order)) return order;
    return {
      ...order,
      isWarehouseDelivery: true,
      deliveryOrigin: 'warehouse',
      plateNumber: order.plateNumber || shipment?.plateNumber || '',
      driverName: order.driverName || shipment?.driverName || '',
      packagingPhotoURL: order.packagingPhotoURL || shipment?.packagingPhotoURL || null,
      materials: order.materials?.length ? order.materials : shipment?.items || [],
      dispatchedAt: order.dispatchedAt || order.dispatchedToSiteAt || shipment?.dispatchedToSiteAt || shipment?.submittedAt || order.createdAt,
      trackingId: order.trackingId || shipment?.trackingId || generateDeterministicTrackingId(order.id),
    };
  });
}

function isTrackingActive(order) {
  if (isWarehouseReceipt(order) && (order.warehouseAcceptedAt || order.warehouseDeniedAt || order.materialInspection?.mrfNumber)) return false;
  return isTrackableJob(order.status);
}

/**
 * Look up a delivery order by its tracking ID.
 * Only returns the order if it is in an active (in-transit) state.
 *
 * Active states: dispatched, in_transit, en_route
 * Inactive states: assigned, site weighed-in, delivered, completed, cancelled, awaiting_site_weights
 *
 * @param {string} trackingId - e.g., "SA-A1B3C5D"
 * @returns {object|null} The delivery order with tracking-relevant fields, or null
 */
function findByTrackingId(trackingId) {
  if (!trackingId) return null;

  const allOrders = trackingOrders();
  const order = allOrders.find(
    (doc) => doc.trackingId === trackingId
  );

  if (!order) return null;

  // Only allow tracking if the job is in-transit (active tracking state).
  // 'loaded' is set after quarry weigh-out — this is when the truck departs.
  if (!isTrackingActive(order)) {
    return null; // tracking expired
  }

  return order;
}

/**
 * Gets active tracking-relevant data from a delivery order.
 * Strips sensitive/internal fields before exposing to the public.
 *
 * @param {object} order - The raw delivery order document
 * @returns {object} Sanitized public tracking data
 */
function sanitizeForPublic(order) {
  // Look up driver for nationalId
  let driverNationalId = order.driverNationalId || null;
  if (!driverNationalId && order.driverId) {
    const driver = snapshotStore.getById('drivers', order.driverId);
    if (driver) {
      driverNationalId = driver.nationalId || null;
    }
  }

  return {
    isWarehouseDelivery: isWarehouseReceipt(order),
    deliveryOrigin: isWarehouseReceipt(order) ? 'warehouse' : order.deliveryOrigin,
    trackingId: order.trackingId,
    jobId: order.jobId,
    purchaseOrderId: order.purchaseOrderId,
    poNumber: order.poNumber,
    // Logistics
    vendorName: order.vendorName,
    plateNumber: order.plateNumber,
    driverName: order.driverName,
    driverNationalId,
    // Cargo
    materialName: order.materialName,
    materialId: order.materialId,
    // The PO can contain several materials. Quantities are intentionally not
    // exposed here because the actual dispatched load may differ from the PO.
    materials: (() => {
      const po = snapshotStore.getById('purchaseOrders', order.purchaseOrderId);
      const lines = isWarehouseReceipt(order) && order.materials?.length ? order.materials : Array.isArray(po?.materials) && po.materials.length
        ? po.materials
        : [{ materialId: order.materialId, materialName: order.materialName }];
      return lines.map((line) => ({
        materialId: line.materialId || '',
        materialName: line.materialName || line.name || '',
      })).filter((line) => line.materialName);
    })(),
    securityFlag: order.securityFlag?.status === 'flagged' ? {
      status: 'flagged', reason: order.securityFlag.reason || '', flaggedAt: order.securityFlag.flaggedAt || '',
    } : null,
    // Quarry dispatch proof
    quarryName: order.quarryName,
    quarryId: order.quarryId,
    weighOutWeight: order.weighOutWeight,
    weighInWeight: order.weighInWeight,
    netWeight: order.netWeight,
    weighOutLocation: order.weighOutLocation || null,
    weighOutAt: order.weighOutAt,
    weighOutPhotoURL: order.weighOutPhotoURL || null,
    // Geo-location from weigh-out (includes address with city/town)
    weighOutGeoLocation: order.weighOutGeoLocation || null,
    weighOutCoordinates: order.weighOutCoordinates || null,
    weighInLocation: order.weighInLocation || null,
    // Dispatch verification photo (driver photo at weigh-out)
    driverPhotoURL: order.driverPhotoURL || null,
    dispatchProofPhotoURL: isWarehouseReceipt(order) ? order.packagingPhotoURL || null : order.driverPhotoURL || order.weighOutPhotoURL || null,
    // Timestamps
    createdAt: order.createdAt,
    dispatchedAt: order.weighOutAt || order.dispatchedAt || order.dispatchedToSiteAt || order.warehouseSubmittedAt || null,
    status: order.status,
    // Destination info (non-sensitive)
    siteName: order.siteName,
    materialSource: isWarehouseReceipt(order) ? (order.materialSource || 'Warehouse') : order.materialSource,
  };
}

/**
 * Look up an active delivery order by vehicle plate number.
 * Only returns the order if it is in an active (in-transit) state.
 */
function findByPlate(plateNumber) {
  if (!plateNumber) return null;

  const allOrders = trackingOrders();

  // decodeURIComponent is necessary when a direct mobile/web request has
  // left %20 in the route parameter. Remove all whitespace and separators
  // so "KCD 123 A", "KCD%20123%20A" and "kcd-123-a" match one record.
  const normalizePlate = (value) => {
    let decoded = String(value || '');
    try { decoded = decodeURIComponent(decoded.replace(/\+/g, ' ')); } catch {}
    return decoded.toUpperCase().replace(/[\s-]+/g, '');
  };
  const normalizedPlate = normalizePlate(plateNumber);

  // Filter to only active-status orders FIRST, then find by plate.
  // Previously the code used .find() which returns the first matching
  // plate regardless of status. If an older completed delivery had the
  // same plate number, it would match first, fail the status check,
  // and return null — never finding the active delivery.
  const dispatchTime = (doc) => Date.parse(doc.weighOutAt || doc.dispatchedAt || doc.dispatchedToSiteAt || doc.createdAt || '') || 0;
  const activeOrders = allOrders.filter(isTrackingActive).sort((a, b) => dispatchTime(b) - dispatchTime(a));

  const order = activeOrders.find((doc) => {
    const docPlate = normalizePlate(doc.plateNumber);
    return docPlate === normalizedPlate;
  });

  if (!order) {
    console.log('[Tracking] by-plate miss', {
      originalPlate: plateNumber,
      normalizedPlate,
      recordsChecked: allOrders.length,
      activeRecordsChecked: activeOrders.length,
      statusesFound: [...new Set(allOrders.map((doc) => normalizeJobStatus(doc.status)))],
    });
    return null;
  }

  console.log('[Tracking] by-plate hit', { originalPlate: plateNumber, normalizedPlate, recordId: order.id, status: normalizeJobStatus(order.status) });
  return order;
}

module.exports = {
  findByTrackingId,
  findByPlate,
  sanitizeForPublic,
};

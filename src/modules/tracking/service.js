/**
 * Public Tracking Service
 *
 * Handles retrieval of delivery order data for public tracking pages.
 * Only returns data for jobs that are in-transit (active tracking state).
 */

const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');

const COLLECTION_NAME = 'deliveryOrders';

/**
 * Look up a delivery order by its tracking ID.
 * Only returns the order if it is in an active (in-transit) state.
 *
 * Active states: dispatched, in_transit, en_route
 * Inactive states: assigned, arrived, weighed_in, delivered, completed, cancelled, awaiting_site_weights
 *
 * @param {string} trackingId - e.g., "SA-A1B3C5D"
 * @returns {object|null} The delivery order with tracking-relevant fields, or null
 */
function findByTrackingId(trackingId) {
  if (!trackingId) return null;

  const allOrders = snapshotStore.getAll(COLLECTION_NAME);
  const order = allOrders.find(
    (doc) => doc.trackingId === trackingId
  );

  if (!order) return null;

  // Only allow tracking if the job is in-transit (active tracking state).
  // 'loaded' is set after quarry weigh-out — this is when the truck departs.
  const activeStatuses = ['loaded', 'dispatched', 'in_transit', 'en_route'];
  if (!activeStatuses.includes(order.status)) {
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
  return {
    trackingId: order.trackingId,
    jobId: order.jobId,
    purchaseOrderId: order.purchaseOrderId,
    poNumber: order.poNumber,
    // Logistics
    vendorName: order.vendorName,
    plateNumber: order.plateNumber,
    driverName: order.driverName,
    // Cargo
    materialName: order.materialName,
    materialId: order.materialId,
    quantityOrdered: order.quantityOrdered,
    // Quarry dispatch proof
    quarryName: order.quarryName,
    quarryId: order.quarryId,
    weighOutWeight: order.weighOutWeight,
    weighInWeight: order.weighInWeight,
    netWeight: order.netWeight,
    weighOutAt: order.weighOutAt,
    weighOutPhotoURL: order.weighOutPhotoURL || null,
    weighOutCoordinates: order.weighOutCoordinates || null,
    // Dispatch verification photo (driver photo at weigh-out)
    driverPhotoURL: order.driverPhotoURL || null,
    // Timestamps
    createdAt: order.createdAt,
    dispatchedAt: order.weighOutAt || order.dispatchedAt || null,
    status: order.status,
    // Destination info (non-sensitive)
    siteName: order.siteName,
    materialSource: order.materialSource,
  };
}

module.exports = {
  findByTrackingId,
  sanitizeForPublic,
};
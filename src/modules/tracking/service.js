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
  // Look up driver for nationalId
  let driverNationalId = order.driverNationalId || null;
  if (!driverNationalId && order.driverId) {
    const driver = snapshotStore.getById('drivers', order.driverId);
    if (driver) {
      driverNationalId = driver.nationalId || null;
    }
  }

  return {
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
    quantityOrdered: order.quantityOrdered,
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
    // Timestamps
    createdAt: order.createdAt,
    dispatchedAt: order.weighOutAt || order.dispatchedAt || null,
    status: order.status,
    // Destination info (non-sensitive)
    siteName: order.siteName,
    materialSource: order.materialSource,
  };
}

/**
 * Look up an active delivery order by vehicle plate number.
 * Only returns the order if it is in an active (in-transit) state.
 */
function findByPlate(plateNumber) {
  if (!plateNumber) return null;

  const activeStatuses = ['loaded', 'dispatched', 'in_transit', 'en_route'];
  const allOrders = snapshotStore.getAll(COLLECTION_NAME);

  // Normalize the input plate: trim, uppercase, collapse whitespace
  const normalizedPlate = plateNumber.trim().toUpperCase().replace(/\s+/g, '');

  // Filter to only active-status orders FIRST, then find by plate.
  // Previously the code used .find() which returns the first matching
  // plate regardless of status. If an older completed delivery had the
  // same plate number, it would match first, fail the status check,
  // and return null — never finding the active delivery.
  const activeOrders = allOrders.filter((doc) =>
    activeStatuses.includes(doc.status)
  );

  const order = activeOrders.find((doc) => {
    const docPlate = (doc.plateNumber || '').toUpperCase().replace(/\s+/g, '');
    return docPlate === normalizedPlate;
  });

  if (!order) {
    console.log(`[Tracking] findByPlate: No active delivery found for plate "${normalizedPlate}" (searched ${activeOrders.length} active orders out of ${allOrders.length} total)`);
    return null;
  }

  console.log(`[Tracking] findByPlate: Found active delivery ${order.id} (status: ${order.status}) for plate "${normalizedPlate}"`);
  return order;
}

module.exports = {
  findByTrackingId,
  findByPlate,
  sanitizeForPublic,
};

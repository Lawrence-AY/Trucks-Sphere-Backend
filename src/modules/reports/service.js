/**
 * Reports Service — Data Aggregator
 *
 * Reads all data from the in-memory snapshot store (zero Firestore reads).
 * Aggregates across deliveryOrders, vendors, drivers, vehicles, fuelRecords,
 * purchaseOrders, and materials for the admin reporting dashboard and Excel export.
 */

const snapshotStore = require('../../utils/snapshotStore');

/**
 * Format an ISO date string to East African Time (EAT = UTC+3).
 * Returns a human-readable string like "15/Jul/2026, 14:30" or empty string if invalid.
 */
function formatEAT(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-KE', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Nairobi',
      hour12: false,
    });
  } catch {
    return isoStr;
  }
}

/**
 * Apply timeframe filter to a date value.
 * @param {string} dateStr - ISO date string
 * @param {object} options
 * @param {string} [options.filter] - 'day' | 'week' | 'month'
 * @param {string} [options.startDate] - YYYY-MM-DD
 * @param {string} [options.endDate] - YYYY-MM-DD
 * @returns {boolean}
 */
function withinTimeframe(dateStr, options) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (options.filter) {
    case 'day':
      return d >= todayStart;
    case 'week': {
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
      return d >= weekStart;
    }
    case 'month': {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return d >= monthStart;
    }
    case 'custom': {
      if (options.startDate && d < new Date(options.startDate + 'T00:00:00')) return false;
      if (options.endDate && d > new Date(options.endDate + 'T23:59:59')) return false;
      return true;
    }
    default:
      return true;
  }
}

/**
 * Get all deliveries filtered by timeframe.
 */
function getDeliveries(options = {}) {
  const all = snapshotStore.getAll('deliveryOrders');
  if (!options.filter && !options.startDate) return all;
  return all.filter((d) => withinTimeframe(d.createdAt || d.updatedAt, options));
}

/**
 * Get fuel records filtered by timeframe.
 */
function getFuelRecords(options = {}) {
  const all = snapshotStore.getAll('fuelRecords');
  if (!options.filter && !options.startDate) return all;
  return all.filter((r) => withinTimeframe(r.createdAt || r.timestamp, options));
}

/**
 * Build a lookup map from an array of docs.
 */
function buildMap(docs, key = 'id') {
  const map = {};
  (docs || []).forEach((d) => { if (d[key]) map[d[key]] = d; });
  return map;
}

/**
 * Check if an insurance date is expired or expiring within 30 days.
 */
function insuranceStatus(expiryStr) {
  if (!expiryStr) return 'unknown';
  const expiry = new Date(expiryStr);
  if (isNaN(expiry.getTime())) return 'unknown';
  const now = new Date();
  const thirtyDays = new Date();
  thirtyDays.setDate(thirtyDays.getDate() + 30);
  if (expiry < now) return 'expired';
  if (expiry < thirtyDays) return 'expiring_soon';
  return 'valid';
}

/**
 * Compute cycle time (days) between two dates.
 */
function cycleDays(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(startStr);
  const end = new Date(endStr);
  const diff = end - start;
  return Math.round((diff / (1000 * 60 * 60 * 24)) * 10) / 10;
}

/**
 * Compute hours between two dates.
 */
function cycleHours(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(startStr);
  const end = new Date(endStr);
  const diff = end - start;
  return Math.round((diff / (1000 * 60 * 60)) * 10) / 10;
}

/**
 * ─── Master Audit: flattened delivery + all joins ───
 */
function buildMasterAudit(options = {}) {
  const deliveries = getDeliveries(options);
  const vendors = buildMap(snapshotStore.getAll('vendors'));
  const drivers = buildMap(snapshotStore.getAll('drivers'));
  const vehicles = buildMap(snapshotStore.getAll('vehicles'));
  const pos = buildMap(snapshotStore.getAll('purchaseOrders'));
  const materials = buildMap(snapshotStore.getAll('materials'));
  const allFuel = snapshotStore.getAll('fuelRecords');

  return deliveries.map((d) => {
    const vendor = vendors[d.vendorId] || {};
    const driver = drivers[d.driverId] || {};
    const vehicle = vehicles[d.vehicleId] || {};
    const po = pos[d.purchaseOrderId] || {};
    const material = materials[d.materialId] || {};

    // Fuel for this job
    const jobFuel = allFuel.filter((f) => f.jobId === d.jobId);
    const totalFuelLitres = jobFuel.reduce((sum, f) => sum + (Number(f.litres) || 0), 0);

    const quarryNet = Number(d.weighOutWeight || d.netWeight || 0) - Number(d.weighInWeight || 0);
    const siteNet = Number(d.siteNetWeight || d.netWeight || 0);
    const quarryTotal = Number(d.weighOutWeight || d.netWeight || 0);
    const siteTotal = Number(d.siteWeighInWeight || 0);

    return {
      // Order
      jobId: d.jobId || '',
      poNumber: d.poNumber || po.poNumber || '',
      jobStatus: d.status || '',
      // PO details
      poQuantity: Number(po.quantity || 0),
      // Vendor
      vendorName: d.vendorName || vendor.companyName || '',
      // Driver
      driverName: d.driverName || driver.name || driver.fullName || '',
      driverLicense: driver.licenseNumber || '',
      // Truck
      plateNumber: d.plateNumber || vehicle.plateNumber || vehicle.plate || '',
      truckMake: vehicle.make || '',
      truckModel: vehicle.model || '',
      // Material
      materialName: d.materialName || material.name || '',
      materialSource: d.materialSource || d.weighOutLocation || (d.quarryName || ''),
      // Quantities
      quantityOrdered: Number(d.quantityOrdered || po.quantity || 0),
      quantityDelivered: Number(d.netWeight || d.quantityDelivered || 0),
      // Lifecycle Timestamps (raw ISO)
      quarryInTime: d.weighInAt || '',
      quarryOutTime: d.weighOutAt || '',
      siteInTime: d.siteWeighInAt || '',
      siteOutTime: d.siteWeighOutAt || '',
      // Lifecycle Timestamps (EAT formatted — East African Time, UTC+3)
      quarryInTimeEAT: formatEAT(d.weighInAt),
      quarryOutTimeEAT: formatEAT(d.weighOutAt),
      siteInTimeEAT: formatEAT(d.siteWeighInAt),
      siteOutTimeEAT: formatEAT(d.siteWeighOutAt),
      assignedTimeEAT: formatEAT(d.createdAt),
      completedTimeEAT: formatEAT(d.completedAt || d.updatedAt),
      // Weights
      quarryWeighIn: Number(d.weighInWeight || 0),
      quarryWeighOut: Number(d.weighOutWeight || 0),
      netWeight: Number(d.netWeight || 0),
      siteWeighIn: Number(d.siteWeighInWeight || 0),
      siteWeighOut: Number(d.siteWeighOutWeight || 0),
      quarryNet: quarryNet > 0 ? quarryNet : Number(d.netWeight || 0),
      siteNet: siteNet > 0 ? siteNet : Number(d.netWeight || 0),
      quarryTotal: quarryTotal > 0 ? quarryTotal : Number(d.quarryWeighOut || d.netWeight || 0),
      siteTotal: siteTotal > 0 ? siteTotal : Number(d.siteWeighInWeight || 0),
      // Fuel
      totalFuelLitres,
      fuelOTP: jobFuel.length > 0 ? (jobFuel[0].otp || jobFuel[0].authorizationCode || '') : '',
      fuelAttendant: jobFuel.length > 0 ? (jobFuel[0].attendantName || jobFuel[0].dispensedBy || jobFuel[0].dispensedByName || '') : '',
      // Lot & GRN
      lotNumber: d.storageLot || d.lotNumber || '',
      grnNumber: d.receiptNoteId || d.grnNumber || '',
      // System accountability
      operatorUsername: d.createdBy || d.operatorUsername || '',
      creationLocation: d.weighInLocation || d.weighOutLocation || d.receivedLocation || '',
      geolocation: d.weighOutGeoLocation ? `${d.weighOutGeoLocation.latitude},${d.weighOutGeoLocation.longitude}` : '',
      // Tracking
      trackingId: d.trackingId || '',
    };
  });
}

/**
 * ─── Driver Report ───
 */
function buildDriverReport() {
  const driverDocs = snapshotStore.getAll('drivers');
  const vendors = buildMap(snapshotStore.getAll('vendors'));

  return driverDocs.map((d) => ({
    driverName: d.name || d.fullName || '',
    licenseNumber: d.licenseNumber || '',
    ntsaStatus: d.ntsaStatus || 'Not Verified',
    insuranceProvider: d.insuranceProvider || '',
    insurancePolicyNo: d.insurancePolicyNo || '',
    insuranceExpiry: d.insuranceExpiry || '',
    insuranceStatus: insuranceStatus(d.insuranceExpiry),
    vendorName: vendors[d.vendorId]?.companyName || d.vendorName || '',
    phone: d.phone || '',
    status: d.status || '',
  }));
}

/**
 * ─── Materials Report ───
 */
function buildMaterialReport() {
  const matDocs = snapshotStore.getAll('materials');
  const deliveries = snapshotStore.getAll('deliveryOrders');

  return matDocs.map((m) => {
    const matDeliveries = deliveries.filter((d) => d.materialId === m.id);
    const totalDelivered = matDeliveries.reduce((sum, d) => sum + (Number(d.netWeight) || Number(d.quantityDelivered) || 0), 0);

    return {
      materialName: m.name || '',
      category: m.category || '',
      sizes: m.sizes || m.grade || '',
      unit: m.unit || 'Tonnes',
      totalDelivered,
      deliveryCount: matDeliveries.length,
    };
  });
}

/**
 * ─── Fuel Report ───
 */
function buildFuelReport(options = {}) {
  const records = getFuelRecords(options);
  const vendors = buildMap(snapshotStore.getAll('vendors'));

  return records.map((r) => ({
    transactionDate: r.createdAt || r.timestamp || '',
    driverName: r.driverName || '',
    plateNumber: r.plateNumber || '',
    litres: Number(r.litres || 0),
    attendantName: r.attendantName || r.dispensedBy || '',
    otp: r.otp || r.otpCode || '',
    authorizingVendor: vendors[r.vendorId]?.companyName || r.vendorName || '',
    jobId: r.jobId || '',
    fuelStation: r.fuelStation || r.location || '',
  }));
}

/**
 * ─── Truck Report ───
 */
function buildTruckReport() {
  const vehicleDocs = snapshotStore.getAll('vehicles');
  const vendors = buildMap(snapshotStore.getAll('vendors'));

  return vehicleDocs.map((v) => ({
    plateNumber: v.plateNumber || v.plate || '',
    make: v.make || '',
    model: v.model || '',
    capacity: v.capacity || '',
    ntsaStatus: v.ntsaStatus || 'Not Verified',
    insuranceProvider: v.insuranceProvider || '',
    insurancePolicyNo: v.insurancePolicyNo || '',
    insuranceExpiry: v.insuranceExpiry || '',
    insuranceStatus: insuranceStatus(v.insuranceExpiry),
    vendorName: vendors[v.vendorId]?.companyName || '',
    status: v.status || '',
  }));
}

/**
 * ─── Vendor Report ───
 */
function buildVendorReport(options = {}) {
  const vendorDocs = snapshotStore.getAll('vendors');
  const deliveries = getDeliveries(options);
  const pos = snapshotStore.getAll('purchaseOrders');

  return vendorDocs.map((v) => {
    const vendorDeliveries = deliveries.filter((d) => d.vendorId === v.id);
    const vendorPOs = pos.filter((p) => p.vendorId === v.id);
    const materialTypes = [...new Set(vendorDeliveries.map((d) => d.materialName).filter(Boolean))];
    const totalTonnage = vendorDeliveries.reduce((sum, d) => sum + (Number(d.netWeight) || Number(d.quantityDelivered) || 0), 0);

    return {
      vendorName: v.companyName || '',
      activePOs: vendorPOs.filter((p) => ['approved', 'in_progress', 'pending'].includes(p.status)).length,
      fulfilledPOs: vendorPOs.filter((p) => p.status === 'completed' || p.status === 'delivered').length,
      totalPOs: vendorPOs.length,
      materialTypes: materialTypes.join(', '),
      materialCount: materialTypes.length,
      totalDelivered: totalTonnage,
      deliveryCount: vendorDeliveries.length,
      status: v.status || '',
    };
  });
}

/**
 * ─── Purchase Order Report ───
 */
function buildPOReport(options = {}) {
  const poDocs = snapshotStore.getAll('purchaseOrders');
  const deliveries = getDeliveries(options);

  return poDocs.map((po) => {
    const poDeliveries = deliveries.filter((d) => d.purchaseOrderId === po.id);
    const deliveredQty = poDeliveries.reduce((sum, d) => sum + (Number(d.netWeight) || Number(d.quantityDelivered) || 0), 0);
    const targetQty = Number(po.quantity || 0);
    const progress = targetQty > 0 ? Math.min(100, Math.round((deliveredQty / targetQty) * 100)) : 0;

    return {
      poNumber: po.poNumber || '',
      vendorName: po.vendorName || '',
      materialName: po.materialName || '',
      targetQuantity: targetQty,
      deliveredQuantity: deliveredQty,
      remainingQuantity: Math.max(0, targetQty - deliveredQty),
      progressPercent: progress,
      status: po.status || '',
      deliveryCount: poDeliveries.length,
      createdAt: po.createdAt || '',
    };
  });
}

/**
 * ─── Summary Metrics ───
 */
function buildSummary(options = {}) {
  const deliveries = getDeliveries(options);
  const fuelRecords = getFuelRecords(options);
  const vendors = snapshotStore.getAll('vendors');
  const drivers = snapshotStore.getAll('drivers');
  const vehicles = snapshotStore.getAll('vehicles');
  const materials = snapshotStore.getAll('materials');
  const pos = snapshotStore.getAll('purchaseOrders');

  const totalTonnage = deliveries.reduce((sum, d) => sum + (Number(d.netWeight) || Number(d.quantityDelivered) || 0), 0);
  const totalFuelLitres = fuelRecords.reduce((sum, r) => sum + (Number(r.litres) || 0), 0);
  const completedDeliveries = deliveries.filter((d) => ['completed', 'delivered', 'weighed_in'].includes(d.status));
  const inTransit = deliveries.filter((d) => ['loaded', 'dispatched', 'in_transit', 'en_route'].includes(d.status));
  const openPOs = pos.filter((p) => ['approved', 'pending', 'in_progress'].includes(p.status));

  return {
    deliveries: {
      total: deliveries.length,
      completed: completedDeliveries.length,
      inTransit: inTransit.length,
      totalTonnage,
    },
    fuel: {
      totalLitres: totalFuelLitres,
      transactions: fuelRecords.length,
    },
    vendors: {
      total: vendors.length,
      active: vendors.filter((v) => v.status === 'active').length,
    },
    drivers: {
      total: drivers.length,
      active: drivers.filter((d) => d.status === 'active').length,
      expiredInsurance: drivers.filter((d) => insuranceStatus(d.insuranceExpiry) === 'expired').length,
    },
    trucks: {
      total: vehicles.length,
      active: vehicles.filter((v) => v.status === 'active').length,
      expiredInsurance: vehicles.filter((v) => insuranceStatus(v.insuranceExpiry) === 'expired').length,
    },
    materials: {
      total: materials.length,
      types: materials.map((m) => m.name).filter(Boolean),
    },
    purchaseOrders: {
      total: pos.length,
      open: openPOs.length,
      fulfilled: pos.filter((p) => ['completed', 'delivered'].includes(p.status)).length,
    },
  };
}

module.exports = {
  buildMasterAudit,
  buildDriverReport,
  buildMaterialReport,
  buildFuelReport,
  buildTruckReport,
  buildVendorReport,
  buildPOReport,
  buildSummary,
  withinTimeframe,
};
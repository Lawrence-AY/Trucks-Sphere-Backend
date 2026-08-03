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
 * Returns a human-readable Africa/Nairobi timestamp, or an empty string when invalid.
 */
function formatEAT(value) {
  if (!value) return '';
  try {
    const d = value instanceof Date
      ? value
      : typeof value?.toDate === 'function'
        ? value.toDate()
        : typeof value === 'object' && typeof value.seconds === 'number'
          ? new Date(value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6))
          : new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-KE', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Africa/Nairobi',
      hour12: false,
      timeZoneName: 'short',
    });
  } catch {
    return '';
  }
}

/** The quarry operator's assigned location is the reporting source of truth. */
function getQuarryLocation(delivery, usersById = {}) {
  const operatorId = delivery.quarryOperatorUid || delivery.weighOutByUid || delivery.createdByUid;
  const operator = usersById[operatorId] || {};
  return String(delivery.quarryLocation || operator.quarryLocation || '').trim();
}

/** Human-readable operational origin; never lead a report with raw GPS. */
function getReportOrigin(delivery, quarryLocation = '') {
  if (quarryLocation) return quarryLocation;
  const geo = delivery.weighOutGeoLocation || {};
  return delivery.quarryName || geo.town || geo.locality || geo.city || geo.address || delivery.weighOutLocation || 'Not captured';
}

/**
 * The Material Source column represents where the job was originated:
 * quarry-created jobs use their captured quarry geolocation, while site-created
 * jobs retain the source selected when the job was created at site.
 */
function getReportMaterialSource(delivery, quarryLocation = '') {
  if (quarryLocation) return quarryLocation;
  const createdBy = String(delivery.createdBy || '').trim().toLowerCase();
  const wasCreatedAtSite = createdBy === 'operator_site' || createdBy === 'site_operator';

  if (wasCreatedAtSite) {
    return delivery.materialSource || 'Not captured';
  }

  const geo = delivery.weighOutGeoLocation || {};
  const city = String(geo.city || geo.town || geo.district || geo.locality || '').trim();
  const rawLocation = String(geo.address || geo.name || delivery.weighOutLocation || '').trim();
  // Generic defaults are not captured sources. Quarry-created jobs must show
  // their captured location, never a configured quarry name.
  const location = ['quarry', 'weigh-out location', 'material source', 'quarrymaterial source']
    .includes(rawLocation.toLowerCase())
    ? ''
    : rawLocation;

  if (city && location) {
    return location.toLocaleLowerCase().includes(String(city).toLocaleLowerCase())
      ? location
      : `${city} — ${location}`;
  }

  return city || location || 'Not captured';
}

/** Turn internal lifecycle codes into clear, report-ready status text. */
function formatJobStatus(status) {
  const value = String(status || '').trim();
  if (!value) return '';
  return value
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
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
  return all.filter((r) => withinTimeframe(r.dispensedAt || r.createdAt || r.timestamp, options));
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
 * Vendor insurance is the source of truth for its fleet. Support the legacy
 * report field names too, so historical driver/truck records remain complete.
 */
function getInsuranceDetails(vendor = {}, asset = {}) {
  const sources = [vendor || {}, asset || {}];
  const firstValue = (...fieldNames) => {
    for (const source of sources) {
      for (const fieldName of fieldNames) {
        const value = source[fieldName];
        if (value !== undefined && value !== null && String(value).trim()) return value;
      }
    }
    return '';
  };

  const insuranceExpiryDate = firstValue('insuranceExpiryDate', 'insuranceExpiry');
  return {
    insuranceCompany: firstValue('insuranceCompany', 'insuranceProvider'),
    insuranceNumber: firstValue('insuranceNumber', 'insurancePolicyNo'),
    insuranceStartDate: firstValue('insuranceStartDate'),
    insuranceCommencingDate: firstValue('insuranceCommencingDate'),
    insuranceExpiryDate,
    insuranceSupplier: firstValue('insuranceSupplier'),
    insuranceStatus: insuranceStatus(insuranceExpiryDate),
  };
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
  const users = buildMap(snapshotStore.getAll('users'));
  const allFuel = snapshotStore.getAll('fuelRecords');

  return deliveries.map((d) => {
    const vendor = vendors[d.vendorId] || {};
    const driver = drivers[d.driverId] || {};
    const vehicle = vehicles[d.vehicleId] || {};
    const po = pos[d.purchaseOrderId] || {};
    const material = materials[d.materialId] || {};
    const quarryLocation = getQuarryLocation(d, users);
    const vendorInsurance = getInsuranceDetails(vendor);

    // Fuel for this job
    const jobFuel = allFuel.filter((f) => f.jobId === d.jobId);
    const totalFuelLitres = jobFuel.reduce((sum, f) => sum + (Number(f.litres || f.fuelAmount) || 0), 0);

    const quarryNet = Number(d.weighOutWeight || d.netWeight || 0) - Number(d.weighInWeight || 0);
    // Site Net = site weigh-in minus site weigh-out ONLY (site data is the receiving authority).
    // No fallback to quarry data or stored siteNetWeight.
    const siteNet = Number(d.siteWeighInWeight || 0) - Number(d.siteWeighOutWeight || 0);

    return {
      // Order
      jobId: d.jobId || '',
      poNumber: d.poNumber || po.poNumber || '',
      jobStatusCode: d.status || '',
      jobStatus: formatJobStatus(d.status),
      // PO details
      poQuantity: Number(po.quantity || 0),
      // Vendor
      vendorName: d.vendorName || vendor.companyName || '',
      vendorInsuranceCompany: vendorInsurance.insuranceCompany,
      vendorInsuranceNumber: vendorInsurance.insuranceNumber,
      vendorInsuranceStartDate: vendorInsurance.insuranceStartDate,
      vendorInsuranceCommencingDate: vendorInsurance.insuranceCommencingDate,
      vendorInsuranceExpiryDate: vendorInsurance.insuranceExpiryDate,
      vendorInsuranceSupplier: vendorInsurance.insuranceSupplier,
      vendorInsuranceStatus: vendorInsurance.insuranceStatus,
      // Driver
      driverName: d.driverName || driver.name || driver.fullName || '',
      driverLicense: driver.licenseNumber || '',
      // Truck
      plateNumber: d.plateNumber || vehicle.plateNumber || vehicle.plate || '',
      truckMake: vehicle.make || '',
      truckModel: vehicle.model || '',
      // Material
      materialName: d.materialName || material.name || '',
      materialSource: getReportMaterialSource(d, quarryLocation),
      origin: getReportOrigin(d, quarryLocation),
      // Quantities
      quantityOrdered: Number(d.quantityOrdered || po.quantity || 0),
      // Delivered Qty uses site net data only — no fallback to quarry netWeight.
      quantityDelivered: siteNet > 0 ? siteNet : 0,
      // Lifecycle Timestamps (raw ISO)
     
      // Lifecycle Timestamps (EAT formatted — East African Time, UTC+3)
      quarryInTimeEAT: formatEAT(d.weighInAt),
      quarryOutTimeEAT: formatEAT(d.weighOutAt),
      siteInTimeEAT: formatEAT(d.siteWeighInAt),
      siteOutTimeEAT: formatEAT(d.siteWeighOutAt),
    
   
      // Weights
      quarryWeighIn: Number(d.weighInWeight || 0),
      quarryWeighOut: Number(d.weighOutWeight || 0),
      netWeight: Number(d.netWeight || 0),
      siteWeighIn: Number(d.siteWeighInWeight || 0),
      siteWeighOut: Number(d.siteWeighOutWeight || 0),
      quarryNet: quarryNet > 0 ? quarryNet : Number(d.netWeight || 0),
      siteNet: siteNet,
      // Fuel
      totalFuelLitres,
      fuelOTP: jobFuel.length > 0 ? (jobFuel[0].otp || jobFuel[0].otpCode || jobFuel[0].authorizationCode || '') : '',
      fuelAttendant: jobFuel.length > 0 ? (jobFuel[0].attendantName || jobFuel[0].dispensedBy || jobFuel[0].dispensedByName || jobFuel[0].attendant || '') : '',
      // Lot & GRN
      lotNumber: d.storageLot || d.lotNumber || '',
      grnNumber: d.receiptNoteId || d.grnNumber || '',
      // System accountability
      quarryOperator: d.weighOutByName || d.weighOutBy || '',
      creationLocation: d.weighInLocation || d.weighOutLocation || d.receivedLocation || '',
      geolocation: d.weighOutGeoLocation ? `${d.weighOutGeoLocation.latitude},${d.weighOutGeoLocation.longitude}` : '',
    };
  });
}

/**
 * ─── Driver Report ───
 */
function buildDriverReport() {
  const driverDocs = snapshotStore.getAll('drivers');
  const vendors = buildMap(snapshotStore.getAll('vendors'));

  return driverDocs.map((d) => {
    const insurance = getInsuranceDetails(vendors[d.vendorId], d);
    return {
    driverName: d.name || d.fullName || '',
    nationalId: d.nationalId || '',
    licenseNumber: d.licenseNumber || '',
    ntsaStatus: d.ntsaStatus || 'Not Verified',
    insuranceCompany: insurance.insuranceCompany,
    insuranceNumber: insurance.insuranceNumber,
    insuranceStartDate: insurance.insuranceStartDate,
    insuranceCommencingDate: insurance.insuranceCommencingDate,
    insuranceExpiryDate: insurance.insuranceExpiryDate,
    insuranceSupplier: insurance.insuranceSupplier,
    insuranceStatus: insurance.insuranceStatus,
    vendorName: vendors[d.vendorId]?.companyName || d.vendorName || '',
    phone: d.phone || '',
    status: d.status || '',
    };
  });
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
    transactionDate: formatEAT(r.dispensedAt || r.createdAt || r.timestamp),
    driverName: r.driverName || '',
    plateNumber: r.plateNumber || '',
    litres: Number(r.litres || r.fuelAmount || 0),
    attendantName: r.attendantName || r.dispensedBy || '',
    otp: r.otp || r.otpCode || r.authorizationCode || '',
    authorizingVendor: vendors[r.vendorId]?.companyName || r.vendorName || '',
    jobId: r.jobId || '',
  }));
}

/**
 * ─── Truck Report ───
 */
function buildTruckReport() {
  const vehicleDocs = snapshotStore.getAll('vehicles');
  const vendors = buildMap(snapshotStore.getAll('vendors'));

  return vehicleDocs.map((v) => {
    const insurance = getInsuranceDetails(vendors[v.vendorId], v);
    return {
    plateNumber: v.plateNumber || v.plate || '',
    make: v.make || '',
    model: v.model || '',
    ntsaStatus: v.ntsaStatus || 'Not Verified',
    insuranceCompany: insurance.insuranceCompany,
    insuranceNumber: insurance.insuranceNumber,
    insuranceStartDate: insurance.insuranceStartDate,
    insuranceCommencingDate: insurance.insuranceCommencingDate,
    insuranceExpiryDate: insurance.insuranceExpiryDate,
    insuranceSupplier: insurance.insuranceSupplier,
    insuranceStatus: insurance.insuranceStatus,
    vendorName: vendors[v.vendorId]?.companyName || '',
    status: v.status || '',
    };
  });
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

    return {
      vendorName: v.companyName || '',
      activePOs: vendorPOs.filter((p) => ['approved', 'in_progress', 'pending'].includes(p.status)).length,
      fulfilledPOs: vendorPOs.filter((p) => p.status === 'completed' || p.status === 'delivered').length,
      totalPOs: vendorPOs.length,
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
  // Use ALL deliveries for progress % calculation (not time-filtered)
  const allDeliveries = snapshotStore.getAll('deliveryOrders');
  // Use time-filtered deliveries for preview/displays within the selected period
  const periodDeliveries = getDeliveries(options);

  return poDocs.map((po) => {
    const allPoDeliveries = allDeliveries.filter((d) => d.purchaseOrderId === po.id);
    // Use site net weight as the delivered quantity (site data is the verified receiving weight).
    // Compute siteNet per delivery: siteWeighIn - siteWeighOut, falling back to stored siteNetWeight or netWeight.
    // Delivered Qty uses site net data (siteWeighIn - siteWeighOut) ONLY — no quarry fallback.
    const totalDeliveredQty = allPoDeliveries.reduce(
      (sum, d) => {
        const siteNet = Number(d.siteWeighInWeight || 0) - Number(d.siteWeighOutWeight || 0);
        return sum + (siteNet > 0 ? siteNet : 0);
      },
      0,
    );
    const targetQty = Number(po.quantity || 0);
    const progress = targetQty > 0 ? Math.min(100, Math.round((totalDeliveredQty / targetQty) * 100)) : 0;

    const periodPoDeliveries = periodDeliveries.filter((d) => d.purchaseOrderId === po.id);
    // Period delivered qty also uses site net data ONLY — no quarry fallback.
    const periodDeliveredQty = periodPoDeliveries.reduce((sum, d) => {
      const siteNet = Number(d.siteWeighInWeight || 0) - Number(d.siteWeighOutWeight || 0);
      return sum + (siteNet > 0 ? siteNet : 0);
    }, 0);

    return {
      poNumber: po.poNumber || '',
      vendorName: po.vendorName || '',
      materialName: po.materialName || '',
      targetQuantity: targetQty,
      deliveredQuantity: totalDeliveredQty,
      remainingQuantity: Math.max(0, targetQty - totalDeliveredQty),
      progressPercent: progress,
      status: po.status || '',
      deliveryCount: periodPoDeliveries.length,
      createdAt: formatEAT(po.createdAt),
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
  const totalFuelLitres = fuelRecords.reduce((sum, r) => sum + (Number(r.litres || r.fuelAmount) || 0), 0);
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
  formatEAT,
  formatJobStatus,
  getInsuranceDetails,
  getQuarryLocation,
  getReportOrigin,
  getReportMaterialSource,
};

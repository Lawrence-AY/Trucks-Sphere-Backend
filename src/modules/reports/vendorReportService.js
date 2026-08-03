/**
 * Vendor Reports Service
 *
 * Builds reports filtered to a specific vendor's data.
 * Used by vendor account users to download their own reports.
 */
const snapshotStore = require('../../utils/snapshotStore');
const { formatEAT, formatJobStatus, getInsuranceDetails, getQuarryLocation, getReportMaterialSource } = require('./service');

function withinTimeframe(dateStr, options) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (options.filter) {
    case 'day': return d >= todayStart;
    case 'week': {
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
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
    default: return true;
  }
}

function getFilteredDeliveries(vendorId, options = {}) {
  const all = snapshotStore.getAll('deliveryOrders');
  const vendorDeliveries = all.filter((d) => d.vendorId === vendorId);
  if (!options.filter && !options.startDate) return vendorDeliveries;
  return vendorDeliveries.filter((d) =>
    withinTimeframe(d.createdAt || d.updatedAt, options),
  );
}

function getFilteredFuelRecords(vendorId, options = {}) {
  const all = snapshotStore.getAll('fuelRecords');

  // Collect all job IDs belonging to this vendor's deliveries for reliable fuel matching.
  // Fuel records may not always have a vendorId field; the jobId → delivery → vendor
  // chain is the canonical way to associate fuel with a vendor.
  const deliveries = snapshotStore.getAll('deliveryOrders');
  const vendorJobIds = new Set(
    deliveries.filter((d) => d.vendorId === vendorId).map((d) => d.jobId).filter(Boolean),
  );

  const vendorFuel = all.filter((f) =>
    f.vendorId === vendorId || (f.jobId && vendorJobIds.has(f.jobId)),
  );
  if (!options.filter && !options.startDate) return vendorFuel;
  return vendorFuel.filter((r) =>
    withinTimeframe(r.dispensedAt || r.createdAt || r.timestamp, options),
  );
}

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

function buildMap(docs, key = 'id') {
  const map = {};
  (docs || []).forEach((d) => { if (d[key]) map[d[key]] = d; });
  return map;
}

/**
 * Build vendor-specific deliveries report (Master Audit - vendor filtered).
 */
function buildVendorMasterAudit(vendorId, options = {}) {
  const deliveries = getFilteredDeliveries(vendorId, options);
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
    const jobFuel = allFuel.filter((f) => f.jobId === d.jobId);
    const totalFuelLitres = jobFuel.reduce(
      (sum, f) => sum + (Number(f.litres || f.fuelAmount) || 0), 0,
    );

    // Site Net = site weigh-in minus site weigh-out (site-verified delivered weight).
    // Must NOT fall back to quarry netWeight — site data is the receiving authority.
    const siteNet = Number(d.siteWeighInWeight || 0) - Number(d.siteWeighOutWeight || 0);
    const effectiveSiteNet = siteNet > 0 ? siteNet : Number(d.siteNetWeight || 0);

    return {
      jobId: d.jobId || '',
      poNumber: d.poNumber || po.poNumber || '',
      jobStatusCode: d.status || '',
      jobStatus: formatJobStatus(d.status),
      poQuantity: Number(po.quantity || 0),
      vendorName: d.vendorName || vendor.companyName || '',
      vendorInsuranceCompany: vendorInsurance.insuranceCompany,
      vendorInsuranceNumber: vendorInsurance.insuranceNumber,
      vendorInsuranceStartDate: vendorInsurance.insuranceStartDate,
      vendorInsuranceCommencingDate: vendorInsurance.insuranceCommencingDate,
      vendorInsuranceExpiryDate: vendorInsurance.insuranceExpiryDate,
      vendorInsuranceSupplier: vendorInsurance.insuranceSupplier,
      vendorInsuranceStatus: vendorInsurance.insuranceStatus,
      driverName: d.driverName || driver.name || driver.fullName || '',
      driverLicense: driver.licenseNumber || '',
      plateNumber: d.plateNumber || vehicle.plateNumber || vehicle.plate || '',
      truckMake: vehicle.make || '',
      truckModel: vehicle.model || '',
      materialName: d.materialName || material.name || '',
      materialSource: getReportMaterialSource(d, quarryLocation),
      quantityOrdered: Number(d.quantityOrdered || po.quantity || 0),
      quantityDelivered: effectiveSiteNet > 0 ? effectiveSiteNet : Number(d.netWeight || d.quantityDelivered || 0),
      quarryInTime: formatEAT(d.weighInAt),
      quarryOutTime: formatEAT(d.weighOutAt),
      siteInTime: formatEAT(d.siteWeighInAt),
      siteOutTime: formatEAT(d.siteWeighOutAt),
      quarryWeighIn: Number(d.weighInWeight || 0),
      quarryWeighOut: Number(d.weighOutWeight || 0),
      siteWeighIn: Number(d.siteWeighInWeight || 0),
      siteWeighOut: Number(d.siteWeighOutWeight || 0),
      siteNet: effectiveSiteNet,
      totalFuelLitres,
      fuelAttendant: jobFuel.length > 0
        ? (jobFuel[0].attendantName || jobFuel[0].dispensedBy || '')
        : '',
      lotNumber: d.storageLot || d.lotNumber || '',
      grnNumber: d.receiptNoteId || d.grnNumber || '',
      geolocation: d.weighOutGeoLocation
        ? `${d.weighOutGeoLocation.latitude},${d.weighOutGeoLocation.longitude}`
        : '',
    };
  });
}

/**
 * Build vendor drivers report.
 */
function buildVendorDriverReport(vendorId) {
  const driverDocs = snapshotStore.getAll('drivers').filter((d) => d.vendorId === vendorId);
  const vendor = snapshotStore.getById('vendors', vendorId) || {};

  return driverDocs.map((d) => {
    const insurance = getInsuranceDetails(vendor, d);
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
    phone: d.phone || '',
    status: d.status || '',
    };
  });
}

/**
 * Build vendor trucks report.
 */
function buildVendorTruckReport(vendorId) {
  const vehicleDocs = snapshotStore.getAll('vehicles').filter((v) => v.vendorId === vendorId);
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
 * Build vendor fuel report.
 */
function buildVendorFuelReport(vendorId, options = {}) {
  const records = getFilteredFuelRecords(vendorId, options);
  return records.map((r) => ({
    transactionDate: formatEAT(r.dispensedAt || r.createdAt || r.timestamp),
    driverName: r.driverName || '',
    plateNumber: r.plateNumber || '',
    litres: Number(r.litres || r.fuelAmount || 0),
    attendantName: r.attendantName || r.dispensedBy || '',
    otp: r.otp || r.otpCode || r.authorizationCode || '',
    jobId: r.jobId || '',
  }));
}

/**
 * Build vendor purchase orders report.
 */
function buildVendorPOReport(vendorId, options = {}) {
  const poDocs = snapshotStore.getAll('purchaseOrders').filter((p) => p.vendorId === vendorId);
  const allDeliveries = snapshotStore.getAll('deliveryOrders');
  const periodDeliveries = getFilteredDeliveries(vendorId, options);

  return poDocs.map((po) => {
    const allPoDeliveries = allDeliveries.filter((d) => d.purchaseOrderId === po.id);
    // Use site net weight as the delivered quantity (site data is the verified receiving weight).
    // Compute siteNet per delivery: siteWeighIn - siteWeighOut, falling back to stored siteNetWeight or netWeight.
    const totalDeliveredQty = allPoDeliveries.reduce(
      (sum, d) => {
        const siteNet = Number(d.siteWeighInWeight || 0) - Number(d.siteWeighOutWeight || 0);
        const effectiveSiteNet = siteNet > 0 ? siteNet : Number(d.siteNetWeight || d.netWeight || 0);
        return sum + effectiveSiteNet;
      },
      0,
    );
    const targetQty = Number(po.quantity || 0);
    const progress =
      targetQty > 0 ? Math.min(100, Math.round((totalDeliveredQty / targetQty) * 100)) : 0;

    const periodPoDeliveries = periodDeliveries.filter((d) => d.purchaseOrderId === po.id);

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

module.exports = {
  buildVendorMasterAudit,
  buildVendorDriverReport,
  buildVendorTruckReport,
  buildVendorFuelReport,
  buildVendorPOReport,
};

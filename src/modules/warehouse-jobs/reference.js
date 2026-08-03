function trailingNumber(value, prefix, fallback = '000') {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/(\d+)$/);
  if (match) return `${prefix}${match[1].padStart(3, '0')}`;
  return `${prefix}${fallback}`;
}

function normalizePomatReference(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/^(?:PO)?MAT?(\d+)$/) || raw.match(/^POMAT(\d+)$/);
  if (!match) return '';
  return `POMAT${match[1].padStart(3, '0')}`;
}

function buildWarehouseReference(pomatReference, vendor = {}, driver = {}, vehicle = {}) {
  const normalizedPomat = normalizePomatReference(pomatReference);
  const vendorNumber = trailingNumber(vendor.vendorId || vendor.id, 'V');
  const driverNumber = trailingNumber(driver.driverId || driver.id, 'D');
  const vehicleNumber = trailingNumber(vehicle.vehicleId || vehicle.id || vehicle.registrationNumber || vehicle.plateNumber, 'T');
  return `${normalizedPomat}/${vendorNumber}/${driverNumber}/${vehicleNumber}`;
}

function buildWarehouseJobId(reference, jobNumber) {
  return `${reference}/J${String(jobNumber).padStart(4, '0')}`;
}

module.exports = { buildWarehouseReference, buildWarehouseJobId, normalizePomatReference };

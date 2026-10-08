const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
function selectFuelTransaction(records, expected) {
  if (!expected.receiptNoteId || !expected.activeDriverCode || !expected.driverId || !expected.vehicleId) throw Object.assign(new Error('Receipt note and authorized driver/vehicle identifiers are required.'), {statusCode: 409});
  const matches = records.filter(row => {
    if (row._deleted === true) return false;
    const x = row.xfields || {};
    const driver = row.driver || {};
    const vehicle = row.vehicle || {};
    const receipt = x.receiptnoteid || x.receiptNoteId || x.jobid || x.jobID || row.jobid;
    const code = driver.code || x.drivercode;
    const driverRef = typeof driver === 'object' ? driver.id : driver;
    const vehicleRef = typeof vehicle === 'object' ? vehicle.id : vehicle;
    const masterDriver = expected.fmsDriver || {};
    const firstName = masterDriver.first_name || masterDriver.fstname || '';
    const driverNames = [masterDriver.name, `${firstName} ${masterDriver.name || ''}`, `${masterDriver.name || ''} ${firstName}`].map(normalize).filter(Boolean);
    const mappedDriver = driverRef != null
      ? expected.fmsDriverId != null && String(driverRef) === String(expected.fmsDriverId)
      : driverNames.includes(normalize(driver.name)) && String(code || '') === expected.activeDriverCode;
    const registration = expected.fmsVehicle?.name || expected.fmsVehicle?.code;
    const mappedVehicle = vehicleRef != null
      ? expected.fmsVehicleId != null && String(vehicleRef) === String(expected.fmsVehicleId)
      : Boolean(registration) && normalize(vehicle.name || vehicle.code) === normalize(registration);
    const driverId = driver.xfields?.driverid || x.driverid || (mappedDriver ? expected.driverId : '');
    const vehicleId = vehicle.xfields?.vehicleid || x.vehicleid || (mappedVehicle ? expected.vehicleId : '');
    const vendorId = x.vendorid || driver.xfields?.vendorid;
    const date = Date.parse(row.dispensedAt || row.datetime || row.date || row.createdAt || '');
    const since = Date.parse(expected.authorizedAt || '');
    const codeMatches = code ? String(code) === expected.activeDriverCode : mappedDriver && mappedVehicle;
    // Pump-created rows can lack xfields. Only recover those using both mapped
    // identities and the exact temporary driver code, never identity alone.
    const receiptMatches = receipt
      ? [expected.receiptNoteId, expected.jobId].filter(Boolean).includes(String(receipt))
      : mappedDriver && mappedVehicle && String(code || '') === expected.activeDriverCode;
    return receiptMatches && codeMatches
      && String(driverId || '') === expected.driverId && String(vehicleId || '') === expected.vehicleId
      && (!vendorId || String(vendorId) === expected.vendorId)
      && Number.isFinite(date) && Number.isFinite(since) && date >= since
      && (!expected.fmsTransactionId || String(row.id) === String(expected.fmsTransactionId))
      && date <= Date.now() + 60000 && row.id != null && Number.isFinite(Number(row.volume)) && Number(row.volume) > 0;
  });
  if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Multiple FMS transactions match. Reconcile them before finalizing.' : 'No completed FMS transaction matches this authorization yet.'), {statusCode: 409, code: matches.length ? 'FMS_TRANSACTION_AMBIGUOUS' : 'FMS_TRANSACTION_PENDING'});
  return { id: String(matches[0].id), volume: Number(matches[0].volume) };
}
module.exports = { selectFuelTransaction };

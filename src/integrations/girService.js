const BASE_URL = String(process.env.GIR_FMS_BASE_URL || '').trim().replace(/\/$/, '');
const API_KEY = String(process.env.GIR_FMS_API_KEY || '').trim();

function enabled() { return Boolean(BASE_URL && API_KEY); }
function headers() { return { 'Content-Type': 'application/json', 'X-Klervi-API-Key': API_KEY }; }
async function request(path, options = {}) {
  const { envelope = false, ...fetchOptions } = options;
  const response = await fetch(`${BASE_URL}/api-impexp${path}`, { signal: AbortSignal.timeout(20000), ...fetchOptions, headers: { ...headers(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `GIR/FMS request failed (${response.status})`), { statusCode: 502, code: 'GIR_FMS_REQUEST_FAILED' });
  return envelope ? body : body?.result ?? body;
}
async function findByXfield(resource, field, value) {
  if (!enabled() || !value) return null;
  const page = await request(`/${resource}?limit=500`);
  const records = Array.isArray(page) ? page : [];
  return records.find((record) => String(record?.xfields?.[field] || '') === String(value)) || null;
}
async function sync(resource, record, payload, key) {
  if (!enabled()) return { skipped: true };
  const existing = await findByXfield(resource, key, record.id);
  if (existing?.id) return request(`/${resource}/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
  return request(`/${resource}`, { method: 'POST', headers: { 'X-Klervi-Idempotency-Key': `trucksphere-${resource}-${record.id}` }, body: JSON.stringify(payload) });
}
function driverPayload(driver) {
  const baseCode = String(driver.baseDriverCode || driver.driverCode || driver.code || driver.id).trim();
  return { name: driver.fullName || driver.name || `${driver.firstName || ''} ${driver.surname || ''}`.trim(), first_name: driver.firstName || '', code: baseCode, pin_code: baseCode, xfields: { basedrivercode: baseCode, jobid: driver.jobId || '', driverid: driver.id || '', vendorid: driver.vendorId || '' }, active: 'no' };
}
function vehiclePayload(vehicle) {
  const registration = vehicle.registrationNumber || vehicle.plateNumber || vehicle.plate || vehicle.id;
  return { name: registration, code: registration, pin_code: registration, model: { name: [vehicle.make, vehicle.model].filter(Boolean).join(' ') }, xfields: { vehicle_email: vehicle.email || vehicle.vehicleEmail || '', jobid: vehicle.jobId || '', vehicleid: vehicle.id || '', vendorid: vehicle.vendorId || '' }, active: 'no' };
}
async function activateFuelSession({ driverId, baseDriverCode, vehicleId, vendorId, jobId, fuelCode }) {
  if (!jobId || !/\/RN\d+$/.test(jobId)) throw Object.assign(new Error('An issued receipt note is required before fuel authorization.'), {statusCode: 409});
  if (!enabled()) return { skipped: true };
  const driver = await findByXfield('drivers', 'driverid', driverId);
  const vehicle = await findByXfield('vehicles', 'vehicleid', vehicleId);
  if (!driver?.id || !vehicle?.id) throw Object.assign(new Error('GIR/FMS driver or vehicle mapping was not found'), { statusCode: 502, code: 'GIR_FMS_MAPPING_NOT_FOUND' });
  // Always build the active code from the original driver code. The GIR record's
  // `code` may still contain a previous temporary fuel suffix.
  const baseCode = String(baseDriverCode || driver?.xfields?.basedrivercode || driver.code || '').trim();
  if (!baseCode || !fuelCode) throw Object.assign(new Error('GIR/FMS base driver code or temporary fuel code is missing'), { statusCode: 502, code: 'GIR_FMS_CODE_MISSING' });
  const activeCode = `${baseCode}${fuelCode}`;
  const driverResult = await request(`/drivers/${driver.id}`, { method: 'PUT', body: JSON.stringify({ code: activeCode, pin_code: activeCode, active: 'yes', xfields: { ...driver.xfields, basedrivercode: baseCode, fuelcode: fuelCode, jobid: jobId || '', driverid: driverId, vendorid: vendorId || '' } }) });
  const vehicleResult = await request(`/vehicles/${vehicle.id}`, { method: 'PUT', body: JSON.stringify({ active: 'yes', xfields: { ...vehicle.xfields, jobid: jobId || '', vehicleid: vehicleId, vendorid: vendorId || '', fuelcode: fuelCode } }) });
  return { driver: driverResult, vehicle: vehicleResult, activeCode };
}
async function recordFuelTransaction({ fuelId, jobId, fuelAmount, otp, authorizationCode, driverId, vehicleId, vendorId }) {
  if (!enabled()) return { skipped: true };
  const result = await request('/transac_fuels', {
    method: 'POST',
    headers: { 'X-Klervi-Idempotency-Key': `trucksphere-fuel-${fuelId}` },
    body: JSON.stringify({
      id: fuelId,
      vehicle: vehicleId ? { id: vehicleId } : null,
      driver: driverId ? { id: driverId } : null,
      volume: Number(fuelAmount) || 0,
      xfields: {
        jobid: jobId || '',
        otp: otp || '',
        authorizationcode: authorizationCode || '',
        fuelid: fuelId,
        vendorid: vendorId || '',
      },
    }),
  });
  // GIR may return a transaction object or a result array.
  return Array.isArray(result) ? (result[result.length - 1] || {}) : result;
}
async function clearFuelSession({ driverId, vehicleId, jobId }) {
  if (!enabled()) return { skipped: true };
  const [driver, vehicle] = await Promise.all([
    findByXfield('drivers', 'driverid', driverId),
    findByXfield('vehicles', 'vehicleid', vehicleId),
  ]);
  if (jobId && (!driver?.id || !vehicle?.id)) throw Object.assign(new Error('FMS driver or truck mapping was not found.'), { statusCode: 502, code: 'GIR_FMS_MAPPING_NOT_FOUND' });
  const results = {};
  if (driver?.id && (!jobId || !driver.xfields?.jobid || driver.xfields.jobid === jobId)) {
    const baseCode = String(driver.xfields?.basedrivercode || driver.code || '').trim();
    results.driver = await request(`/drivers/${driver.id}`, { method: 'PUT', body: JSON.stringify({ code: baseCode, pin_code: baseCode, active: 'no', xfields: { ...driver.xfields, jobid: '', fuelcode: '' } }) });
  }
  if (vehicle?.id && (!jobId || !vehicle.xfields?.jobid || vehicle.xfields.jobid === jobId)) results.vehicle = await request(`/vehicles/${vehicle.id}`, { method: 'PUT', body: JSON.stringify({ active: 'no', xfields: { ...vehicle.xfields, jobid: '', fuelcode: '' } }) });
  return results;
}
async function setJobReference({ driverId, vehicleId, vendorId, jobId }) {
  if (!enabled() || !jobId) return { skipped: true };
  const [driver, vehicle] = await Promise.all([findByXfield('drivers', 'driverid', driverId), findByXfield('vehicles', 'vehicleid', vehicleId)]);
  if (driver?.id) await request(`/drivers/${driver.id}`, { method: 'PUT', body: JSON.stringify({ xfields: { ...driver.xfields, jobid: jobId, driverid: driverId, vendorid: vendorId || '' } }) });
  if (vehicle?.id) await request(`/vehicles/${vehicle.id}`, { method: 'PUT', body: JSON.stringify({ xfields: { ...vehicle.xfields, jobid: jobId, vehicleid: vehicleId, vendorid: vendorId || '' } }) });
  return { updated: true };
}
async function findFuelTransaction(expected) {
  if (!enabled()) throw Object.assign(new Error('FMS is not configured.'), { statusCode: 503 });
  const [driver, vehicle] = await Promise.all([
    findByXfield('drivers', 'driverid', expected.driverId),
    findByXfield('vehicles', 'vehicleid', expected.vehicleId),
  ]);
  const driverJob = driver?.xfields?.jobid || driver?.xfields?.jobID;
  const vehicleJob = vehicle?.xfields?.jobid || vehicle?.xfields?.jobID;
  if (!driverJob || driverJob !== vehicleJob || ![expected.jobId, expected.receiptNoteId].includes(driverJob)) {
    throw Object.assign(new Error('GIR driver and vehicle must have the same authorized job reference.'), { statusCode: 409, code: 'FMS_REFERENCE_MISMATCH' });
  }
  const records = new Map();
  const cursors = new Set();
  let cursor = '';
  while (true) {
    const page = await request(`/transac_fuels${cursor ? `?last_id=${encodeURIComponent(cursor)}` : ''}`, { envelope: true });
    if (!Array.isArray(page.result)) throw Object.assign(new Error('Unexpected FMS transaction response.'), { statusCode: 502 });
    // GIR emits multiple ledger entries for edits to one physical transaction.
    for (const row of page.result) records.set(row.transac_id || row.id, row);
    if (!page.more) break;
    cursor = page.result.at(-1)?.id;
    if (!cursor || cursors.has(cursor)) throw Object.assign(new Error('Invalid FMS transaction pagination.'), { statusCode: 502 });
    cursors.add(cursor);
  }
  return require('../utils/fmsTransaction').selectFuelTransaction([...records.values()], {
    ...expected, fmsDriverId: driver?.id, fmsVehicleId: vehicle?.id,
    fmsDriver: driver, fmsVehicle: vehicle,
  });
}
module.exports = {
  findFuelTransaction,
  enabled,
  syncDriver: (driver) => sync('drivers', driver, driverPayload(driver), 'driverid'),
  syncVehicle: (vehicle) => sync('vehicles', vehicle, vehiclePayload(vehicle), 'vehicleid'),
  activateFuelSession,
  recordFuelTransaction,
  clearFuelSession,
  setJobReference,
};

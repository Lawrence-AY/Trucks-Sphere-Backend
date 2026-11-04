/*
 * Recover positive-volume FMS fuel transactions that were not finalized into
 * Firebase. Dry-run is the default. Add --write only after reviewing output.
 *
 * Example:
 *   node scripts/backfill-fms-fuel-records.js --vendor V001 --from 2026-11-03T08:00:00+03:00 --to 2026-11-03T16:00:00+03:00
 *   node scripts/backfill-fms-fuel-records.js --write --vendor V001 --from ... --to ...
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');
const { db } = require('../config/firebase');
const girService = require('../src/integrations/girService');

const normalize = value => String(value || '').trim().replace(/[\s-]/g, '').toUpperCase();
const name = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
const arg = key => { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : ''; };
const write = process.argv.includes('--write');
const repair = process.argv.includes('--repair');
const vendorId = String(arg('--vendor') || 'V001').trim().toUpperCase();
const from = Date.parse(arg('--from') || '2026-11-03T00:00:00+03:00');
const to = Date.parse(arg('--to') || '2026-11-04T00:00:00+03:00');
const requestedPlates = (arg('--plates') || '').split(',').map(normalize).filter(Boolean);

function transactionDate(row) {
  return Date.parse(row.dispensedAt || row.datetime || row.date || row.createdAt || '');
}

function transactionPlate(row) {
  return normalize(row.vehicle?.name || row.vehicle?.code || row.vehicle_name || row.vehicle || row.plateNumber);
}

function transactionDriver(row) {
  return name(row.driver?.name || row.driver?.full_name || row.driver_name || row.driver);
}

function transactionId(row) {
  return String(row.id || row.transac_id || '');
}

function stableId(transactionId) {
  return `FMS-${crypto.createHash('sha256').update(String(transactionId)).digest('hex')}`;
}

async function all(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function chooseJob(row, jobs, vehicles, drivers) {
  const plate = transactionPlate(row);
  const driver = transactionDriver(row);
  const vehicleIds = vehicles.filter(v => normalize(v.registrationNumber || v.plateNumber || v.plate) === plate).map(v => v.id);
  const driverIds = drivers.filter(d => name(d.name || d.fullName) === driver).map(d => d.id);
  const candidates = jobs.filter(job =>
    String(job.vendorId || '').toUpperCase() === vendorId
    && vehicleIds.includes(job.vehicleId)
    && driverIds.includes(job.driverId)
    && ['SITE_WEIGHED_OUT', 'COMPLETED'].includes(String(job.status || '').toUpperCase())
  );
  if (!candidates.length) return { candidates, job: null };

  // Prefer an explicit job/receipt reference if FMS retained it.
  const xfields = row.xfields || {};
  const explicitReference = String(xfields.jobid || xfields.jobID || xfields.receiptnoteid || xfields.receiptNoteId || row.jobid || '').trim();
  if (explicitReference) {
    const exact = candidates.filter(job => [job.id, job.jobId, job.receiptNoteId].some(value => String(value || '') === explicitReference));
    if (exact.length === 1) return { candidates, job: exact[0] };
  }

  // Otherwise use the completed job whose operational timestamp is closest to
  // the FMS dispense time. A tie remains review-only for safety.
  const when = transactionDate(row);
  const scored = candidates.map(job => {
    const timestamps = [job.siteWeighOutAt, job.receiptNoteIssuedAt, job.receivedAt, job.siteWeighInAt, job.dispatchedAt, job.createdAt]
      .map(value => Date.parse(value || '')).filter(Number.isFinite);
    const distance = timestamps.length ? Math.min(...timestamps.map(value => Math.abs(value - when))) : Infinity;
    return { job, distance };
  }).sort((a, b) => a.distance - b.distance);
  if (!Number.isFinite(scored[0].distance) || (scored[1] && scored[1].distance === scored[0].distance)) return { candidates, job: null };
  return { candidates, job: scored[0].job };
}

async function main() {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('Invalid --from/--to range');
  if (!girService.enabled()) throw new Error('GIR_FMS_BASE_URL/GIR_FMS_API_KEY are not configured');
  const [transactions, jobs, vehicles, drivers, vendors, existing, authorizations] = await Promise.all([
    girService.listAll('transac_fuels'),
    all('deliveryOrders'), all('vehicles'), all('drivers'), all('vendors'), all('fuelRecords'), all('fuelAuthorizations'),
  ]);
  const existingFmsIds = new Set(existing.map(record => String(record.fmsTransactionId || '')).filter(Boolean));
  const vendor = vendors.find(item => String(item.id || '').toUpperCase() === vendorId);
  const rows = transactions.filter(row => {
    const date = transactionDate(row);
    const plate = transactionPlate(row);
    return Number(row.volume) > 0 && date >= from && date < to
      && (!requestedPlates.length || requestedPlates.includes(plate))
      && (repair || !existingFmsIds.has(transactionId(row)));
  });
  console.log(JSON.stringify({ mode: write ? 'WRITE' : 'DRY_RUN', repair, vendorId, range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, candidateCount: rows.length }, null, 2));
  for (const row of rows) {
    const { job, candidates } = chooseJob(row, jobs, vehicles, drivers);
    const transactionKey = transactionId(row);
    const plate = transactionPlate(row);
    if (!job) {
      console.log(JSON.stringify({ action: 'SKIP_REVIEW', transactionId: transactionKey, plate, driver: transactionDriver(row), volume: Number(row.volume), candidateJobs: candidates.map(item => item.jobId || item.id) }));
      continue;
    }
    const recordId = stableId(transactionKey);
    const authorization = authorizations
      .filter(item => String(item.vendorId || '').toUpperCase() === vendorId
        && item.driverId === job.driverId && item.vehicleId === job.vehicleId
        && (item.jobId === job.jobId || item.jobId === job.id))
      .sort((a, b) => String(b.authorizedAt || b.createdAt || '').localeCompare(String(a.authorizedAt || a.createdAt || '')))[0];
    const record = {
      id: recordId,
      source: 'fms_backfill',
      status: 'completed',
      fmsTransactionId: transactionKey,
      fuelAmount: Number(row.volume),
      litres: Number(row.volume),
      dispensedAt: new Date(transactionDate(row)).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      vendorId,
      vendorName: vendor?.name || vendor?.companyName || job.vendorName || '',
      driverId: job.driverId,
      driverName: job.driverName || transactionDriver(row),
      vehicleId: job.vehicleId,
      plateNumber: job.plateNumber || plate,
      jobId: job.jobId || job.id,
      poNumber: job.poNumber || job.purchaseOrderId || '',
      receiptNoteId: job.receiptNoteId || '',
      ...(authorization ? {
        authorizationId: authorization.id,
        authorizationCode: String(authorization.otp || authorization.authorizationCode || ''),
        dispensedByEmail: authorization.requestedByEmail || '',
        dispensedBy: authorization.requestedBy || authorization.requestedByEmail || '',
        pricePerLiter: Number(authorization.pricePerLiter || 0),
      } : {}),
      backfilledAt: new Date().toISOString(),
      backfillReason: 'FMS positive-volume transaction missing from Firebase fuelRecords',
    };
    console.log(JSON.stringify({ action: write ? 'WRITE' : 'WOULD_WRITE', id: recordId, transactionId: transactionKey, plate, driver: record.driverName, volume: record.fuelAmount, jobId: record.jobId }));
    if (write) {
      if (repair && existingFmsIds.has(transactionKey)) {
        await db.collection('fuelRecords').doc(recordId).set(record, { merge: true });
      } else if (!existingFmsIds.has(transactionKey)) {
        await db.collection('fuelRecords').doc(recordId).create(record);
      }
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

const snapshotStore = require('../utils/snapshotStore');
const girService = require('./girService');

const jobs = new Map();
let stopped = false;

function keyFor(collection, record) {
  return `${collection}:${record?.id || ''}`;
}

async function syncOne(collection, record, { apply = true } = {}) {
  if (!record?.id) return { status: 'skipped', reason: 'missing-id' };
  if (!apply) return { status: 'planned', id: record.id };
  const result = collection === 'drivers'
    ? await girService.syncDriver(record)
    : await girService.syncVehicle(record);
  return result?.skipped ? { status: 'skipped', id: record.id } : { status: 'synced', id: record.id };
}

async function backfill({ apply = false, logger = console } = {}) {
  if (!girService.enabled()) return { skipped: true, reason: 'GIR_FMS_NOT_CONFIGURED' };
  await snapshotStore.waitUntilReady();
  const result = { drivers: { total: 0, planned: 0, synced: 0, failed: 0 }, vehicles: { total: 0, planned: 0, synced: 0, failed: 0 } };
  // Read the FMS collections before processing so this operation is a complete
  // cross-reference and remains safe when the source contains many records.
  await Promise.all([girService.listAll('drivers'), girService.listAll('vehicles')]);
  for (const collection of ['drivers', 'vehicles']) {
    const stats = result[collection];
    const records = snapshotStore.getAll(collection);
    stats.total = records.length;
    for (const record of records) {
      try {
        const outcome = await syncOne(collection, record, { apply });
        stats[outcome.status === 'synced' ? 'synced' : 'planned']++;
      } catch (error) {
        stats.failed++;
        logger.error(`[GIR/FMS] ${collection} backfill failed for ${record.id}: ${error.message}`);
      }
    }
  }
  return result;
}

function enqueue(collection, record, logger = console) {
  if (stopped || !record?.id || !girService.enabled()) return;
  const key = keyFor(collection, record);
  if (jobs.has(key)) return;
  const job = syncOne(collection, record, { apply: true })
    .catch(error => logger.error(`[GIR/FMS] ${collection} event sync failed for ${record.id}: ${error.message}`))
    .finally(() => jobs.delete(key));
  jobs.set(key, job);
}

function startGirMasterDataSync({ logger = console, runBackfill = true } = {}) {
  stopped = false;
  const unsubscribers = ['drivers', 'vehicles'].map(collection => snapshotStore.subscribe(collection, change => {
    if (change.type === 'added' || change.type === 'modified') enqueue(collection, change.record, logger);
  }));
  const ready = runBackfill ? backfill({ apply: true, logger }) : Promise.resolve({ skipped: true });
  return { ready, stop() { stopped = true; unsubscribers.forEach(unsubscribe => unsubscribe()); } };
}

module.exports = { backfill, startGirMasterDataSync, syncOne };

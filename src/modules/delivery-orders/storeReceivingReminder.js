const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { sendSMS, isSmsConfigured } = require('../sms/service');
const { isBulkMaterial } = require('../../utils/receivingRoute');

const INTERVAL_MS = 15 * 60 * 1000;
const START_HOUR = 6;
const END_HOUR = 18;
const REMINDER_HOURS = new Set([6, 9, 12, 15]);
const link = String(process.env.STORE_RECEIVING_SYSTEM_LINK || process.env.SYSTEM_LINK || '').trim() || 'the TruckSphere system';

function eatParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function pendingForStore(job, storeman) {
  if (storeman.siteId && job.siteId && String(storeman.siteId).trim().toLowerCase() !== String(job.siteId).trim().toLowerCase()) return false;
  if (job.warehouseDeniedAt || String(job.status || '').toUpperCase() === 'CANCELLED') return false;
  if (job.receivingStatus === 'received_pending_inspection') return true;
  if (job.receivingStatus) return false;
  const warehouse = Boolean(job.isWarehouseDelivery) || String(job.deliveryOrigin || '').toLowerCase() === 'warehouse';
  const arrived = job.warehouseAcceptedAt || job.siteWeighInWeight != null || job.siteArrivalWeight != null || job.siteWeighOutWeight != null || job.arrivedAtSiteAt || job.siteInTime || ['ARRIVED_AT_SITE', 'SITE_WEIGHED_IN', 'SITE_WEIGHED_OUT', 'COMPLETED'].includes(String(job.status || '').toUpperCase());
  return Boolean(arrived && (warehouse || !isBulkMaterial(job)));
}
async function claim(storeman, date, hour) {
  const id = `${date}_${hour}_${storeman.uid}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const ref = db.collection('storeReceivingReminderLogs').doc(id);
  let claimed = false;
  await db.runTransaction(async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists) return;
    transaction.create ? transaction.create(ref, { uid: storeman.uid, date, hour, createdAt: new Date().toISOString() }) : transaction.set(ref, { uid: storeman.uid, date, hour, createdAt: new Date().toISOString() });
    claimed = true;
  });
  return claimed;
}
async function sendPendingReminders(logger = console) {
  if (!isSmsConfigured()) return { skipped: true, reason: 'SMS_NOT_CONFIGURED' };
  const now = eatParts();
  const hour = Number(now.hour);
  if (hour < START_HOUR || hour >= END_HOUR || !REMINDER_HOURS.has(hour)) return { skipped: true, reason: 'OUTSIDE_REMINDER_WINDOW' };
  const jobs = snapshotStore.getAll('deliveryOrders');
  const users = snapshotStore.getAll('users').filter(user => String(user.role || '').toLowerCase() === 'storeman' && user.phone);
  let sent = 0;
  for (const storeman of users) {
    const count = jobs.filter(job => pendingForStore(job, storeman)).length;
    if (!count || !(await claim(storeman, `${now.year}-${now.month}-${now.day}`, hour))) continue;
    const noun = count === 1 ? 'delivery' : 'deliveries';
    const message = `[TruckSphere Alert] Hello Storekeeper, you have ${count} pending ${noun} waiting for receiving and inspection at the store. Please log in and process them: ${link}`;
    const result = await sendSMS(storeman.phone, message);
    if (result.success) sent++;
    else logger.error(`[Store Receiving SMS] Failed for ${storeman.uid}: ${result.error || 'unknown error'}`);
  }
  return { sent };
}
function startStoreReceivingReminders({ logger = console } = {}) {
  const run = () => sendPendingReminders(logger).catch(error => logger.error('[Store Receiving SMS] Scheduler failed:', error.message));
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  run();
  return () => clearInterval(timer);
}
module.exports = { eatParts, pendingForStore, sendPendingReminders, startStoreReceivingReminders };

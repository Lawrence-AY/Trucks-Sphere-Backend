const { normalizeJobStatus } = require('./jobLifecycle');
const { isWarehouseReceipt } = require('../modules/warehouse-jobs/receipt');

const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, '');
const assignedAt = (job) => Date.parse(job.assignedAt || job.dispatchedAt || job.createdAt || '') || 0;
function isSupersededForFuel(job, jobs) {
  return jobs.some((other) => {
    if (other.id === job.id || ['CANCELLED', 'CANCELED'].includes(normalizeJobStatus(other.status))) return false;
    const sameDriver = job.driverId && key(job.driverId) === key(other.driverId);
    const sameTruck = (job.vehicleId && key(job.vehicleId) === key(other.vehicleId)) ||
      (job.plateNumber && key(job.plateNumber) === key(other.plateNumber));
    return (sameDriver || sameTruck) && assignedAt(other) > assignedAt(job);
  });
}
function isFuelReady(job, jobs) {
  return !isWarehouseReceipt(job) && ['SITE_WEIGHED_OUT', 'COMPLETED'].includes(normalizeJobStatus(job.status)) && !isSupersededForFuel(job, jobs);
}
module.exports = { isFuelReady, isSupersededForFuel };

/**
 * Canonical delivery lifecycle.  Database values are always stored in this
 * form; legacy values are accepted at the API boundary for old clients.
 */
const JOB_STATUS = Object.freeze({
  CREATED: 'CREATED',
  ASSIGNED: 'ASSIGNED',
  QUARRY_QUEUED: 'QUARRY_QUEUED',
  QUARRY_WEIGHED_IN: 'QUARRY_WEIGHED_IN',
  QUARRY_WEIGHED_OUT: 'QUARRY_WEIGHED_OUT',
  DISPATCHED: 'DISPATCHED',
  IN_TRANSIT: 'IN_TRANSIT',
  ARRIVED_AT_SITE: 'ARRIVED_AT_SITE',
  SITE_WEIGHED_IN: 'SITE_WEIGHED_IN',
  SITE_WEIGHED_OUT: 'SITE_WEIGHED_OUT',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

const LEGACY_STATUS = Object.freeze({
  created: JOB_STATUS.CREATED,
  assigned: JOB_STATUS.ASSIGNED,
  queued: JOB_STATUS.QUARRY_QUEUED,
  quarry_queued: JOB_STATUS.QUARRY_QUEUED,
  at_quarry: JOB_STATUS.QUARRY_WEIGHED_IN,
  quarry_in: JOB_STATUS.QUARRY_WEIGHED_IN,
  quarry_weighed_in: JOB_STATUS.QUARRY_WEIGHED_IN,
  quarry_out: JOB_STATUS.QUARRY_WEIGHED_OUT,
  quarry_weighed_out: JOB_STATUS.QUARRY_WEIGHED_OUT,
  loaded: JOB_STATUS.DISPATCHED,
  dispatched: JOB_STATUS.DISPATCHED,
  in_transit: JOB_STATUS.IN_TRANSIT,
  en_route: JOB_STATUS.IN_TRANSIT,
  arrived: JOB_STATUS.ARRIVED_AT_SITE,
  arrived_at_site: JOB_STATUS.ARRIVED_AT_SITE,
  site_in: JOB_STATUS.SITE_WEIGHED_IN,
  weighed_in: JOB_STATUS.SITE_WEIGHED_IN,
  site_weighed_in: JOB_STATUS.SITE_WEIGHED_IN,
  site_weighed_out: JOB_STATUS.SITE_WEIGHED_OUT,
  delivered: JOB_STATUS.COMPLETED,
  completed: JOB_STATUS.COMPLETED,
  closed: JOB_STATUS.COMPLETED,
  cancelled: JOB_STATUS.CANCELLED,
  canceled: JOB_STATUS.CANCELLED,
});

const ACTIVE_TRACKING_STATUSES = new Set([
  JOB_STATUS.QUARRY_WEIGHED_OUT,
  JOB_STATUS.DISPATCHED,
  JOB_STATUS.IN_TRANSIT,
  JOB_STATUS.ARRIVED_AT_SITE,
]);
const TERMINAL_STATUSES = new Set([JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED]);

function normalizeJobStatus(status, fallback = JOB_STATUS.CREATED) {
  if (!status) return fallback;
  const value = String(status).trim();
  return JOB_STATUS[value] || LEGACY_STATUS[value.toLowerCase()] || fallback;
}

function isActiveJob(status) {
  return !TERMINAL_STATUSES.has(normalizeJobStatus(status));
}

function isTrackableJob(status) {
  return ACTIVE_TRACKING_STATUSES.has(normalizeJobStatus(status));
}

module.exports = { JOB_STATUS, normalizeJobStatus, isActiveJob, isTrackableJob, TERMINAL_STATUSES };

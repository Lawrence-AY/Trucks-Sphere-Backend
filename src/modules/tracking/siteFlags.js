function isSiteFlagged(job) {
  return job?.siteArrivalWeightVarianceFlagged === true || job?.siteArrivalWeightVarianceStatus === 'flagged' || job?.hasWeightDiscrepancy === true;
}
function siteFlagReason(job) {
  const explicit = job.siteArrivalWeightVarianceReason || job.siteFlagReason || job.flagReason || job.differenceNote;
  if (String(explicit || '').trim()) return String(explicit).trim();
  const variance = Number(job.siteArrivalWeightVariance);
  return Number.isFinite(variance) ? `Site arrival weight variance ${variance > 0 ? '+' : ''}${variance.toFixed(1)}T exceeds the allowed tolerance.` : 'Site weight discrepancy requires review.';
}
function newSiteFlag(job, previous = {}) {
  if (!isSiteFlagged(job) || (isSiteFlagged(previous) && siteFlagReason(job) === siteFlagReason(previous))) return null;
  return { status: 'flagged', source: 'operator_site', reason: siteFlagReason(job), flaggedBy: job.siteFlaggedBy || 'Site operator', flaggedByUid: job.siteFlaggedByUid || '', flaggedAt: job.siteFlaggedAt || job.updatedAt || new Date().toISOString(), flagLocation: job.siteName || job.siteId || '' };
}
module.exports = { isSiteFlagged, siteFlagReason, newSiteFlag };

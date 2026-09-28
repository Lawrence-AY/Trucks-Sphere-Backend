/**
 * Issues Service
 *
 * Stores and retrieves issues/tickets raised by operators and vendors.
 * Management can view all issues and mark them as resolved.
 * Each issue is linked to the user who submitted it.
 */

const snapshotStore = require('../../utils/snapshotStore');

/**
 * Get all issues, optionally filtered by userId or status.
 * @param {object} options
 * @param {string} [options.userId] - Filter by submitting user
 * @param {string} [options.status] - Filter by status ('open'|'resolved')
 * @param {boolean} [options.assignedToMe] - For resolvers to see issues assigned to them
 * @returns {object[]}
 */
function getIssues(options = {}) {
  let issues = snapshotStore.getAll('issues');

  if (options.userId) {
    issues = issues.filter((i) => i.submittedBy === options.userId);
  }
  if (options.status) {
    issues = issues.filter((i) => i.status === options.status);
  }
  if (options.assignedToMe && options.resolverId) {
    issues = issues.filter((i) => i.resolvedBy === options.resolverId || !i.resolvedBy);
  }

  // Sort by createdAt descending (newest first)
  issues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return issues;
}

/**
 * Build issues data with enriched user info.
 * @param {object} options
 * @returns {object[]}
 */
function buildIssuesReport(options = {}) {
  const issues = getIssues(options);
  const users = buildUserMap();

  return issues.map((issue) => ({
    id: issue.id || '',
    title: issue.title || '',
    description: issue.description || '',
    category: issue.category || 'general',
    status: issue.status || 'open',
    priority: issue.priority || 'medium',
    submittedBy: issue.submittedBy || '',
    submittedByName: users[issue.submittedBy]?.displayName || issue.submittedByName || 'Unknown',
    createdAt: issue.createdAt || '',
    resolvedAt: issue.resolvedAt || '',
    resolvedBy: issue.resolvedBy || '',
    resolvedByName: users[issue.resolvedBy]?.displayName || issue.resolvedByName || '',
    resolutionNotes: issue.resolutionNotes || '',
    notifiedUsers: issue.notifiedUsers || [],
  }));
}

function buildUserMap() {
  const users = snapshotStore.getAll('users');
  const map = {};
  (users || []).forEach((u) => {
    if (u.uid) map[u.uid] = u;
  });
  return map;
}

module.exports = {
  getIssues,
  buildIssuesReport,
};
/**
 * Issues Controller
 *
 * Handles CRUD for issues/tickets raised by operators, vendors, and management.
 * Issues can be created, viewed, and resolved via the API.
 */

const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { MANAGEMENT_ROLES, normalizeRole } = require('../../middleware/authorizationMiddleware');
const { logAudit } = require('../../middleware/auditMiddleware');
const ISSUE_STATUSES = new Set(['OPEN', 'IN_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']);

/**
 * GET /api/issues
 * List issues. Management sees all; operators/vendors see only their own.
 */
exports.findAll = async (req, res, next) => {
  try {
    const { uid, role } = req.user;
    const { status } = req.query;

    // Management/admin see all issues; others see only their own. Do not add
    // orderBy(createdAt) to this Firestore query: combining it with submittedBy
    // requires a composite index and prevents the Issues screen from loading.
    // The result set is small and is sorted below after the access filter.
    const isManagement = normalizeRole(role) === MANAGEMENT_ROLES.SUPER_ADMIN;
    let query = db.collection('issues');

    // A non-management user's submittedBy filter is the server-side privacy
    // boundary. Apply any status filter in memory to avoid a second index.
    if (status && isManagement) {
      query = query.where('status', '==', String(status).toUpperCase());
    }
    if (!isManagement) {
      query = query.where('submittedBy', '==', uid);
    }

    const snap = await query.get();
    const issues = [];
    snap.forEach((doc) => {
      issues.push({ id: doc.id, ...doc.data() });
    });

    if (status && !isManagement) {
      const requestedStatus = String(status).toUpperCase();
      for (let index = issues.length - 1; index >= 0; index -= 1) {
        if (String(issues[index].status || '').toUpperCase() !== requestedStatus) {
          issues.splice(index, 1);
        }
      }
    }

    issues.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
    );

    // Enrich with submitter names
    const userMap = {};
    try {
      const userSnap = await db.collection('users').get();
      userSnap.forEach((doc) => {
        const d = doc.data();
        userMap[doc.id] = d.displayName || d.name || '';
      });
    } catch {}

    const enriched = issues.map((issue) => ({
      ...issue,
      submittedByName: userMap[issue.submittedBy] || issue.submittedByName || 'Unknown',
      resolvedByName: userMap[issue.resolvedBy] || issue.resolvedByName || '',
    }));

    res.json(enriched);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/issues/:id
 * Get a single issue by ID.
 */
exports.findById = async (req, res, next) => {
  try {
    const doc = await db.collection('issues').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Issue not found' });
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/issues
 * Create a new issue. Sets submittedBy to the authenticated user.
 */
exports.create = async (req, res, next) => {
  try {
    const { uid, displayName, role } = req.user;
    const { title, description, category, priority } = req.body;

    // Super admins manage and resolve reported issues; they do not submit
    // tickets themselves, even if the endpoint is called directly.
    if (normalizeRole(role) === MANAGEMENT_ROLES.SUPER_ADMIN) {
      return res.status(403).json({ error: 'Super admins cannot submit issues.' });
    }

    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required.' });
    }

    const now = new Date().toISOString();
    const issue = {
      title: title.trim(),
      description: description.trim(),
      category: category || 'general',
      relatedModule: req.body.relatedModule || category || 'general',
      relatedRecordId: req.body.relatedRecordId || null,
      attachmentUrl: req.body.attachmentUrl || null,
      status: 'OPEN',
      priority: priority || 'medium',
      submittedBy: uid,
      submittedByName: displayName || req.user.email || '',
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolvedByName: null,
      resolutionNotes: null,
      notifiedUsers: [],
    };

    const docRef = await db.collection('issues').add(issue);
    // Also save the ID in the doc for in-memory reads
    await docRef.update({ id: docRef.id });

    // Notify management of new issue
    try {
      const notifySSEClients = req.app.get('notifySSEClients');
      if (notifySSEClients) {
        notifySSEClients('issues', { action: 'created', issue: { id: docRef.id, title, submittedBy: uid } });
      }
    } catch {}

    res.status(201).json({ id: docRef.id, ...issue });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/issues/:id
 * Update an issue (resolve, reassign, add notes).
 */
exports.update = async (req, res, next) => {
  try {
    const { uid, displayName, role } = req.user;
    const { status, resolutionNotes, priority } = req.body;
    const isManagement = normalizeRole(role) === MANAGEMENT_ROLES.SUPER_ADMIN;

    const docRef = db.collection('issues').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = doc.data();
    // Only the submitter or management can update
    if (!isManagement && issue.submittedBy !== uid) {
      return res.status(403).json({ error: 'You can only update your own issues.' });
    }

    const updates = { updatedAt: new Date().toISOString() };

    if (status) {
      const nextStatus = String(status).toUpperCase();
      if (!ISSUE_STATUSES.has(nextStatus)) return res.status(400).json({ error: 'Invalid issue status.' });
      if (!isManagement) return res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN' });
      updates.status = nextStatus;
    }
    if (priority) updates.priority = priority;
    if (resolutionNotes !== undefined) updates.resolutionNotes = resolutionNotes;

    // If resolving, set resolution metadata
    if (updates.status === 'RESOLVED') {
      updates.resolvedAt = new Date().toISOString();
      updates.resolvedBy = uid;
      updates.resolvedByName = displayName || '';
    }

    // If reopening, clear resolution metadata
    if (updates.status === 'OPEN' && String(issue.status).toUpperCase() === 'RESOLVED') {
      updates.resolvedAt = null;
      updates.resolvedBy = null;
      updates.resolvedByName = null;
      updates.resolutionNotes = null;
    }

    await docRef.update(updates);
    logAudit({ action: 'issue.status_changed', entityType: 'issue', entityId: doc.id, severity: 'info', metadata: { previousStatus: issue.status, newStatus: updates.status || issue.status }, req }).catch(() => {});

    // Notify SSE clients
    try {
      const notifySSEClients = req.app.get('notifySSEClients');
      if (notifySSEClients) {
        notifySSEClients('issues', { action: 'updated', issueId: req.params.id, status: status || issue.status });
      }
    } catch {}

    res.json({ id: doc.id, ...issue, ...updates });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/issues/:id
 * Delete an issue. Only the submitter or management can delete.
 */
exports.delete = async (req, res, next) => {
  try {
    const { uid, role } = req.user;
    const isManagement = normalizeRole(role) === MANAGEMENT_ROLES.SUPER_ADMIN;

    const docRef = db.collection('issues').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = doc.data();
    if (!isManagement && issue.submittedBy !== uid) {
      return res.status(403).json({ error: 'You can only delete your own issues.' });
    }

    await docRef.delete();
    res.json({ message: 'Issue deleted successfully' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/issues/:id/notify
 * Send a notification to the issue submitter when resolved.
 */
exports.notifySubmitter = async (req, res, next) => {
  try {
    const docRef = db.collection('issues').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = doc.data();
    // Create a notification for the submitter
    await db.collection('notifications').add({
      userId: issue.submittedBy,
      title: `Issue Resolved: ${issue.title}`,
      body: `Your issue "${issue.title}" has been resolved. ${issue.resolutionNotes || ''}`,
      type: 'issue_resolved',
      issueId: req.params.id,
      read: false,
      createdAt: new Date().toISOString(),
    });

    // Update notified users
    const notifiedUsers = [...(issue.notifiedUsers || []), issue.submittedBy];
    await docRef.update({ notifiedUsers });

    res.json({ message: 'Notification sent' });
  } catch (err) {
    next(err);
  }
};

/**
 * Audit Middleware — Firestore Audit Logging
 *
 * Automatically logs every API request to the Firestore auditLogs collection.
 * Captures: method, path, user, IP, timestamp, response status, duration.
 * Only logs non-GET requests and auth events to avoid noise.
 *
 * Also provides a manual audit log function for service-layer logging.
 */

const { db } = require('../../config/firebase');
const cryptoUtils = require('../utils/cryptoUtils');

// Routes to skip audit logging
const SKIP_PATHS = ['/api/health', '/api/test-firebase', '/api/sync/stream'];

function auditLogger(req, res, next) {
  if (!req.path.startsWith('/api') || SKIP_PATHS.some(p => req.path.startsWith(p))) return next();

  const startTime = Date.now();
  const requestId = cryptoUtils.generateSecureToken(8);
  req.requestId = requestId;

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;
    const isGet = req.method === 'GET';
    const isSuccess = statusCode >= 200 && statusCode < 300;
    const isAuthRoute = req.path.startsWith('/api/auth');

    // Skip successful GET reads to avoid noise, always log mutations & auth
    if (isGet && isSuccess && !isAuthRoute) return;

    const auditEntry = {
      requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      statusCode,
      durationMs,
      ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.connection?.remoteAddress || '',
      userAgent: (req.headers['user-agent'] || '').slice(0, 200),
      actor: req.user ? actorReference(req.user) : null,
      actorUid: req.user?.uid || 'anonymous',
      actorEmail: req.user?.email || '',
      actorName: req.user?.name || req.user?.displayName || '',
      actorRole: req.user?.role || '',
      queryParams: sanitizeForLog(req.query),
      bodySummary: summarizeBody(req.body, req.method, req.path),
    };

    db.collection('auditLogs').add(auditEntry).catch(err => {
      console.error('[Audit] Failed to write audit log:', err.message);
    });
  });

  next();
}

async function logAudit({ action, entityType, entityId = '', severity = 'info', metadata = {}, req = null }) {
  try {
    const entry = {
      action, entityType, entityId, severity, metadata,
      timestamp: new Date().toISOString(),
      actor: req?.user ? actorReference(req.user) : null,
      actorUid: req?.user?.uid || 'system',
      actorEmail: req?.user?.email || '',
      actorName: req?.user?.name || req?.user?.displayName || 'system',
      actorRole: req?.user?.role || '',
      ipAddress: req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip || '',
      userAgent: (req?.headers?.['user-agent'] || '').slice(0, 200),
    };
    await db.collection('auditLogs').add(entry);
  } catch (err) {
    console.error('[Audit] Failed to write manual audit:', err.message);
  }
}

function actorReference(user) {
  return {
    uid: user.uid || '',
    username: user.username || user.email?.split('@')[0] || '',
    displayName: user.displayName || user.name || user.email || 'system',
    email: user.email || '',
    role: user.role || '',
    ...(user.entityId ? { entityId: user.entityId, entityType: user.entityType } : {}),
  };
}

function sanitizeForLog(query) {
  if (!query || typeof query !== 'object') return {};
  const clean = { ...query };
  ['password', 'token', 'secret', 'apiKey', 'api_key', 'key'].forEach(f => { if (clean[f]) clean[f] = '[REDACTED]'; });
  return clean;
}

function summarizeBody(body, method, path) {
  if (!body || typeof body !== 'object') return null;
  if (path.startsWith('/api/auth')) {
    if (path.includes('login')) return { action: 'login' };
    if (path.includes('register')) return { action: 'register' };
    if (path.includes('change-password')) return { action: 'changePassword' };
    return { action: 'auth' };
  }
  const sensitives = ['password', 'token', 'secret', 'refreshToken', 'idToken', 'currentPassword', 'newPassword', 'confirmPassword'];
  const summary = {};
  for (const [key, value] of Object.entries(body)) {
    if (sensitives.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      summary[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 100) {
      summary[key] = value.slice(0, 100) + '...';
    } else if (typeof value === 'object') {
      summary[key] = '[OBJECT]';
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

module.exports = { auditLogger, logAudit };

const MANAGEMENT_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  EDIT: 'management_edit',
  LITE: 'management_lite',
});

const LEGACY_ROLES = Object.freeze({ management: MANAGEMENT_ROLES.EDIT, admin: MANAGEMENT_ROLES.SUPER_ADMIN });

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return LEGACY_ROLES[value] || value;
}

function forbid(res) {
  return res.status(403).json({ error: 'FORBIDDEN', code: 'FORBIDDEN', message: 'You do not have permission for this action.' });
}

function requireRoles(...roles) {
  const allowed = new Set(roles.map(normalizeRole));
  return (req, res, next) => allowed.has(normalizeRole(req.user?.role)) ? next() : forbid(res);
}

function requireManagementAccess({ allowLite = false, write = false, superAdminOnly = false } = {}) {
  return (req, res, next) => {
    const role = normalizeRole(req.user?.role);
    if (role === MANAGEMENT_ROLES.SUPER_ADMIN) return next();
    if (superAdminOnly) return forbid(res);
    if (role === MANAGEMENT_ROLES.EDIT) return next();
    if (allowLite && !write && role === MANAGEMENT_ROLES.LITE) return next();
    // Lite accounts may only create drivers, vendors and vehicles; they do
    // not update or delete existing records.
    if (allowLite && write && req.method === 'POST' && role === MANAGEMENT_ROLES.LITE) return next();
    return forbid(res);
  };
}

module.exports = { MANAGEMENT_ROLES, normalizeRole, requireRoles, requireManagementAccess };

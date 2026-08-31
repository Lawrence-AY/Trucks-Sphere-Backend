const MANAGEMENT_ROLES = Object.freeze({
  SUPER_ADMIN: 'superadmin',
  ADMIN: 'admin',
  ADMIN_LITE: 'adminlite',
  // Compatibility aliases for modules not yet migrated to the clearer names.
  EDIT: 'admin',
  LITE: 'adminlite',
});

const LEGACY_ROLES = Object.freeze({
  super_admin: MANAGEMENT_ROLES.SUPER_ADMIN,
  management: MANAGEMENT_ROLES.ADMIN,
  management_edit: MANAGEMENT_ROLES.ADMIN,
  management_lite: MANAGEMENT_ROLES.ADMIN_LITE,
  admin_lite: MANAGEMENT_ROLES.ADMIN_LITE,
  // Operational aliases used by older seeded and Firebase-auth accounts.
  // Normalize them once so every route makes the same authorization decision.
  quarry_operator: 'operator_quarry',
  site_operator: 'operator_site',
  fuel_operator: 'operator_fuel',
  'operator-quarry': 'operator_quarry',
  'operator-site': 'operator_site',
  'operator-fuel': 'operator_fuel',
  warehouse_operator: 'operator_warehouse',
  'operator-warehouse': 'operator_warehouse',
  // Inspector account labels used by earlier setup screens and imports.
  material_inspector: 'inspector',
  quality_inspector: 'inspector',
  site_inspector: 'inspector',
  'material-inspector': 'inspector',
  'quality-inspector': 'inspector',
  'site-inspector': 'inspector',
});

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

function requireManagementAccess({ allowLite = false, write = false, allowAdminWrite = false, allowLiteWrite = false, superAdminOnly = false } = {}) {
  return (req, res, next) => {
    const role = normalizeRole(req.user?.role);
    if (role === MANAGEMENT_ROLES.SUPER_ADMIN) return next();
    if (superAdminOnly) return forbid(res);
    if (role === MANAGEMENT_ROLES.ADMIN) {
      if (!write || allowAdminWrite) return next();
      return forbid(res);
    }
    if (allowLite && !write && role === MANAGEMENT_ROLES.LITE) return next();
    // Admin Lite may create and edit the operational records explicitly
    // granted to it, but never delete them.
    if (allowLite && write && allowLiteWrite && ['POST', 'PUT', 'PATCH'].includes(req.method) && role === MANAGEMENT_ROLES.LITE) return next();
    if (allowLite && write && req.method === 'POST' && role === MANAGEMENT_ROLES.LITE) return next();
    return forbid(res);
  };
}

module.exports = { MANAGEMENT_ROLES, normalizeRole, requireRoles, requireManagementAccess };

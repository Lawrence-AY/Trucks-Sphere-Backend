const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');
const createResourceController = require('../../utils/resourceControllerFactory');
const createResourceService = require('../../utils/resourceServiceFactory');
const { normalizeQuarryLocation } = require('../../utils/quarryLocations');
const { MANAGEMENT_ROLES, normalizeRole } = require('../../middleware/authorizationMiddleware');

function isManagementEdit(req) {
  return normalizeRole(req.user?.role) === MANAGEMENT_ROLES.EDIT;
}

function isSuperAdmin(user) {
  return normalizeRole(user?.role) === MANAGEMENT_ROLES.SUPER_ADMIN;
}

function isDriverAccountRole(role) {
  return normalizeRole(role) === 'driver';
}

const service = createResourceService({
  collectionName: 'users',
  searchableFields: ['displayName', 'name', 'email', 'username', 'generatedUsername', 'role'],
  defaultSortField: 'displayName',
  defaultSortDirection: 'asc',
});

const baseController = createResourceController(service);

exports.findAll = baseController.findAll;
exports.findById = baseController.findById;
exports.create = async (req, res, next) => {
  if (isDriverAccountRole(req.body.role)) {
    return res.status(400).json({ error: 'Drivers are operational records and cannot be created as user accounts.' });
  }
  if (isManagementEdit(req) && normalizeRole(req.body.role) === MANAGEMENT_ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Management Edit cannot create Super Admin users.' });
  }
  if (req.body.role === 'vendor') {
    return res.status(400).json({ error: 'Vendor accounts must be created through the vendor onboarding workflow.' });
  }
  return baseController.create(req, res, next);
};

exports.update = async (req, res, next) => {
  try {
    const existing = await db.collection('users').doc(req.params.id).get();
    if (!existing.exists) return res.status(404).json({ error: 'Not found' });

    const current = existing.data();
    const { displayName, email, phone, role, isActive, username, generatedUsername, quarryLocation } = req.body;
    if (role !== undefined && isDriverAccountRole(role)) {
      return res.status(400).json({ error: 'Drivers are operational records and cannot be assigned as user accounts.' });
    }
    if (
      isManagementEdit(req) &&
      (isSuperAdmin(current) || (role !== undefined && normalizeRole(role) === MANAGEMENT_ROLES.SUPER_ADMIN))
    ) {
      return res.status(403).json({ error: 'Management Edit cannot manage Super Admin users.' });
    }
    const uid = current.uid || current.authUid || req.params.id;
    const effectiveRole = role !== undefined ? role : current.role;
    const normalizedQuarryLocation = normalizeQuarryLocation(quarryLocation);
    const isQuarryStationUpdate = effectiveRole === 'operator_quarry' && (role !== undefined || quarryLocation !== undefined);
    if (isQuarryStationUpdate && !normalizedQuarryLocation) {
      return res.status(400).json({ error: 'A valid quarry station is required for an operator at quarry.' });
    }
    const authUpdates = {};
    if (displayName !== undefined) authUpdates.displayName = displayName;
    if (email !== undefined) authUpdates.email = String(email).trim().toLowerCase();
    if (isActive !== undefined) authUpdates.disabled = !isActive;
    if (Object.keys(authUpdates).length) await getAuth().updateUser(uid, authUpdates);
    if (role !== undefined) await getAuth().setCustomUserClaims(uid, { role });

    const updates = {
      ...(displayName !== undefined && { displayName }),
      ...(email !== undefined && { email: String(email).trim().toLowerCase() }),
      ...(phone !== undefined && { phone }),
      ...(role !== undefined && { role }),
      ...(isActive !== undefined && { isActive }),
      ...(username !== undefined && { username }),
      ...(generatedUsername !== undefined && { generatedUsername }),
      ...(effectiveRole === 'operator_quarry' && { quarryLocation: normalizedQuarryLocation }),
      ...(effectiveRole !== 'operator_quarry' && quarryLocation !== undefined && { quarryLocation: '' }),
      updatedAt: new Date().toISOString(),
      updatedBy: req.body.updatedBy,
    };
    await existing.ref.update(updates);
    res.json({ id: req.params.id, ...current, ...updates });
  } catch (error) { next(error); }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const existing = await db.collection('users').doc(req.params.id).get();
    if (!existing.exists) return res.status(404).json({ error: 'Not found' });
    const current = existing.data();
    if (isManagementEdit(req) && isSuperAdmin(current)) {
      return res.status(403).json({ error: 'Management Edit cannot manage Super Admin users.' });
    }
    const uid = current.uid || current.authUid || req.params.id;
    await getAuth().updateUser(uid, { password });
    await existing.ref.update({
      passwordChangedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: req.body.updatedBy,
    });
    res.json({ message: 'Password reset successfully' });
  } catch (error) { next(error); }
};

exports.delete = async (req, res, next) => {
  try {
    const existing = await db.collection('users').doc(req.params.id).get();
    if (!existing.exists) return res.status(404).json({ error: 'Not found' });
    const current = existing.data();
    if (isManagementEdit(req) && isSuperAdmin(current)) {
      return res.status(403).json({ error: 'Management Edit cannot manage Super Admin users.' });
    }
    const uid = current.uid || current.authUid || req.params.id;
    await getAuth().deleteUser(uid);
    await existing.ref.delete();
    res.json({ message: 'Deleted successfully' });
  } catch (error) { next(error); }
};

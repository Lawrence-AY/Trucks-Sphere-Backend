const { getAuth } = require('firebase-admin/auth');
const { db } = require('../../../config/firebase');
const createResourceController = require('../../utils/resourceControllerFactory');
const createResourceService = require('../../utils/resourceServiceFactory');

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
    const uid = current.uid || current.authUid || req.params.id;
    const { displayName, email, phone, role, isActive, username, generatedUsername } = req.body;
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
      updatedAt: new Date().toISOString(),
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
    const uid = existing.data().uid || existing.data().authUid || req.params.id;
    await getAuth().updateUser(uid, { password });
    await existing.ref.update({ passwordChangedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    res.json({ message: 'Password reset successfully' });
  } catch (error) { next(error); }
};

exports.delete = async (req, res, next) => {
  try {
    const existing = await db.collection('users').doc(req.params.id).get();
    if (!existing.exists) return res.status(404).json({ error: 'Not found' });
    const uid = existing.data().uid || existing.data().authUid || req.params.id;
    await getAuth().deleteUser(uid);
    await existing.ref.delete();
    res.json({ message: 'Deleted successfully' });
  } catch (error) { next(error); }
};

const driversService = require('./service');
const { verifyDriverIdentity, lookupDriverIdentity } = require('../../integrations/iprsService');

function scopedQuery(req) {
  return req.user?.role === 'vendor' ? { ...req.query, vendorId: req.user?.entityId || '__none__' } : req.query;
}

function isOutsideVendorScope(req, item) {
  return req.user?.role === 'vendor' && (!req.user?.entityId || item?.vendorId !== req.user.entityId);
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await driversService.findAll(scopedQuery(req));
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await driversService.findById(req.params.id);
    if (isOutsideVendorScope(req, item)) return res.status(404).json({ error: 'Not found' });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const nationalId = String(req.body.nationalId || '').trim();
    if (!nationalId) return res.status(400).json({ code: 'NATIONAL_ID_REQUIRED', error: 'NATIONAL_ID_REQUIRED' });
    const existing = await driversService.findByNationalId(nationalId);
    if (existing) {
      const vendorId = req.body.vendorId;
      if (vendorId && existing.vendorId !== vendorId) {
        return res.status(409).json({ code: 'DRIVER_ALREADY_ASSIGNED', error: 'DRIVER_ALREADY_ASSIGNED', driver: existing });
      }
      return res.status(200).json({ ...existing, existing: true });
    }
    const registrationSource = String(req.body.registrationSource || '').toUpperCase();
    const manual = registrationSource === 'MANUAL' || req.body.manualEntry === true;
    const firstName = String(req.body.firstName || '').trim();
    const surname = String(req.body.surname || '').trim();
    if (!firstName || !surname) {
      return res.status(400).json({ code: 'DRIVER_NAME_REQUIRED', error: 'DRIVER_NAME_REQUIRED' });
    }
    if (manual) {
      const item = await driversService.create({
        ...req.body,
        registrationSource: 'MANUAL',
        iprsVerified: false,
        registeredBy: req.user?.id || req.user?.uid || req.user?.userId || '',
      });
      return res.status(201).json(item);
    }
    await verifyDriverIdentity({ nationalId, firstName, surname });
    const item = await driversService.create({
      ...req.body,
      registrationSource: req.body.registrationSource === 'IPRS_BACKUP' ? 'IPRS_BACKUP' : 'IPRS',
      iprsVerified: true,
      registeredBy: req.user?.id || req.user?.uid || req.user?.userId || '',
    });
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.checkNationalId = async (req, res, next) => {
  try {
    const available = await driversService.isNationalIdAvailable(
      req.params.nationalId,
      req.query.excludeId,
    );
    res.json({ available });
  } catch (err) { next(err); }
};

exports.verifyIdentity = async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try {
    const result = await verifyDriverIdentity(req.body);
    res.json(result);
  } catch (err) { next(err); }
};

exports.lookupIdentity = async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  try { res.json(await lookupDriverIdentity(req.body)); } catch (err) {
    if (err.code === 'IPRS_NO_MATCH' || err.statusCode === 404) {
      return res.status(200).json({ verified: false, noMatch: true, source: null });
    }
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    if (['nationalId', 'firstName', 'surname'].some((key) => Object.prototype.hasOwnProperty.call(req.body, key))) {
      const existing = await driversService.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      await verifyDriverIdentity({
        nationalId: req.body.nationalId ?? existing.nationalId,
        firstName: req.body.firstName ?? existing.firstName,
        surname: req.body.surname ?? existing.surname,
      });
    }
    const item = await driversService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await driversService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

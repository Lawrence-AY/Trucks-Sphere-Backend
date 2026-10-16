const { normalizeVendorId } = require('../../utils/vendorFleet');
const vendorsService = require('./service');
const kraService = require('../../integrations/kraService');

function vendorScope(req) {
  return req.user?.role === 'vendor' ? req.user?.vendorId || req.user?.entityId || '' : '';
}

exports.findAll = async (req, res, next) => {
  try {
    const items = await vendorsService.findAll(req.query);
    const vendorId = vendorScope(req);
    if (vendorId) {
      const data = items.data.filter((item) => item.id === vendorId || item.vendorId === vendorId);
      return res.json({ ...items, data, total: data.length, totalPages: data.length ? 1 : 0 });
    }
    res.json(items);
  } catch (err) { next(err); }
};

exports.findById = async (req, res, next) => {
  try {
    const item = await vendorsService.findById(req.params.id);
    if (vendorScope(req) && (!item || (item.id !== vendorScope(req) && item.vendorId !== vendorScope(req)))) return res.status(404).json({ error: 'Not found' });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    const item = await vendorsService.create(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.findDocuments = async (req, res, next) => {
  try {
    const item = await vendorsService.findById(req.params.id);
    if (!item || (vendorScope(req) && item.id !== vendorScope(req) && item.vendorId !== vendorScope(req))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(Array.isArray(item.documents) ? item.documents : []);
  } catch (err) { next(err); }
};

exports.previewUsername = async (req, res, next) => {
  try {
    const username = await vendorsService.previewUsername(req.query.contactPerson || req.query.companyName);
    res.json({ username });
  } catch (err) { next(err); }
};

exports.validateKraPin = async (req, res, next) => {
  try { res.json(await kraService.validatePin(req.body?.kraPin || req.body?.KRAPIN)); } catch (err) { next(err); }
};

exports.createWithAccount = async (req, res, next) => {
  try {
    const item = await vendorsService.createWithAccount(req.body);
    res.status(201).json(item);
  } catch (err) { next(err); }
};

exports.update = async (req, res, next) => {
  try {
    const item = await vendorsService.update(req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (err) { next(err); }
};

exports.delete = async (req, res, next) => {
  try {
    await vendorsService.delete(req.params.id);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { next(err); }
};

exports.listAliases = async (req, res, next) => {
  try { res.json(await vendorsService.listAliases(req.params.id)); } catch (err) { next(err); }
};

exports.addAlias = async (req, res, next) => {
  try { res.status(201).json(await vendorsService.addAlias(req.params.id, req.body.alias)); } catch (err) { next(err); }
};

exports.removeAlias = async (req, res, next) => {
  try { await vendorsService.removeAlias(req.params.aliasId); res.json({ message: 'Alias removed' }); } catch (err) { next(err); }
};

exports.findFleet = async (req, res, next) => {
  try {
    const vendor = await vendorsService.findById(req.params.id);
    const scope = vendorScope(req);
    if (!vendor || (req.user?.role === 'vendor' && (!scope || normalizeVendorId(scope) !== normalizeVendorId(vendor.id)))) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(await vendorsService.findFleet(vendor.id));
  } catch (error) { next(error); }
};

exports.createAccount = async (req, res, next) => {
  try {
    const result = await vendorsService.createAccount(req.params.id, req.body);
    res.status(201).json(result);
  } catch (error) { next(error); }
};

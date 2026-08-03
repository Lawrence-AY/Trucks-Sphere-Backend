const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { syncPurchaseOrder } = require('../../integrations/odooPurchaseService');
const collectionRef = db.collection('purchaseOrders');

/**
 * Normalize vendor ID to consistent format e.g. "v1" → "V001", "1" → "V001"
 */
function normalizeVendorId(raw) {
  if (!raw) return '';
  let str = String(raw).trim();
  const match = str.match(/^([Vv]?)(\d+)$/);
  if (match) {
    const num = parseInt(match[2], 10);
    return `V${String(num).padStart(3, '0')}`;
  }
  return str;
}

/**
 * Normalize material ID to consistent format e.g. "m1", "mat1" → "MAT001", "1" → "MAT001"
 */
function normalizeMaterialId(raw) {
  if (!raw) return '';
  let str = String(raw).trim();
  const match = str.match(/^([Mm]?(?:at)?)(\d+)$/i);
  if (match) {
    const num = parseInt(match[2], 10);
    return 'MAT' + String(num).padStart(3, '0');
  }
  return str.toUpperCase();
}

const COLLECTION_NAME = 'purchaseOrders';

function findReference(collectionName, id) {
  const requested = String(id || '').trim().toLowerCase();
  if (!requested) return null;
  return snapshotStore.getAll(collectionName).find((item) =>
    [item.id, item.vendorId, item.materialId]
      .filter(Boolean)
      .some((value) => String(value).trim().toLowerCase() === requested)
  ) || null;
}

function displayNumber(value, prefix) {
  const raw = String(value || '').trim();
  return raw.replace(new RegExp(`^${prefix}`, 'i'), '') || raw;
}

const purchase_ordersService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   */
  findAll(query = {}) {
    const { search, status, vendorId, quarryId, siteId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (status) results = results.filter(item => item.status === status);
    if (vendorId) results = results.filter(item => item.vendorId === vendorId);
    if (quarryId) results = results.filter(item => item.quarryId === quarryId);
    if (siteId) results = results.filter(item => item.siteId === siteId);
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(item =>
        (item.poNumber || '').toLowerCase().includes(s) ||
        (item.vendorName || '').toLowerCase().includes(s) ||
        (item.materialName || '').toLowerCase().includes(s)
      );
    }

    const start = (page - 1) * parseInt(limit);
    return {
      data: results.slice(start, start + parseInt(limit)),
      total: results.length,
      page: parseInt(page),
      totalPages: Math.ceil(results.length / parseInt(limit)),
    };
  },

  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
  },

  /**
   * Create a Purchase Order.
   * PO number format: POMAT###/V### = POMAT{MaterialNumber}/{VendorNumber}
   * Example: POMAT001/V001 (material MAT001, vendor V001)
   */
  async create(data) {
    try {
      // Retired form fields are deliberately ignored for old clients.
      const { expectedCompletion, notes, ...payload } = data;
      const quantity = Number(payload.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        const error = new Error('Quantity must be a positive number.');
        error.statusCode = 400;
        throw error;
      }

      const vendor = findReference('vendors', payload.vendorId);
      const material = findReference('materials', payload.materialId);
      const quarry = payload.quarryId ? findReference('quarries', payload.quarryId) : null;
      const site = payload.siteId ? findReference('sites', payload.siteId) : null;
      if (!vendor || !material || (payload.quarryId && !quarry) || (payload.siteId && !site)) {
        const missing = !vendor ? 'vendor' : !material ? 'material' : payload.quarryId && !quarry ? 'quarry/source' : 'delivery destination';
        const error = new Error(`A valid ${missing} is required.`);
        error.statusCode = 400;
        throw error;
      }

      // Normalize material ID → MAT### number
      const materialId = normalizeMaterialId(material.id || payload.materialId);
      const matNum = materialId ? materialId : 'MAT000';

      // Normalize vendor ID → V### number
      let vendorIdShort = '';
      vendorIdShort = normalizeVendorId(vendor.vendorId || vendor.id || payload.vendorId);

      // Build PO number: POMAT###/V###
      const poNumber = vendorIdShort
        ? `${matNum.replace('MAT', 'POMAT')}/${vendorIdShort}`
        : matNum.replace('MAT', 'POMAT');

      const docId = poNumber.replace(/\//g, '-');
      const docRef = collectionRef.doc(docId);

      // Check for duplicate — do NOT overwrite an existing PO
      const existingSnap = await docRef.get();
      if (existingSnap.exists) {
        const existing = existingSnap.data();
        const error = new Error(
          `A purchase order already exists for this vendor and material combination.\n\n` +
          `PO: ${existing.poNumber}\n` +
          `Status: ${existing.status}\n` +
          `Delivered: ${existing.quantityDelivered || 0}/${existing.quantity || 0} ${existing.unit || 'units'}\n\n` +
          `Please use the existing order or contact management.`
        );
        error.statusCode = 409;
        throw error;
      }

      const item = {
        ...payload,
        id: docId,
        poNumber,
        vendorId: vendor.id,
        vendorNumber: displayNumber(vendor.vendorId || vendor.id, 'V'),
        vendorName: vendor.companyName || vendor.name || '',
        companyName: vendor.companyName || vendor.name || '',
        materialId: material.id,
        materialNumber: displayNumber(material.id, 'MAT'),
        materialName: material.name || '',
        ...(quarry ? { quarryId: quarry.id, quarryName: quarry.name || quarry.location?.address || '' } : {}),
        ...(site ? { siteId: site.id, siteName: site.name || site.location?.address || '' } : {}),
        quantity,
        unit: payload.unit || material.defaultUnit || material.measurementType || 'units',
        status: 'approved',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Odoo is synchronized before the local record is committed. This keeps
      // a successful TruckSphere creation coupled to a successful Odoo entry;
      // the Odoo client reference makes a retry safe after an interrupted call.
      const odooFields = await syncPurchaseOrder({ purchaseOrder: item, vendor, material });
      Object.assign(item, odooFields);
      await docRef.set(item);
      return { id: docId, ...item };
    } catch (error) {
      console.error('purchase_ordersService.create error:', error);
      throw error;
    }
  },

  async update(id, data) {
    try {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return null;
      // PO numbers are immutable and retired fields must never be written
      // again by an older mobile build.
      const { expectedCompletion, notes, poNumber, ...updates } = data;
      if (updates.quantity !== undefined && (!Number.isFinite(Number(updates.quantity)) || Number(updates.quantity) <= 0)) {
        const error = new Error('Quantity must be a positive number.');
        error.statusCode = 400;
        throw error;
      }
      updates.updatedAt = new Date().toISOString();
      await docRef.update(updates);
      return { id, ...doc.data(), ...updates };
    } catch (error) {
      console.error('purchase_ordersService.update error:', error);
      throw error;
    }
  },

  /**
   * Get the preview of the PO number based on vendor and material.
   * Format: POMAT###/V### = POMAT{MaterialNumber}/{VendorNumber}
   */
  async previewNumber(vendorId, materialId) {
    try {
      const materialIdNorm = normalizeMaterialId(materialId);
      const matNum = materialIdNorm ? materialIdNorm : 'MAT000';

      const vendor = findReference('vendors', vendorId);
      const vendorShort = normalizeVendorId(vendor?.vendorId || vendor?.id || vendorId);

      return vendorShort
        ? `${matNum.replace('MAT', 'POMAT')}/${vendorShort}`
        : matNum.replace('MAT', 'POMAT');
    } catch (error) {
      console.error('purchase_ordersService.previewNumber error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('purchase_ordersService.delete error:', error);
      throw error;
    }
  },
};

module.exports = purchase_ordersService;

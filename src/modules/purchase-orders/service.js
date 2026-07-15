const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const vendorsService = require('../vendors/service');
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
    return `v${String(num).padStart(3, '0')}`;
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

const purchase_ordersService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   */
  findAll(query = {}) {
    const { search, status, vendorId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (status) results = results.filter(item => item.status === status);
    if (vendorId) results = results.filter(item => item.vendorId === vendorId);
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
      // Normalize material ID → MAT### number
      const materialId = normalizeMaterialId(data.materialId);
      const matNum = materialId ? materialId : 'MAT000';

      // Normalize vendor ID → V### number
      let vendorIdShort = '';
      if (data.vendorId) {
        try {
          const vendor = await vendorsService.findById(data.vendorId);
          const rawId = vendor?.id || vendor?.vendorId || '';
          vendorIdShort = normalizeVendorId(rawId);
        } catch (_) { /* ignore */ }
      }
      if (!vendorIdShort && data.vendorId) {
        vendorIdShort = normalizeVendorId(data.vendorId);
      }

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
        ...data,
        id: docId,
        poNumber,
        companyName: data.companyName || data.vendorName || '',
        status: data.status || 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
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
      const updates = { ...data, updatedAt: new Date().toISOString() };
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

      let vendorShort = '';
      if (vendorId) {
        try {
          const vendor = await vendorsService.findById(vendorId);
          const rawId = vendor?.id || vendor?.vendorId || '';
          vendorShort = normalizeVendorId(rawId);
        } catch (_) { /* ignore */ }
      }
      if (!vendorShort && vendorId) {
        vendorShort = normalizeVendorId(vendorId);
      }

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
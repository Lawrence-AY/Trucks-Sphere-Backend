const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { isWarehousePurchaseOrder } = require('./warehouse');
const { getNextId, peekNextId } = require('../../utils/counterService');
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

    // Surface the material's warehouse designation on every PO. Older POs
    // predate this denormalized field, so resolve it from the material cache
    // as well; warehouse clients can then list the correct orders reliably.
    results = results.map((item) => {
      return { ...item, isWarehouseMaterial: isWarehousePurchaseOrder(item, snapshotStore.getAll('materials')) };
    });

    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (query.excludeWarehouse === true) results = results.filter(item => !item.isWarehouseMaterial);
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
    return doc ? { ...doc, isWarehouseMaterial: isWarehousePurchaseOrder(doc, snapshotStore.getAll('materials')) } : null;
  },

  /**
   * Create a Purchase Order.
   * PO number format: PO#####/V###. Example: PO0001/V002.
   */
  async create(data) {
    try {
      // Retired form fields are deliberately ignored for old clients.
      const { expectedCompletion, notes, ...payload } = data;
      const vendor = findReference('vendors', payload.vendorId);
      const requestedLines = Array.isArray(payload.materials) && payload.materials.length
        ? payload.materials
        : [{ materialId: payload.materialId, quantity: payload.quantity, unit: payload.unit }];
      const lines = requestedLines.map((line) => {
        const material = findReference('materials', line.materialId);
        const quantity = Number(line.quantity);
        if (!material || (!material.isWarehouseMaterial && (!Number.isFinite(quantity) || quantity <= 0))) return null;
        return {
          materialId: material.id,
          materialNumber: displayNumber(material.materialId || material.id, 'MAT'),
          materialName: material.name || '',
          isWarehouseMaterial: Boolean(material.isWarehouseMaterial),
          quantity: material.isWarehouseMaterial ? null : quantity,
          unit: material.isWarehouseMaterial ? null : material.measurementType || material.defaultUnit || line.unit || 'units',
          material,
        };
      });
      const material = lines[0]?.material;
      if (lines.length > 1 && lines.some((line) => line?.isWarehouseMaterial)) {
        const error = new Error('A warehouse-reference purchase order can contain only one material.');
        error.statusCode = 400;
        error.code = 'WAREHOUSE_PO_SINGLE_MATERIAL_REQUIRED';
        throw error;
      }
      const quarry = payload.quarryId ? findReference('quarries', payload.quarryId) : null;
      const site = payload.siteId ? findReference('sites', payload.siteId) : null;
      if (!vendor || !material || lines.some((line) => !line) || (payload.quarryId && !quarry) || (payload.siteId && !site)) {
        const missing = !vendor ? 'vendor' : !material ? 'material' : payload.quarryId && !quarry ? 'quarry/source' : 'delivery destination';
        const error = new Error(`A valid ${missing} is required.`);
        error.statusCode = 400;
        throw error;
      }

      // A timed-out mobile request can still finish on the server. Reusing a
      // client request ID makes a retry return that first PO instead of
      // creating a second one.
      if (payload.clientRequestId) {
        const prior = await collectionRef.where('clientRequestId', '==', String(payload.clientRequestId)).limit(1).get();
        if (!prior.empty) return { id: prior.docs[0].id, ...prior.docs[0].data() };
      }

      const hasQuantity = payload.quantity !== undefined && payload.quantity !== null && String(payload.quantity).trim() !== '';
      const quantity = hasQuantity ? Number(payload.quantity) : 0;
      if (!Array.isArray(payload.materials) && (
        (!material.isWarehouseMaterial && (!Number.isFinite(quantity) || quantity <= 0)) ||
        (material.isWarehouseMaterial && hasQuantity && (!Number.isFinite(quantity) || quantity < 0))
      )) {
        const error = new Error(material.isWarehouseMaterial
          ? 'Quantity must be zero or a positive number when supplied.'
          : 'Quantity must be a positive number.');
        error.statusCode = 400;
        throw error;
      }

      // Normalize material ID → MAT### number
      const materialId = normalizeMaterialId(material.id || payload.materialId);
      const matNum = materialId ? materialId : 'MAT000';

      // Normalize vendor ID → V### number
      let vendorIdShort = '';
      vendorIdShort = normalizeVendorId(vendor.vendorId || vendor.id || payload.vendorId);

      // Build PO number: PO#####/V###.
      // New PO numbering deliberately starts at PO0001, independently of
      // the retired POMAT sequence.
      const poNumber = `${await getNextId('purchase_order_v2')}/${vendorIdShort}`;

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
        isWarehouseMaterial: Boolean(material.isWarehouseMaterial),
        ...(quarry ? { quarryId: quarry.id, quarryName: quarry.name || quarry.location?.address || '' } : {}),
        ...(site ? { siteId: site.id, siteName: site.name || site.location?.address || '' } : {}),
        quantity: lines[0].quantity,
        unit: lines[0].unit,
        materials: lines.map(({ material: _material, ...line }) => line),
        status: 'approved',
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
   * Get the preview of the next PO number based on vendor.
   * Format: PO#####/V###.
   */
  async previewNumber(vendorId, materialId) {
    try {
      const vendor = findReference('vendors', vendorId);
      const vendorShort = normalizeVendorId(vendor?.vendorId || vendor?.id || vendorId);
      const sequence = await peekNextId('purchase_order_v2');
      return vendorShort ? `${sequence}/${vendorShort}` : sequence;
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

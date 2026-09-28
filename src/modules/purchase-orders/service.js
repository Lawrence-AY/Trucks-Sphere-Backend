const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('purchaseOrders');

const COLLECTION_NAME = 'purchaseOrders';

const purchase_ordersService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   * Avoids composite index requirements and eliminates Firestore reads per request.
   */
  findAll(query = {}) {
    const { search, status, vendorId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending
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
   * Create a Purchase Order with simple POMAT### number.
   * Quarry, site, driver, job, and pricing will be added later on delivery/receipt notes.
   */
  async create(data) {
    try {
      // Use client-provided poNumber if present, otherwise auto-generate
      const poNumber = data.poNumber || await getNextId('purchase_order');
      // Firestore doc IDs cannot contain /, so sanitize for the doc ID only
      const docId = poNumber.replace(/\//g, '-');
      const docRef = collectionRef.doc(docId);
      const item = {
        ...data,
        id: docId,
        poNumber,
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
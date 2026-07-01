const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('purchaseOrders');

const purchase_ordersService = {
  async findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;
    try {
      // Post-filter to avoid composite index errors
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.poNumber || '').toLowerCase().includes(s) ||
          (item.vendorName || '').toLowerCase().includes(s) ||
          (item.materialName || '').toLowerCase().includes(s)
        );
      }

      const start = (page - 1) * limit;
      return {
        data: results.slice(start, start + parseInt(limit)),
        total: results.length,
        page: parseInt(page),
        totalPages: Math.ceil(results.length / limit),
      };
    } catch (error) {
      console.error('purchase_ordersService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('purchase_ordersService.findById error:', error);
      throw error;
    }
  },

  /**
   * Create a Purchase Order with simple POMAT### number.
   * Quarry, site, driver, job, and pricing will be added later on delivery/reciet notes.
   */
  async create(data) {
    try {
      const poNumber = await getNextId('purchase_order');
      const docRef = collectionRef.doc(poNumber);
      const item = {
        ...data,
        id: poNumber,
        poNumber,
        status: data.status || 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: poNumber, ...item };
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

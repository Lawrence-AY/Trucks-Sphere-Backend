const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('vendors');

const vendorsService = {
  async findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;
    try {
      // Post-filter approach — no composite index needed
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (status) results = results.filter(item => item.status === status);
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.name || '').toLowerCase().includes(s) ||
          (item.id || '').toLowerCase().includes(s)
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
      console.error('vendorsService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('vendorsService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const vendorId = await getNextId('vendor');
      const docRef = collectionRef.doc(vendorId);
      const item = {
        ...data,
        id: vendorId,
        status: data.status || 'active',
        fleetSize: data.fleetSize || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: vendorId, ...item };
    } catch (error) {
      console.error('vendorsService.create error:', error);
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
      console.error('vendorsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('vendorsService.delete error:', error);
      throw error;
    }
  },
};

module.exports = vendorsService;

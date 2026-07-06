const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('vehicles');

const vehiclesService = {
  async findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;
    try {
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (status) results = results.filter(item => item.status === status);
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.plateNumber || '').toLowerCase().includes(s) ||
          (item.model || '').toLowerCase().includes(s) ||
          (item.make || '').toLowerCase().includes(s)
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
      console.error('vehiclesService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('vehiclesService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const truckId = await getNextId('truck');
      const docRef = collectionRef.doc(truckId);
      const item = {
        ...data,
        id: truckId,
        status: data.status || 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: truckId, ...item };
    } catch (error) {
      console.error('vehiclesService.create error:', error);
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
      console.error('vehiclesService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('vehiclesService.delete error:', error);
      throw error;
    }
  },
};

module.exports = vehiclesService;
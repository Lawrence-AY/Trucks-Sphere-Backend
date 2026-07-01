const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('drivers');

const driversService = {
  async findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;
    try {
      let ref = collectionRef.orderBy('createdAt', 'desc');
      if (status) ref = ref.where('status', '==', status);
      const snapshot = await ref.get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.name || '').toLowerCase().includes(s) ||
          (item.phone || '').includes(s) ||
          (item.licenseNumber || '').toLowerCase().includes(s)
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
      console.error('driversService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('driversService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const driverId = await getNextId('driver');
      const docRef = collectionRef.doc(driverId);
      const item = {
        ...data,
        id: driverId,
        status: data.status || 'active',
        totalTrips: data.totalTrips || 0,
        rating: data.rating || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: driverId, ...item };
    } catch (error) {
      console.error('driversService.create error:', error);
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
      console.error('driversService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('driversService.delete error:', error);
      throw error;
    }
  },
};

module.exports = driversService;

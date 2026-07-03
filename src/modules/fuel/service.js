const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('fuelRecords');

const fuelService = {
  async findAll(query = {}) {
    const { search, vendorId, jobId, plateNumber, dateFrom, dateTo, page = 1, limit = 50 } = query;
    try {
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (vendorId) results = results.filter(item => item.vendorId === vendorId);
      if (jobId) results = results.filter(item => item.jobId === jobId);
      if (plateNumber) results = results.filter(item => item.plateNumber === plateNumber);
      if (dateFrom) results = results.filter(item => new Date(item.createdAt) >= new Date(dateFrom));
      if (dateTo) results = results.filter(item => new Date(item.createdAt) <= new Date(dateTo));
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.jobId || '').toLowerCase().includes(s) ||
          (item.driverName || '').toLowerCase().includes(s) ||
          (item.plateNumber || '').toLowerCase().includes(s) ||
          (item.vendorName || '').toLowerCase().includes(s)
        );
      }

      const start = (page - 1) * parseInt(limit);
      return {
        data: results.slice(start, start + parseInt(limit)),
        total: results.length,
        page: parseInt(page),
        totalPages: Math.ceil(results.length / parseInt(limit)),
      };
    } catch (error) {
      console.error('fuelService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('fuelService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const fuelId = await getNextId('fuel');
      const docRef = collectionRef.doc(fuelId);
      const item = {
        ...data,
        id: fuelId,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: fuelId, ...item };
    } catch (error) {
      console.error('fuelService.create error:', error);
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
      console.error('fuelService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('fuelService.delete error:', error);
      throw error;
    }
  },
};

module.exports = fuelService;
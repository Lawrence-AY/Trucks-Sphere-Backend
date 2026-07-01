const { db } = require('../../../config/firebase');
const collectionRef = db.collection('weighRecords');

const weighbridgeService = {
  async findAll(query = {}) {
    const { search, type, jobId, deliveryOrderId, page = 1, limit = 50 } = query;
    try {
      // Fetch all records sorted by timestamp — then post-filter
      // to avoid Firestore composite index requirements
      const snapshot = await collectionRef.orderBy('timestamp', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      // Post-filter
      if (type) {
        results = results.filter(item => item.type === type);
      }
      if (jobId) {
        results = results.filter(item => item.jobId === jobId);
      }
      if (deliveryOrderId) {
        results = results.filter(item => item.deliveryOrderId === deliveryOrderId);
      }
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.jobId || '').toLowerCase().includes(s) ||
          (item.location || '').toLowerCase().includes(s)
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
      console.error('weighbridgeService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('weighbridgeService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const docRef = collectionRef.doc(data.id || undefined);
      const item = {
        ...data,
        timestamp: data.timestamp || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: docRef.id, ...item };
    } catch (error) {
      console.error('weighbridgeService.create error:', error);
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
      console.error('weighbridgeService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('weighbridgeService.delete error:', error);
      throw error;
    }
  },
};

module.exports = weighbridgeService;
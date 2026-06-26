const admin = require('../../../config/firebase');
const db = admin.firestore();
const collectionRef = db.collection('weighRecords');

const weighbridgeService = {
  async findAll(query = {}) {
    const { search, type, jobId, deliveryOrderId, page = 1, limit = 50 } = query;
    try {
      let ref = collectionRef.orderBy('timestamp', 'desc');
      if (type) ref = ref.where('type', '==', type);
      if (jobId) ref = ref.where('jobId', '==', jobId);
      if (deliveryOrderId) ref = ref.where('deliveryOrderId', '==', deliveryOrderId);
      const snapshot = await ref.get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (search && !jobId) {
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

const { db } = require('../../../config/firebase');
const collectionRef = db.collection('uploads');

const uploadsService = {
  async findAll(query = {}) {
    const { deliveryOrderId, type, jobId, page = 1, limit = 50 } = query;
    try {
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      if (deliveryOrderId) results = results.filter(item => item.deliveryOrderId === deliveryOrderId);
      if (jobId) results = results.filter(item => item.jobId === jobId);
      if (type) results = results.filter(item => item.type === type);

      const start = (page - 1) * parseInt(limit);
      return {
        data: results.slice(start, start + parseInt(limit)),
        total: results.length,
        page: parseInt(page),
        totalPages: Math.ceil(results.length / parseInt(limit)),
      };
    } catch (error) {
      console.error('uploadsService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('uploadsService.findById error:', error);
      throw error;
    }
  },

  async create(data) {
    try {
      const docRef = collectionRef.doc();
      const item = {
        ...data,
        id: docRef.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: docRef.id, ...item };
    } catch (error) {
      console.error('uploadsService.create error:', error);
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
      console.error('uploadsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('uploadsService.delete error:', error);
      throw error;
    }
  },
};

module.exports = uploadsService;
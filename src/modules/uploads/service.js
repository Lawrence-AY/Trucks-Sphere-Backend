const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('uploads');

const COLLECTION_NAME = 'uploads';

const uploadsService = {
  findAll(query = {}) {
    const { deliveryOrderId, type, jobId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

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
  },

  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
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
const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('weighRecords');

const COLLECTION_NAME = 'weighments';

const weighbridgeService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   * Eliminates Firestore reads — data is kept in sync via onSnapshot.
   */
  findAll(query = {}) {
    const { search, type, jobId, deliveryOrderId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by timestamp descending
    results = [...results].sort((a, b) => {
      const da = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const db = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return db - da;
    });

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

    const start = (page - 1) * parseInt(limit);
    return {
      data: results.slice(start, start + parseInt(limit)),
      total: results.length,
      page: parseInt(page),
      totalPages: Math.ceil(results.length / parseInt(limit)),
    };
  },

  /**
   * findById reads from the in-memory snapshot cache.
   */
  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
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
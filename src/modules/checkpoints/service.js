const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('checkpoints');

const COLLECTION_NAME = 'checkpoints';

const checkpointsService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   */
  findAll(query = {}) {
    const { jobId, deliveryOrderId, type, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by timestamp descending
    results = [...results].sort((a, b) => {
      const da = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const db = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return db - da;
    });

    if (jobId) results = results.filter(item => item.jobId === jobId);
    if (deliveryOrderId) results = results.filter(item => item.deliveryOrderId === deliveryOrderId);
    if (type) results = results.filter(item => item.type === type);

    const start = (page - 1) * limit;
    return {
      data: results.slice(start, start + parseInt(limit)),
      total: results.length,
      page: parseInt(page),
      totalPages: Math.ceil(results.length / limit),
    };
  },

  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
  },

  async create(data) {
    try {
      const docRef = collectionRef.doc(data.id || undefined);
      const item = {
        deliveryOrderId: data.deliveryOrderId || '',
        jobId: data.jobId || '',
        type: data.type || 'in_transit',
        timestamp: data.timestamp || new Date().toISOString(),
        location: data.location || '',
        notes: data.notes || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: docRef.id, ...item };
    } catch (error) {
      console.error('checkpointsService.create error:', error);
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
      console.error('checkpointsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('checkpointsService.delete error:', error);
      throw error;
    }
  },

  /**
   * Get journey details by jobId.
   * Uses snapshot caches for both checkpoints and deliveryOrders.
   */
  getJourneyByJobId(jobId) {
    const checkpoints = snapshotStore.getAll(COLLECTION_NAME)
      .filter(cp => cp.jobId === jobId)
      .sort((a, b) => {
        const da = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const db = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return da - db;
      });

    const deliveryOrders = snapshotStore.getAll('deliveryOrders')
      .filter(doDoc => doDoc.jobId === jobId)
      .sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

    return {
      jobId,
      deliveryOrder: deliveryOrders[0] || null,
      checkpoints,
      total: checkpoints.length,
    };
  },

  /**
   * Get active deliveries with their latest checkpoints.
   * Uses snapshot caches for efficiency.
   */
  getActiveDeliveries() {
    const deliveryOrders = snapshotStore.getAll('deliveryOrders')
      .filter(d => ['assigned', 'at_quarry', 'in_transit', 'active'].includes(d.status));

    const allCheckpoints = snapshotStore.getAll(COLLECTION_NAME);

    const result = [];
    for (const delivery of deliveryOrders) {
      const deliveryCheckpoints = allCheckpoints
        .filter(cp => cp.deliveryOrderId === delivery.id)
        .sort((a, b) => {
          const da = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const db = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return db - da;
        });

      result.push({
        ...delivery,
        latestCheckpoint: deliveryCheckpoints[0] || null,
        checkpoints: [...deliveryCheckpoints].reverse(), // asc order
        checkpointCount: deliveryCheckpoints.length,
      });
    }

    return { data: result, total: result.length };
  },
};

module.exports = checkpointsService;
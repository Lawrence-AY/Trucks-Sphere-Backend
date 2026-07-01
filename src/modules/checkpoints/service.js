const { db } = require('../../../config/firebase');
const collectionRef = db.collection('checkpoints');
const deliveryOrdersRef = db.collection('deliveryOrders');

const checkpointsService = {
  async findAll(query = {}) {
    const { jobId, deliveryOrderId, type, page = 1, limit = 50 } = query;
    try {
      // Post-filter approach to avoid Firestore composite index requirements
      const snapshot = await collectionRef.orderBy('timestamp', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

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
    } catch (error) {
      console.error('checkpointsService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('checkpointsService.findById error:', error);
      throw error;
    }
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

  async getJourneyByJobId(jobId) {
    try {
      // Simple query + post-filter to avoid composite index
      const snapshot = await collectionRef.orderBy('timestamp', 'asc').get();
      const checkpoints = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.jobId === jobId) {
          checkpoints.push({ id: doc.id, ...data });
        }
      });

      // Also fetch the delivery order
      const doSnapshot = await deliveryOrdersRef.orderBy('createdAt', 'desc').get();
      let deliveryOrder = null;
      doSnapshot.forEach(doc => {
        if (doc.data().jobId === jobId && !deliveryOrder) {
          deliveryOrder = { id: doc.id, ...doc.data() };
        }
      });

      return { jobId, deliveryOrder, checkpoints, total: checkpoints.length };
    } catch (error) {
      console.error('checkpointsService.getJourneyByJobId error:', error);
      throw error;
    }
  },

  async getActiveDeliveries() {
    try {
      const doSnapshot = await deliveryOrdersRef.orderBy('updatedAt', 'desc').get();
      const deliveries = [];
      doSnapshot.forEach(doc => {
        const data = doc.data();
        if (['assigned', 'at_quarry', 'in_transit', 'active'].includes(data.status)) {
          deliveries.push({ id: doc.id, ...data });
        }
      });

      const result = [];
      for (const delivery of deliveries) {
        const cpSnapshot = await collectionRef.orderBy('timestamp', 'desc').get();
        let latestCheckpoint = null;
        let allCheckpoints = [];
        cpSnapshot.forEach(doc => {
          const data = doc.data();
          if (data.deliveryOrderId === delivery.id) {
            allCheckpoints.push({ id: doc.id, ...data });
            if (!latestCheckpoint) latestCheckpoint = { id: doc.id, ...data };
          }
        });
        allCheckpoints.reverse(); // back to asc order

        result.push({
          ...delivery,
          latestCheckpoint,
          checkpoints: allCheckpoints,
          checkpointCount: allCheckpoints.length,
        });
      }

      return { data: result, total: result.length };
    } catch (error) {
      console.error('checkpointsService.getActiveDeliveries error:', error);
      throw error;
    }
  },
};

module.exports = checkpointsService;
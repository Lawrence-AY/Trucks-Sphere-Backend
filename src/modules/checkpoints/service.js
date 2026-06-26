const admin = require('../../../config/firebase');
const db = admin.firestore();
const collectionRef = db.collection('checkpoints');
const deliveryOrdersRef = db.collection('deliveryOrders');

const checkpointsService = {
  async findAll(query = {}) {
    const { jobId, deliveryOrderId, type, page = 1, limit = 50 } = query;
    try {
      let ref = collectionRef.orderBy('timestamp', 'desc');
      if (jobId) ref = ref.where('jobId', '==', jobId);
      if (deliveryOrderId) ref = ref.where('deliveryOrderId', '==', deliveryOrderId);
      if (type) ref = ref.where('type', '==', type);
      const snapshot = await ref.get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

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

  /**
   * Get the full journey for a job ID with all checkpoints sorted by timestamp
   * GET /api/checkpoints/journey/:jobId
   */
  async getJourneyByJobId(jobId) {
    try {
      const snapshot = await collectionRef
        .where('jobId', '==', jobId)
        .orderBy('timestamp', 'asc')
        .get();

      const checkpoints = [];
      snapshot.forEach(doc => checkpoints.push({ id: doc.id, ...doc.data() }));

      // Also fetch the delivery order to get additional info
      const doSnapshot = await deliveryOrdersRef
        .where('jobId', '==', jobId)
        .limit(1)
        .get();

      let deliveryOrder = null;
      if (!doSnapshot.empty) {
        const doc = doSnapshot.docs[0];
        deliveryOrder = { id: doc.id, ...doc.data() };
      }

      return {
        jobId,
        deliveryOrder,
        checkpoints,
        total: checkpoints.length,
      };
    } catch (error) {
      console.error('checkpointsService.getJourneyByJobId error:', error);
      throw error;
    }
  },

  /**
   * Returns all active deliveries with their latest checkpoint status
   * GET /api/checkpoints/active
   */
  async getActiveDeliveries() {
    try {
      // Get non-delivered/non-cancelled delivery orders
      const doSnapshot = await deliveryOrdersRef
        .where('status', 'in', ['assigned', 'at_quarry', 'in_transit', 'active'])
        .orderBy('updatedAt', 'desc')
        .get();

      const deliveries = [];
      doSnapshot.forEach(doc => {
        deliveries.push({ id: doc.id, ...doc.data() });
      });

      // For each active delivery, fetch the latest checkpoint
      const result = [];
      for (const delivery of deliveries) {
        const cpSnapshot = await collectionRef
          .where('deliveryOrderId', '==', delivery.id)
          .orderBy('timestamp', 'desc')
          .limit(1)
          .get();

        let latestCheckpoint = null;
        if (!cpSnapshot.empty) {
          const doc = cpSnapshot.docs[0];
          latestCheckpoint = { id: doc.id, ...doc.data() };
        }

        // Get all checkpoints for this delivery
        const allCpSnapshot = await collectionRef
          .where('deliveryOrderId', '==', delivery.id)
          .orderBy('timestamp', 'asc')
          .get();

        const allCheckpoints = [];
        allCpSnapshot.forEach(doc => allCheckpoints.push({ id: doc.id, ...doc.data() }));

        result.push({
          ...delivery,
          latestCheckpoint,
          checkpoints: allCheckpoints,
          checkpointCount: allCheckpoints.length,
        });
      }

      return {
        data: result,
        total: result.length,
      };
    } catch (error) {
      console.error('checkpointsService.getActiveDeliveries error:', error);
      throw error;
    }
  },
};

module.exports = checkpointsService;

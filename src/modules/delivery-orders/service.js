const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const collectionRef = db.collection('deliveryOrders');

const delivery_ordersService = {
  async findAll(query = {}) {
    const { search, status, jobId, purchaseOrderId, vendorId, quarryId, siteId, page = 1, limit = 50 } = query;
    try {
      // Fetch all documents sorted by createdAt (simple query, no composite index needed)
      // Post-filter for jobId/purchaseOrderId to avoid compound index requirements
      const snapshot = await collectionRef.orderBy('createdAt', 'desc').get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      // Post-filter by status
      if (status) {
        results = results.filter(item => item.status === status);
      }
      // Post-filter by jobId
      if (jobId) {
        results = results.filter(item => item.jobId === jobId);
      }
      // Post-filter by purchaseOrderId
      if (purchaseOrderId) {
        results = results.filter(item => item.purchaseOrderId === purchaseOrderId);
      }
      // Post-filter by vendorId (for vendor-scoped views)
      if (vendorId) {
        results = results.filter(item => item.vendorId === vendorId);
      }
      // Post-filter by quarryId (for quarry operator views)
      if (quarryId) {
        results = results.filter(item => item.quarryId === quarryId);
      }
      // Post-filter by siteId (for site operator views)
      if (siteId) {
        results = results.filter(item => item.siteId === siteId);
      }
      // Text search
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(item =>
          (item.jobId || '').toLowerCase().includes(s) ||
          (item.driverName || '').toLowerCase().includes(s) ||
          (item.plateNumber || '').toLowerCase().includes(s)
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
      console.error('delivery_ordersService.findAll error:', error);
      throw error;
    }
  },

  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('delivery_ordersService.findById error:', error);
      throw error;
    }
  },

  /**
   * Create a Delivery Order (Job card).
   * Delivery Note format: DN-POMAT###-D###-J###
   * Receipt Note: RN### (generated separately at site)
   */
  async create(data) {
    try {
      // Use client-provided jobId if present, otherwise auto-generate
      const jobId = data.jobId || await getNextId('job');
      // Firestore doc IDs cannot contain /, so sanitize for the doc ID only
      const docId = jobId.replace(/\//g, '-');
      const docRef = collectionRef.doc(docId);
      const item = {
        ...data,
        id: docId,
        jobId,
        status: data.status || 'assigned',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: docId, ...item };
    } catch (error) {
      console.error('delivery_ordersService.create error:', error);
      throw error;
    }
  },

  async update(id, data) {
    try {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return null;
      const existing = doc.data();
      const updates = { ...data, updatedAt: new Date().toISOString() };
      await docRef.update(updates);

      // When delivery is marked as delivered/completed, deduct quantity from purchase order
      const newStatus = data.status;
      const wasCompleted = ['delivered', 'completed'].includes(existing.status);
      const isNowCompleted = ['delivered', 'completed'].includes(newStatus);
      
      if (!wasCompleted && isNowCompleted) {
        const purchaseOrderId = existing.purchaseOrderId;
        const deliveredQty = Number(data.quantityDelivered || data.netWeight || existing.quantityDelivered || existing.netWeight || existing.quantity || 0);
        
        if (purchaseOrderId && deliveredQty > 0) {
          try {
            const poRef = db.collection('purchaseOrders').doc(purchaseOrderId);
            const poDoc = await poRef.get();
            if (poDoc.exists) {
              const po = poDoc.data();
              const currentDelivered = Number(po.deliveredQuantity || 0);
              const orderedQty = Number(po.quantity || 0);
              const newDelivered = currentDelivered + deliveredQty;
              const remainingQty = Math.max(0, orderedQty - newDelivered);
              const poStatus = remainingQty <= 0 ? 'fulfilled' : (newDelivered > 0 ? 'partially_fulfilled' : po.status);
              
              await poRef.update({
                deliveredQuantity: newDelivered,
                remainingQuantity: remainingQty,
                status: poStatus,
                updatedAt: new Date().toISOString(),
              });
              console.log(`[DeliveryOrder] Updated PO ${purchaseOrderId}: delivered=${newDelivered}, remaining=${remainingQty}, status=${poStatus}`);
            }
          } catch (poError) {
            console.error('[DeliveryOrder] Failed to update purchase order:', poError);
            // Don't fail the delivery update — PO update is secondary
          }
        }
      }

      return { id, ...existing, ...updates };
    } catch (error) {
      console.error('delivery_ordersService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('delivery_ordersService.delete error:', error);
      throw error;
    }
  },
};

module.exports = delivery_ordersService;

const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('deliveryOrders');
const purchaseOrdersCollection = db.collection('purchaseOrders');

const COLLECTION_NAME = 'deliveryOrders';

/**
 * Enrich a delivery order with quarry/site context from its purchase order.
 * Uses the snapshot cache for purchaseOrders instead of a Firestore read.
 */
function enrichWithPurchaseOrderContext(item) {
  if (!item?.purchaseOrderId) return item;
  if (item.quarryId && item.siteId) return item;

  const po = snapshotStore.getById('purchaseOrders', item.purchaseOrderId);
  if (!po) return item;

  return {
    ...item,
    quarryId: item.quarryId || po.quarryId || '',
    quarryName: item.quarryName || po.quarryName || '',
    siteId: item.siteId || po.siteId || '',
    siteName: item.siteName || po.siteName || '',
  };
}

const delivery_ordersService = {
  /**
   * findAll queries Firestore directly for real-time accuracy.
   * This ensures scheduled/incoming trips that were recently weighed out
   * appear immediately — no stale cached data.
   */
  async findAll(query = {}) {
    const { search, status, jobId, purchaseOrderId, vendorId, quarryId, siteId, page = 1, limit = 50 } = query;

    try {
      // Query Firestore directly — no orderBy to avoid requiring a composite index
      const snapshot = await collectionRef.get();
      let results = [];
      snapshot.forEach(doc => results.push({ id: doc.id, ...doc.data() }));

      // Sort by createdAt descending (in-memory, no index needed)
      results.sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return db - da;
      });

      // Enrich with PO context from the snapshot cache (purchaseOrders rarely change)
      results = results.map(enrichWithPurchaseOrderContext);

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
      // Include items where quarryId is empty/null — unassigned deliveries are visible to all operators
      if (quarryId) {
        results = results.filter(item => !item.quarryId || item.quarryId === quarryId);
      }
      // Post-filter by siteId (for site operator views)
      // Include items where siteId is empty/null — unassigned deliveries are visible to all operators
      if (siteId) {
        results = results.filter(item => !item.siteId || item.siteId === siteId);
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

  /**
   * findById queries Firestore directly for the latest data.
   */
  async findById(id) {
    try {
      const doc = await collectionRef.doc(id).get();
      if (!doc.exists) return null;
      const item = { id: doc.id, ...doc.data() };
      return enrichWithPurchaseOrderContext(item);
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
      // Use snapshot cache for PO context
      const purchaseOrderContext = data.purchaseOrderId
        ? snapshotStore.getById('purchaseOrders', data.purchaseOrderId)
        : null;

      const docRef = collectionRef.doc(docId);
      const item = {
        ...data,
        id: docId,
        jobId,
        quarryId: data.quarryId || purchaseOrderContext?.quarryId || '',
        quarryName: data.quarryName || purchaseOrderContext?.quarryName || '',
        siteId: data.siteId || purchaseOrderContext?.siteId || '',
        siteName: data.siteName || purchaseOrderContext?.siteName || '',
        status: data.status || 'assigned',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      // Cache is updated via onSnapshot
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

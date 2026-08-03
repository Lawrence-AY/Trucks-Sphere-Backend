/**
 * trucks-Sphere-Backend src/delivery-orders/service.js
 * **/
const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const { generateJobIdForPO } = require('../../utils/jobIdService');
const { generateTrackingId } = require('../../utils/trackingUtils');
const snapshotStore = require('../../utils/snapshotStore');
const { JOB_STATUS, normalizeJobStatus, isActiveJob } = require('../../utils/jobLifecycle');
const { buildBackorder, planSiteNetBackorder } = require('./backorder');
const { syncSiteReceipt } = require('../../integrations/odooReceiptService');
const collectionRef = db.collection('deliveryOrders');
const purchaseOrdersCollection = db.collection('purchaseOrders');

const COLLECTION_NAME = 'deliveryOrders';

function normalizeMaterialSource(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeResourceId(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * A driver and a truck can each have only one open delivery job. This check
 * runs on the server so a stale mobile cache cannot create a duplicate job.
 */
async function findActiveAssignmentConflict(data) {
  const requestedDriverId = normalizeResourceId(data.driverId);
  const requestedVehicleId = normalizeResourceId(data.vehicleId);
  const requestedPlate = normalizeResourceId(data.plateNumber);

  const isConflict = (job) => {
    if (!isActiveJob(job.status)) return false;

    const sameDriver = requestedDriverId && normalizeResourceId(job.driverId) === requestedDriverId;
    const sameVehicle = requestedVehicleId && normalizeResourceId(job.vehicleId) === requestedVehicleId;
    const samePlate = requestedPlate && normalizeResourceId(job.plateNumber) === requestedPlate;
    return sameDriver || sameVehicle || samePlate;
  };

  const cachedConflict = snapshotStore.getAll(COLLECTION_NAME).find(isConflict);
  if (cachedConflict) {
    // Verify against Firestore in case the in-memory snapshot is stale
    try {
      const doc = await collectionRef.doc(cachedConflict.id).get();
      if (doc.exists) {
        const remote = { id: doc.id, ...doc.data() };
        if (isConflict(remote) && isActiveJob(remote.status)) return cachedConflict;
        // If remote is no longer an active conflict, fall through to full checks
      }
    } catch (err) {
      // If verification fails, fall back to cached result to be safe
      return cachedConflict;
    }
  }

  // The snapshot is normally current, but confirm against Firestore before a
  // safety-critical create in case the process has only just started.
  const checks = [];
  if (requestedDriverId) checks.push(collectionRef.where('driverId', '==', data.driverId).get());
  if (requestedVehicleId) checks.push(collectionRef.where('vehicleId', '==', data.vehicleId).get());
  if (requestedPlate) checks.push(collectionRef.where('plateNumber', '==', data.plateNumber).get());
  const results = await Promise.all(checks);
  return results.flatMap((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))).find(isConflict);
}

const SITE_ARRIVAL_VARIANCE_TOLERANCE_TONNES = 5;

// Site arrival is the one authoritative transition into the site-weights
// queue. Keeping these markers server-owned prevents client/query drift.
function applySiteArrivalWorkflow(data, updates, existing = {}) {
  const hasSiteArrivalWeight =
    Object.prototype.hasOwnProperty.call(data, 'siteWeighInWeight') &&
    data.siteWeighInWeight !== null &&
    data.siteWeighInWeight !== '' &&
    Number.isFinite(Number(data.siteWeighInWeight));

  if (!hasSiteArrivalWeight) return false;

  const now = new Date().toISOString();
  updates.siteWeighInWeight = Number(data.siteWeighInWeight);
  updates.siteArrivalWeight = Number(data.siteWeighInWeight);
  updates.siteWeighInAt = data.siteWeighInAt || now;
  updates.siteArrivalCompleted = true;
  updates.arrivalCompleted = true;
  updates.workflowStage = 'ready_for_site_weights';
  updates.currentStage = 'site_weights';
  updates.status = JOB_STATUS.SITE_WEIGHED_IN;
  updates.readyForSiteWeightsAt = now;

  // Site arrival variance is always measured from the quarry weigh-out:
  // positive = site arrival is heavier; negative = site arrival is lighter.
  const quarryWeighOut = Number(data.weighOutWeight ?? existing.weighOutWeight);
  const siteWeighIn = Number(data.siteWeighInWeight);
  if (Number.isFinite(quarryWeighOut) && quarryWeighOut > 0 && Number.isFinite(siteWeighIn)) {
    const variance = siteWeighIn - quarryWeighOut;
    const isFlagged = Math.abs(variance) > SITE_ARRIVAL_VARIANCE_TOLERANCE_TONNES;
    updates.siteArrivalWeightVariance = variance;
    updates.siteArrivalWeightVarianceTolerance = SITE_ARRIVAL_VARIANCE_TOLERANCE_TONNES;
    updates.siteArrivalWeightVarianceFlagged = isFlagged;
    updates.siteArrivalWeightVarianceStatus = isFlagged ? 'flagged' : 'within_tolerance';
    updates.hasWeightDiscrepancy = isFlagged;
  }
  return true;
}

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

/**
 * Add the quarry location assigned to the operator who dispatched the load.
 * Existing deliveries may predate the denormalized `quarryLocation` field, so
 * resolve it from the cached users collection for the Site Schedule as well.
 */
function enrichWithQuarryOperatorLocation(item) {
  if (!item || item.quarryLocation) return item;
  const operatorId = item.quarryOperatorUid || item.weighOutByUid || item.createdByUid;
  if (!operatorId) return item;
  // Firebase Auth UIDs are normally the user document IDs, but legacy user
  // documents can have a separate ID and retain the UID as a field.
  const operator = snapshotStore.getById('users', operatorId)
    || snapshotStore.getAll('users').find((user) => user.uid === operatorId);
  if (!operator?.quarryLocation) return item;
  return { ...item, quarryLocation: operator.quarryLocation };
}

/**
 * Atomically complete the source delivery and create one linked backorder
 * when the final site net is below the quantity ordered. The
 * source link makes timeout retries idempotent: one source can create only one
 * immediate child backorder.
 */
async function applyUpdateWithBackorder(docRef, id, updates) {
  return db.runTransaction(async (transaction) => {
    const sourceSnapshot = await transaction.get(docRef);
    if (!sourceSnapshot.exists) return { backorder: null };

    const source = { id, ...sourceSnapshot.data() };
    if (source.backorderDeliveryOrderId) {
      transaction.update(docRef, updates);
      return {
        backorder: {
          id: source.backorderDeliveryOrderId,
          jobId: source.backorderJobId || '',
          remainingQuantity: Number(source.backorderRemainingQuantity || 0),
          existing: true,
        },
      };
    }

    const plan = planSiteNetBackorder(source, updates);
    if (!plan) {
      transaction.update(docRef, updates);
      return { backorder: null };
    }

    const now = new Date().toISOString();
    // A shortfall is a planning record, not a new dispatched truck movement.
    // Firestore gives it a technical ID only; the next delivery gets its job
    // number when dispatch assigns a new driver and truck.
    const backorderRef = collectionRef.doc();
    const backorder = buildBackorder({
      source,
      plan,
      id: backorderRef.id,
      now,
    });

    transaction.set(backorderRef, backorder);
    transaction.update(docRef, {
      ...updates,
      backorderDeliveryOrderId: backorder.id,
      backorderJobId: backorder.jobId,
      backorderRemainingQuantity: plan.remainingQuantity,
      backorderCreatedAt: now,
    });

    return { backorder };
  });
}

const delivery_ordersService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   * Eliminates Firestore reads — data is kept in sync via onSnapshot.
   */
  findAll(query = {}) {
    const { search, status, jobId, purchaseOrderId, vendorId, quarryId, siteId, createdByUid, fuelReady, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    // Enrich with PO context from the snapshot cache (purchaseOrders rarely change)
    results = results
      .map(enrichWithPurchaseOrderContext)
      .map(enrichWithQuarryOperatorLocation);

    // Post-filter by status
    if (status) {
      results = results.filter(item => item.status === status);
    }
    // Fuel can be issued only after the site operator has finalized the job.
    // Filter before pagination so older finalized jobs are not skipped.
    if (fuelReady === true || fuelReady === 'true') {
      results = results.filter((item) => {
        const normalizedStatus = normalizeJobStatus(item.status);
        return normalizedStatus === JOB_STATUS.SITE_WEIGHED_OUT || normalizedStatus === JOB_STATUS.COMPLETED;
      });
    }
    // Post-filter by jobId
    if (jobId) {
      results = results.filter(item => item.jobId === jobId);
    }
    // Post-filter by purchaseOrderId
    if (purchaseOrderId) {
      results = results.filter(item => item.purchaseOrderId === purchaseOrderId);
    }
    // Post-filter by vendorId
    if (vendorId) {
      results = results.filter(item => item.vendorId === vendorId);
    }
    // Post-filter by quarryId
    if (quarryId) {
      results = results.filter(item => !item.quarryId || item.quarryId === quarryId);
    }
    // Post-filter by siteId
    if (siteId) {
      results = results.filter(item => !item.siteId || item.siteId === siteId);
    }
    // Post-filter by creator UID (data isolation for operator roles)
    if (createdByUid) {
      results = results.filter(item => item.createdByUid === createdByUid);
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
    if (!doc) return null;
    return enrichWithQuarryOperatorLocation(enrichWithPurchaseOrderContext(doc));
  },

  /**
   * Create a Delivery Order (Job card).
   * Job ID format: POMAT###/V###/D###/T###/J####
   * The J number is ALWAYS generated server-side via jobIdService
   * to guarantee one sequential counter per Purchase Order shared
   * across all quarries and sites.
   */
  async create(data) {
    try {
      const conflict = await findActiveAssignmentConflict(data);
      if (conflict) {
        const driverConflict = data.driverId && normalizeResourceId(conflict.driverId) === normalizeResourceId(data.driverId);
        const resource = driverConflict ? 'driver' : 'truck';
        const error = new Error(
          `Cannot create this job: the selected ${resource} is already assigned to active job ${conflict.jobId || conflict.id}.`
        );
        error.statusCode = 409;
        error.code = 'ACTIVE_JOB_RESOURCE_CONFLICT';
        throw error;
      }

      // The client sends a "jobKey" (everything before the /J####), e.g. "POMAT003/V001/D004/T010"
      // If they sent a full jobId, strip the J number — the backend owns the counter.
      const jobKey = (data.jobKey || data.jobId || '')
        .replace(/\/J\d+(-\w+)?$/, '')
        .replace(/-\w+$/, '');

      // Use the purchase order ID from payload or fall back to auto-detect
      const purchaseOrderId = data.purchaseOrderId || '';

      // Generate the jobId server-side (atomic Firestore counter per PO)
      let jobId;
      if (purchaseOrderId && jobKey) {
        const result = await generateJobIdForPO(purchaseOrderId, jobKey);
        jobId = result.jobId;
      } else {
        // Fallback for cases where purchaseOrderId is not available
        jobId = data.jobId || await getNextId('job');
      }

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
        materialSource: normalizeMaterialSource(data.materialSource),
        quarryId: data.quarryId || purchaseOrderContext?.quarryId || '',
        quarryName: data.quarryName || purchaseOrderContext?.quarryName || '',
        siteId: data.siteId || purchaseOrderContext?.siteId || '',
        siteName: data.siteName || purchaseOrderContext?.siteName || '',
        status: normalizeJobStatus(data.status, JOB_STATUS.CREATED),
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

  /**
   * update — Optimized for quarry workflow speed.
   * Uses in-memory snapshot cache to avoid a Firestore read for the current state.
   */
  async update(id, data) {
    try {
      const docRef = collectionRef.doc(id);

      // Use snapshot-cached existing document to avoid a Firestore read
      const existing = snapshotStore.getById(COLLECTION_NAME, id);
      if (!existing) {
        // Fallback to Firestore read only if cache miss
        const doc = await docRef.get();
        if (!doc.exists) return null;
        const fallbackExisting = doc.data();
        return this._applyUpdate(docRef, id, fallbackExisting, data);
      }

      return this._applyUpdate(docRef, id, existing, data);
    } catch (error) {
      console.error('delivery_ordersService.update error:', error);
      throw error;
    }
  },

  async _applyUpdate(docRef, id, existing, data) {
    try {
      const updates = { ...data, updatedAt: new Date().toISOString() };
      if (updates.status) updates.status = normalizeJobStatus(updates.status, normalizeJobStatus(existing.status));
      if (Object.prototype.hasOwnProperty.call(data, 'materialSource')) {
        updates.materialSource = normalizeMaterialSource(data.materialSource);
      }
      const enteredWeightsQueue = applySiteArrivalWorkflow(data, updates, existing);
      const wasCompletedAtStart = [JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED]
        .includes(normalizeJobStatus(existing.status));
      const isNowCompleted = [JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED]
        .includes(normalizeJobStatus(updates.status, normalizeJobStatus(existing.status)));
      const shouldSyncOdooReceipt = !wasCompletedAtStart && isNowCompleted;
      if (shouldSyncOdooReceipt) {
        // A site completion must never be rolled back merely because Odoo is
        // unavailable. Persist an observable status, then complete the Odoo
        // sync below and expose a retryable failure to management if needed.
        updates.odooReceiptSyncStatus = 'pending';
        updates.odooReceiptLastAttemptAt = new Date().toISOString();
      }

      console.debug('[SiteWeights] delivery order before update', {
        documentId: id,
        status: existing.status,
        workflowStage: existing.workflowStage,
        currentStage: existing.currentStage,
        siteWeighInWeight: existing.siteWeighInWeight,
        siteId: existing.siteId,
      });
      console.debug('[SiteWeights] delivery order update payload', {
        documentId: id,
        payload: updates,
        enteredWeightsQueue,
      });
      const backorderPlan = planSiteNetBackorder(existing, updates);
      const backorderResult = backorderPlan
        ? await applyUpdateWithBackorder(docRef, id, updates)
        : (await docRef.update(updates), { backorder: null });
      console.debug('[SiteWeights] delivery order update succeeded', { documentId: id });

      // Diagnostic verification of the exact document written. Remove this
      // direct read after the transition has been verified in production.
      const persistedDocument = await docRef.get();
      const persisted = persistedDocument.data() || {};
      console.debug('[SiteWeights] delivery order after update', {
        documentId: persistedDocument.id,
        exists: persistedDocument.exists,
        status: persisted.status,
        workflowStage: persisted.workflowStage,
        currentStage: persisted.currentStage,
        siteWeighInWeight: persisted.siteWeighInWeight,
        siteArrivalWeight: persisted.siteArrivalWeight,
        siteArrivalCompleted: persisted.siteArrivalCompleted,
        siteId: persisted.siteId,
      });

      // ─── Tracking ID Lifecycle ───
      const newStatus = updates.status;
      // When a job transitions to 'loaded' (quarry weigh-out complete),
      // auto-generate a tracking ID so the public tracking link goes live.
      if ((newStatus === JOB_STATUS.QUARRY_WEIGHED_OUT || newStatus === JOB_STATUS.DISPATCHED || newStatus === JOB_STATUS.IN_TRANSIT) && !existing.trackingId) {
        try {
          const trackingId = generateTrackingId();
          await docRef.update({ trackingId });
          updates.trackingId = trackingId;
          const plate = existing.plateNumber || 'UNKNOWN';
          console.log(`[DeliveryOrder] TRACKING STARTED — ID: ${trackingId} | Job: ${id} | Plate: ${plate} | Driver: ${existing.driverName || 'N/A'} | Status: loaded | WeighOut: ${existing.weighOutWeight || data.weighOutWeight} tonnes | Location: ${existing.weighOutLocation || 'N/A'}`);
        } catch (trackErr) {
          console.error('[DeliveryOrder] Failed to generate tracking ID:', trackErr);
          // Non-fatal — the job card still works without tracking
        }
      }

      // When delivery is marked as delivered/completed, tag it as awaiting quality control check
      const wasCompleted = wasCompletedAtStart;
      
      if (!wasCompleted && isNowCompleted) {
        const purchaseOrderId = existing.purchaseOrderId;
        const deliveredQty = Number(
          data.quantityDelivered ??
          data.siteNetWeight ??
          data.netWeight ??
          existing.quantityDelivered ??
          existing.siteNetWeight ??
          existing.netWeight ??
          existing.quantity ??
          0,
        );
        
        if (purchaseOrderId && deliveredQty > 0) {
          try {
            const poRef = db.collection('purchaseOrders').doc(purchaseOrderId);
            const poDoc = await poRef.get();
            if (poDoc.exists) {
              const po = poDoc.data();
              const pendingQC = Number(po.pendingQualityControl || 0);
              const newPendingQC = pendingQC + deliveredQty;
              
              await poRef.update({
                pendingQualityControl: newPendingQC,
                updatedAt: new Date().toISOString(),
              });
              console.log(`[DeliveryOrder] PO ${purchaseOrderId}: ${deliveredQty} tonnes awaiting quality control check (pendingQC=${newPendingQC})`);
            }
          } catch (poError) {
            console.error('[DeliveryOrder] Failed to update purchase order QC status:', poError);
          }
        }
      }

        // Release assigned driver/vehicle when a job moves into a terminal state
        if (!wasCompleted && isNowCompleted) {
          try {
            const releaseDriverId = persisted.driverId || existing.driverId;
            const releaseVehicleId = persisted.vehicleId || existing.vehicleId;
            const now = new Date().toISOString();

            if (releaseDriverId) {
              try {
                await db.collection('drivers').doc(String(releaseDriverId)).update({
                  currentVehicleId: undefined,
                  currentVehiclePlate: undefined,
                  availability: true,
                  updatedAt: now,
                });
                console.log(`[DeliveryOrder] Released driver ${releaseDriverId} from job ${id}`);
              } catch (dErr) {
                console.error(`[DeliveryOrder] Failed to release driver ${releaseDriverId}:`, dErr);
              }
            }

            if (releaseVehicleId) {
              try {
                await db.collection('vehicles').doc(String(releaseVehicleId)).update({
                  currentDriverId: undefined,
                  currentDriverName: undefined,
                  updatedAt: now,
                });
                console.log(`[DeliveryOrder] Released vehicle ${releaseVehicleId} from job ${id}`);
              } catch (vErr) {
                console.error(`[DeliveryOrder] Failed to release vehicle ${releaseVehicleId}:`, vErr);
              }
            }
          } catch (err) {
            console.error('[DeliveryOrder] Resource release failed:', err);
          }
        }

      let syncedBackorder = null;
      if (shouldSyncOdooReceipt) {
        const purchaseOrder = existing.purchaseOrderId
          ? snapshotStore.getById('purchaseOrders', existing.purchaseOrderId)
          : null;
        const material = existing.materialId
          ? snapshotStore.getById('materials', existing.materialId)
          : null;

        try {
          const odooSync = await syncSiteReceipt({
            deliveryOrder: { id, ...persisted },
            purchaseOrder,
            material,
          });
          await docRef.update(odooSync.source);
          Object.assign(persisted, odooSync.source);

          if (backorderResult.backorder?.id && odooSync.backorder) {
            await collectionRef.doc(backorderResult.backorder.id).update(odooSync.backorder);
            syncedBackorder = { ...backorderResult.backorder, ...odooSync.backorder };
          }
        } catch (odooError) {
          const failedSync = {
            odooReceiptSyncStatus: 'failed',
            odooReceiptSyncErrorCode: odooError.code || 'ODOO_RECEIPT_SYNC_FAILED',
            odooReceiptLastAttemptAt: new Date().toISOString(),
          };
          await docRef.update(failedSync);
          Object.assign(persisted, failedSync);
          if (backorderResult.backorder?.id) {
            await collectionRef.doc(backorderResult.backorder.id).update(failedSync);
            syncedBackorder = { ...backorderResult.backorder, ...failedSync };
          }
          console.error(`[Odoo] Receipt sync failed for delivery ${id}: ${odooError.message}`);
        }
      }

      return {
        id: persistedDocument.id,
        ...persisted,
        ...(backorderResult.backorder ? { backorder: syncedBackorder || backorderResult.backorder } : {}),
      };
    } catch (error) {
      console.error('delivery_ordersService._applyUpdate error:', error);
      throw error;
    }
  },

  async receiveLot(deliveryOrderId, storageLot) {
    try {
      const docRef = collectionRef.doc(deliveryOrderId);
      const doc = await docRef.get();
      if (!doc.exists) return null;

      const now = new Date().toISOString();
      await docRef.update({
        storageLot,
        storageLotAssignedAt: now,
        updatedAt: now,
      });

      const updated = await docRef.get();
      return { id: docRef.id, ...updated.data() };
    } catch (error) {
      console.error('delivery_ordersService.receiveLot error:', error);
      throw error;
    }
  },

  /**
   * Management retry for a site receipt that could not reach Odoo during the
   * original completion. It never changes the local delivery/backorder data.
   */
  async syncOdooReceipt(id) {
    const docRef = collectionRef.doc(id);
    const cached = snapshotStore.getById(COLLECTION_NAME, id);
    const snapshot = cached ? null : await docRef.get();
    const existing = cached || (snapshot?.exists ? snapshot.data() : null);
    if (!existing) return null;

    const status = normalizeJobStatus(existing.status);
    if (![JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED].includes(status)) {
      const error = new Error('Only completed site receipts can be synchronized with Odoo.');
      error.statusCode = 409;
      error.code = 'ODOO_RECEIPT_NOT_FINALIZED';
      throw error;
    }

    const pending = {
      odooReceiptSyncStatus: 'pending',
      odooReceiptLastAttemptAt: new Date().toISOString(),
    };
    await docRef.update(pending);
    const purchaseOrder = existing.purchaseOrderId
      ? snapshotStore.getById('purchaseOrders', existing.purchaseOrderId)
      : null;
    const material = existing.materialId
      ? snapshotStore.getById('materials', existing.materialId)
      : null;

    try {
      const odooSync = await syncSiteReceipt({
        deliveryOrder: { id, ...existing, ...pending },
        purchaseOrder,
        material,
      });
      await docRef.update(odooSync.source);

      if (existing.backorderDeliveryOrderId && odooSync.backorder) {
        await collectionRef.doc(existing.backorderDeliveryOrderId).update(odooSync.backorder);
      }
      return { id, ...existing, ...pending, ...odooSync.source };
    } catch (odooError) {
      const failed = {
        odooReceiptSyncStatus: 'failed',
        odooReceiptSyncErrorCode: odooError.code || 'ODOO_RECEIPT_SYNC_FAILED',
        odooReceiptLastAttemptAt: new Date().toISOString(),
      };
      await docRef.update(failed);
      if (existing.backorderDeliveryOrderId) {
        await collectionRef.doc(existing.backorderDeliveryOrderId).update(failed);
      }
      console.error(`[Odoo] Receipt retry failed for delivery ${id}: ${odooError.message}`);
      return { id, ...existing, ...failed };
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

const { dispatchMaterials } = require('../../utils/dispatchMaterials');
const { isFuelReady } = require('../../utils/fuelEligibility');
/**
 * trucks-Sphere-Backend src/delivery-orders/service.js
 * **/
const { db, admin } = require('../../../config/firebase');
const { isWarehouseReceipt, acceptanceUpdates, denialUpdates, validateWarehouseUpdate, warehouseWeighOutUpdates } = require('../warehouse-jobs/receipt');
const { getNextId } = require('../../utils/counterService');
const { generateJobIdForPO } = require('../../utils/jobIdService');
const girService = require('../../integrations/girService');
const { generateTrackingId } = require('../../utils/trackingUtils');
const snapshotStore = require('../../utils/snapshotStore');
const { JOB_STATUS, normalizeJobStatus, isActiveJob } = require('../../utils/jobLifecycle');
const { buildBackorder, isBackorderCreationEnabled, planSiteNetBackorder } = require('./backorder');
const stockService = require('../stocks/service');
const collectionRef = db.collection('deliveryOrders');
const purchaseOrdersCollection = db.collection('purchaseOrders');

const COLLECTION_NAME = 'deliveryOrders';

function normalizeMaterialSource(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeBanker(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isWarehouseDelivery(data = {}) {
  return Boolean(data.isWarehouseDelivery)
    || String(data.deliveryOrigin || '').trim().toLowerCase() === 'warehouse'
    || String(data.materialSource || '').trim().toLowerCase() === 'warehouse';
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
  if (item.quarryId && item.siteId && item.materials?.length && item.poNumber) return item;

  const po = snapshotStore.getById('purchaseOrders', item.purchaseOrderId);
  if (!po) return item;

  return {
    ...item,
    poNumber: item.poNumber || po.poNumber || '',
    materials: dispatchMaterials(item, po),
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
    const writeStocks = await stockService.prepare(transaction, { ...sourceSnapshot.data(), ...updates, id });
    writeStocks();

    if (!isBackorderCreationEnabled()) {
      transaction.update(docRef, updates);
      return { backorder: null };
    }

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
      const allJobs = snapshotStore.getAll(COLLECTION_NAME);
      results = results.filter((item) => isFuelReady(item, allJobs));
    }
    // Post-filter by jobId
    if (jobId) {
      results = results.filter(item => item.jobId === jobId || item.id === jobId || item.receiptNoteId === jobId);
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
      if (data.purchaseOrderId) {
        const poSnapshot = await purchaseOrdersCollection.doc(data.purchaseOrderId).get();
        const po = poSnapshot.exists ? poSnapshot.data() : null;
        const closed = ['completed', 'complete', 'delivered', 'fulfilled', 'closed', 'cancelled', 'canceled', 'archived', 'excess', 'overdelivered', 'over_delivered'];
        if (po && closed.includes(String(po.status || '').trim().toLowerCase())) {
          throw Object.assign(new Error('This purchase order is closed. Select an open purchase order.'), { statusCode: 409, code: 'PURCHASE_ORDER_CLOSED' });
        }
      }
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
        poNumber: purchaseOrderContext?.poNumber || data.poNumber || '',
        materialSource: normalizeMaterialSource(data.materialSource),
        banker: isWarehouseDelivery(data) ? 'Warehouse-banker' : normalizeBanker(data.banker),
        quarryId: data.quarryId || purchaseOrderContext?.quarryId || '',
        quarryName: data.quarryName || purchaseOrderContext?.quarryName || '',
        siteId: data.siteId || purchaseOrderContext?.siteId || '',
        siteName: data.siteName || purchaseOrderContext?.siteName || '',
        materials: dispatchMaterials(data, purchaseOrderContext),
        status: normalizeJobStatus(data.status, JOB_STATUS.CREATED),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      if (item.driverId || item.vehicleId) {
        girService.clearFuelSession({ driverId: item.driverId, vehicleId: item.vehicleId }).catch((error) => console.error('[GIR/FMS] Failed to clear previous fuel session:', error.message));
      }
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
      validateWarehouseUpdate(existing, data);
      const updates = { ...data, updatedAt: new Date().toISOString() };
      // MIF identifiers are generated on the server so offline/retried mobile
      // submissions cannot create duplicate inspection numbers.
      if (data.materialInspection && typeof data.materialInspection === 'object') {
        const shipment = existing.warehouseJobId ? snapshotStore.getById('warehouseJobs', existing.warehouseJobId) : null;
        const inspection = { ...data.materialInspection,
          driverName: existing.materialInspection?.driverName || existing.driverName || shipment?.driverName || '',
          plateNumber: existing.materialInspection?.plateNumber || existing.plateNumber || shipment?.plateNumber || '',
        };
        if (!existing.materialInspection?.mrfNumber) {
          const counterRef = db.collection('counters').doc('materialInspectionReceiptForm');
          const sequence = await db.runTransaction(async (transaction) => {
            const counter = await transaction.get(counterRef);
            const next = Number(counter.data()?.value || 0) + 1;
            transaction.set(counterRef, { value: next, updatedAt: new Date().toISOString() }, { merge: true });
            return next;
          });
          // MIF is an extension of the delivery job identifier, with a
          // globally incremental receipt suffix for clear audit tracing.
          const jobReference = String(existing.jobId || id).replace(/-/g, '/');
          inspection.mrfNumber = `${jobReference}/MIF${String(sequence).padStart(4, '0')}`;
          inspection.inspectedAt = inspection.inspectedAt || new Date().toISOString();
        } else {
          inspection.mrfNumber = existing.materialInspection.mrfNumber;
        }
        updates.materialInspection = { ...existing.materialInspection, ...inspection };
        if (isWarehouseReceipt(existing)) {
          updates.status = JOB_STATUS.COMPLETED;
          updates.workflowStage = 'inspected';
          updates.currentStage = 'completed';
          updates.completedAt = updates.updatedAt;
        }
      }
      if (updates.status) updates.status = normalizeJobStatus(updates.status, normalizeJobStatus(existing.status));
      if (Object.prototype.hasOwnProperty.call(data, 'materialSource')) {
        updates.materialSource = normalizeMaterialSource(data.materialSource);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'banker')) {
        updates.banker = isWarehouseDelivery({ ...existing, ...updates })
          ? 'Warehouse-banker'
          : normalizeBanker(data.banker);
      } else if (isWarehouseDelivery({ ...existing, ...updates })) {
        updates.banker = 'Warehouse-banker';
      }
      // A security stop is intentionally enforced server-side. A client must
      // never be able to move a flagged vehicle into the site weights queue
      // until an administrator has cleared the flag and unsuspended it.
      const isEnteringSiteWeighIn = Object.prototype.hasOwnProperty.call(data, 'siteWeighInWeight')
        && data.siteWeighInWeight !== null
        && data.siteWeighInWeight !== ''
        && Number.isFinite(Number(data.siteWeighInWeight));
      if (isEnteringSiteWeighIn && (existing.securityFlag?.status === 'flagged' || existing.isFlagged === true)) {
        const error = new Error('This delivery has a security flag and cannot be weighed in until it is cleared and the fleet is unsuspended.');
        error.statusCode = 409;
        error.code = 'SECURITY_FLAG_UNRESOLVED';
        throw error;
      }
      const enteredWeightsQueue = applySiteArrivalWorkflow(data, updates, existing);
      Object.assign(updates, warehouseWeighOutUpdates(existing, data, updates.updatedAt));
      // Warehouse quantities retain their product units; truck net weight is separate.
      if (isWarehouseReceipt(existing) && data.siteWeighOutWeight != null) delete updates.quantityDelivered;
      const wasCompletedAtStart = [JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED]
        .includes(normalizeJobStatus(existing.status));
      const isNowCompleted = [JOB_STATUS.SITE_WEIGHED_OUT, JOB_STATUS.COMPLETED]
        .includes(normalizeJobStatus(updates.status, normalizeJobStatus(existing.status)));
      // Warehouse shipments must record site weigh-out before a receipt note is
      // allocated; quarry deliveries allocate it on completion (site weigh-out).
      const siteWeighOutRecorded = updates.siteWeighOutWeight != null || existing.siteWeighOutWeight != null;
      const readyForReceiptNote = !isWarehouseReceipt(existing) || siteWeighOutRecorded;
      if (isNowCompleted && readyForReceiptNote && !existing.receiptNoteId && !updates.receiptNoteId) {
        const allocated = existing.receiptNote || existing.grnNumber || `${existing.jobId || id}/${await getNextId('receipt_note')}`;
        updates.receiptNoteId = await db.runTransaction(async transaction => {
          const current = await transaction.get(docRef);
          const saved = current.data()?.receiptNoteId;
          if (saved) return saved;
          transaction.update(docRef, { receiptNoteId: allocated });
          return allocated;
        });
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
      const backorderPlan = !isWarehouseReceipt(existing) && isBackorderCreationEnabled()
        ? planSiteNetBackorder(existing, updates)
        : null;
      const backorderResult = backorderPlan
        ? await applyUpdateWithBackorder(docRef, id, updates)
        : (await stockService.persistDelivery(docRef, updates), { backorder: null });
      console.debug('[SiteWeights] delivery order update succeeded', { documentId: id });

      // Diagnostic verification of the exact document written. Remove this
      // direct read after the transition has been verified in production.
      const persistedDocument = await docRef.get();
      const persisted = persistedDocument.data() || {};
      const receiptReference = updates.receiptNoteId || updates.receiptNote || persisted.receiptNoteId || persisted.receiptNote;
      if (receiptReference && (persisted.driverId || existing.driverId || persisted.vehicleId || existing.vehicleId)) {
        girService.setJobReference({
          driverId: persisted.driverId || existing.driverId,
          vehicleId: persisted.vehicleId || existing.vehicleId,
          vendorId: persisted.vendorId || existing.vendorId,
          jobId: receiptReference,
        }).catch((error) => console.error('[GIR/FMS] Failed to attach RN job reference:', error.message));
      }
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
      
      if (!wasCompleted && isNowCompleted && !isWarehouseReceipt(existing)) {
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
                  currentVehicleId: admin.firestore.FieldValue.delete(),
                  currentVehiclePlate: admin.firestore.FieldValue.delete(),
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
                  currentDriverId: admin.firestore.FieldValue.delete(),
                  currentDriverName: admin.firestore.FieldValue.delete(),
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



      return {
        id: persistedDocument.id,
        ...persisted,
        ...(backorderResult.backorder ? { backorder: backorderResult.backorder } : {}),
      };
    } catch (error) {
      console.error('delivery_ordersService._applyUpdate error:', error);
      throw error;
    }
  },

  async denyWarehouse(id, actor, reason) {
    return db.runTransaction(async (transaction) => {
      const ref = collectionRef.doc(id);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const job = snapshot.data();
      if (actor.siteId && job.siteId && actor.siteId !== job.siteId) throw Object.assign(new Error('Delivery belongs to another site.'), { statusCode: 403 });
      const updates = denialUpdates(job, actor, reason);
      transaction.update(ref, updates);
      return { id, ...job, ...updates };
    });
  },

  async acceptWarehouse(id, actor) {
    return db.runTransaction(async (transaction) => {
      const ref = collectionRef.doc(id);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return null;
      const job = snapshot.data();
      if (actor.siteId && job.siteId && actor.siteId !== job.siteId) {
        throw Object.assign(new Error('Delivery belongs to another site.'), { statusCode: 403 });
      }
      const updates = acceptanceUpdates(job, actor);
      if (updates) {
        const writeStocks = await stockService.prepare(transaction, { ...job, ...updates, id });
        writeStocks();
        transaction.update(ref, updates);
      }
      return { id, ...job, ...updates };
    });
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

  async delete(id) {
    try {
      await stockService.deleteDelivery(collectionRef.doc(id));
    } catch (error) {
      console.error('delivery_ordersService.delete error:', error);
      throw error;
    }
  },
};

module.exports = delivery_ordersService;

const { db } = require('../../../config/firebase');
const stockService = require('../stocks/service');
const snapshotStore = require('../../utils/snapshotStore');
const workflow = require('./storeReceiving');
const { buildDeliverySummary, fulfillmentUpdates } = require('../purchase-orders/deliverySummary');

async function transition(id, input, actor, stage) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(input.requestId || ''))) {
    throw Object.assign(new Error('A unique request ID is required.'), { statusCode: 400 });
  }
  const ref = db.collection('deliveryOrders').doc(id);
  const committed = await db.runTransaction(async tx => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error('Delivery not found.'), { statusCode: 404 });
    const job = { ...doc.data(), id: doc.id };
    workflow.assertAccess(job, actor);
    const decisionKey = stage === 'receiving' ? 'storeReceiving' : 'storeQualityInspection';
    if (job[decisionKey]?.requestId === input.requestId && job[decisionKey]?.actorUid === actor.uid) return { job };
    const now = new Date().toISOString();
    const updates = stage === 'receiving' ? workflow.receiveUpdates(job, input, actor, now) : workflow.inspectionUpdates(job, input, actor, now);
    let counterRef;
    let sequence;
    if (stage === 'inspection') {
      counterRef = db.collection('counters').doc('materialInspectionReceiptForm');
      const counter = await tx.get(counterRef);
      sequence = Number(counter.data()?.value || 0) + 1;
      updates.materialInspection.mrfNumber = `${job.jobId || job.id}/MIF${String(sequence).padStart(4, '0')}`;
    }
    updates[decisionKey] = { ...updates[decisionKey], requestId: input.requestId, actorUid: actor.uid };
    const result = { ...job, ...updates };
    let purchaseOrder;
    let poRef;
    let poUpdates;
    if (result.receivingStatus === 'inventory_added' && job.purchaseOrderId) {
      poRef = db.collection('purchaseOrders').doc(job.purchaseOrderId);
      const poDoc = await tx.get(poRef);
      if (poDoc.exists) {
        const trips = await tx.get(db.collection('deliveryOrders').where('purchaseOrderId', '==', job.purchaseOrderId));
        const allTrips = trips.docs.filter(doc => doc.id !== id).map(doc => ({ ...doc.data(), id: doc.id }));
        purchaseOrder = { ...poDoc.data(), id: poDoc.id };
        const summary = buildDeliverySummary(purchaseOrder, [...allTrips, result]);
        poUpdates = fulfillmentUpdates(purchaseOrder, summary, now);
        purchaseOrder = { ...purchaseOrder, ...poUpdates };
      }
    }
    const writeStocks = await stockService.prepare(tx, result);
    if (counterRef) tx.set(counterRef, { value: sequence, updatedAt: now }, { merge: true });
    writeStocks();
    tx.update(ref, updates);
    if (poUpdates) tx.update(poRef, poUpdates);
    return { job: result, purchaseOrder };
  });
  const saved = committed.job;
  if (committed.purchaseOrder) snapshotStore.applyCommittedUpdate('purchaseOrders', committed.purchaseOrder.id, committed.purchaseOrder);
  snapshotStore.applyCommittedUpdate('deliveryOrders', id, saved);
  return saved;
}
module.exports = { transition };

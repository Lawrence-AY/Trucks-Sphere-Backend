const { db } = require('../../../config/firebase');
const { buildDeliverySummary } = require('./deliverySummary');

const adminRoles = new Set(['admin', 'admin_edit', 'management', 'management_edit', 'management_lite', 'superadmin', 'super_admin']);
const vendorKey = (value) => String(value || '').trim().toUpperCase().replace(/^V0*(\d+)$/, 'V$1');

/** Recompute from every linked job in a transaction, including concurrent trips. */
async function reconcileDeliverySummary(purchaseOrderId) {
  if (!purchaseOrderId) return;
  return db.runTransaction(async (tx) => {
    const ref = db.collection('purchaseOrders').doc(String(purchaseOrderId));
    const poDoc = await tx.get(ref);
    if (!poDoc.exists) return;
    const po = { ...poDoc.data(), id: poDoc.id };
    const trips = await tx.get(db.collection('deliveryOrders').where('purchaseOrderId', '==', poDoc.id));
    const summary = buildDeliverySummary(po, trips.docs.map((doc) => ({ ...doc.data(), id: doc.id })));
    if (JSON.stringify(summary) === JSON.stringify(po.deliverySummary)) return summary;
    const previousTotals = po.deliverySummary?.totals || [];
    const increased = summary.totals.filter((total) => total.overDelivered && (
      !previousTotals.find((prior) => prior.unit === total.unit)?.overDelivered
      || total.variance > (previousTotals.find((prior) => prior.unit === total.unit)?.variance || 0)
    ));
    let recipients = [];
    if (increased.length) {
      const users = await tx.get(db.collection('users'));
      recipients = users.docs.filter((doc) => {
        const user = doc.data();
        return user.disabled !== true && (adminRoles.has(String(user.role || '').toLowerCase())
          || (user.role === 'vendor' && Boolean(po.vendorId) && [user.vendorId, user.entityId].some((id) => vendorKey(id) === vendorKey(po.vendorId))));
      });
    }
    const createdAt = new Date().toISOString();
    tx.update(ref, { deliverySummary: summary, updatedAt: createdAt });
    const message = `${po.poNumber || po.id}: ` + increased.map((total) =>
      `delivered ${total.deliveredQuantity} ${total.unit}, ordered ${total.orderedQuantity} ${total.unit}, variance +${total.variance} ${total.unit}`
    ).join('; ');
    // The summary and notifications commit together. Retries cannot duplicate an alert.
    for (const user of recipients) {
      tx.set(db.collection('notifications').doc(), {
        userId: user.data().uid || user.id, read: false, createdAt,
        title: 'Purchase order over-delivered', message, type: 'purchase_order_over_delivery',
        purchaseOrderId: po.id, poNumber: po.poNumber || '', vendorId: po.vendorId || '', deliverySummary: summary,
      });
    }
    return summary;
  });
}

/** Covers existing orders, new trips, corrections, cancellations, and deleted trips. */
function startDeliveryAlertSync(snapshotStore) {
  const pending = new Set();
  const linkedOrders = new Map();
  let running = false;
  let stopped = false;
  let retryTimer;
  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (pending.size && !stopped) {
        const id = pending.values().next().value;
        pending.delete(id);
        try { await reconcileDeliverySummary(id); }
        catch (error) {
          console.error('[PO delivery alerts] Synchronization failed:', error.message);
          pending.add(id);
          retryTimer = setTimeout(drain, 5000);
          retryTimer.unref?.();
          break;
        }
      }
    } finally { running = false; }
  }
  const enqueue = (id) => { if (id) pending.add(id); void drain(); };
  const unsubscribeTrips = snapshotStore.subscribe('deliveryOrders', (change) => {
    const previous = linkedOrders.get(change.id);
    const current = change.record?.purchaseOrderId;
    if (change.type === 'removed') linkedOrders.delete(change.id);
    else linkedOrders.set(change.id, current);
    enqueue(previous);
    enqueue(current);
  });
  const unsubscribeOrders = snapshotStore.subscribe('purchaseOrders', (change) => {
    if (change.type !== 'removed') enqueue(change.id);
  });
  return () => { stopped = true; clearTimeout(retryTimer); unsubscribeTrips(); unsubscribeOrders(); };
}

module.exports = { reconcileDeliverySummary, startDeliveryAlertSync };

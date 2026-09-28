const { db } = require('../../../config/firebase');
const { prepare } = require('./service');

// Initial Firestore delivery snapshots include existing app records. Subsequent
// changes keep stock projections current without a user-driven import.
function startStockSync(snapshotStore) {
  const pending = new Set();
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
        try {
          await db.runTransaction(async (tx) => {
            const doc = await tx.get(db.collection('deliveryOrders').doc(id));
            if (doc.exists) {
              const write = await prepare(tx, { ...doc.data(), id: doc.id });
              write();
            }
          });
        } catch (error) {
          console.error('[Stocks] Automatic synchronization failed:', error.message);
          pending.add(id);
          retryTimer = setTimeout(drain, 5000);
          retryTimer.unref?.();
          break;
        }
      }
    } finally { running = false; }
  }
  const unsubscribe = snapshotStore.subscribe('deliveryOrders', (change) => {
    if (change.type === 'removed') return;
    pending.add(change.id);
    void drain();
  });
  return () => { stopped = true; clearTimeout(retryTimer); unsubscribe(); };
}
module.exports = { startStockSync };

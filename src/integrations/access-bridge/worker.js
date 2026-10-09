const { randomUUID } = require('node:crypto');
const { readConfig } = require('./config');
const { createProcessor } = require('./processor');
const { createStore } = require('./store');
const { createLoadingProcessor } = require('./loading');
let current = { enabled: false };
const status = () => current;
function startAccessBridge({ db, deliveries, config = readConfig(), logger = console }) {
  current = { enabled: config.enabled, sourceId: config.sourceId };
  if (!config.enabled) return { stop: async () => {} };
  const owner = randomUUID(), store = createStore(db, config.sourceId);
  let running = false, stopped = false;
  const repository = {
    async all(collection) {
      const snapshot = await db.collection(collection).get();
      return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    },
    async bind(id, key, source, siteId) {
      const ref = db.collection('deliveryOrders').doc(id);
      return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('JOB_NOT_FOUND');
        const job = snapshot.data();
        if (job.accessBridgeKey && job.accessBridgeKey !== key) throw new Error('JOB_ALREADY_BOUND');
        if (job.siteId && job.siteId !== siteId) throw new Error('SITE_MISMATCH');
        const patch = { accessBridgeKey: key, accessBridgeSource: source, siteId };
        transaction.update(ref, patch);
        return { ...job, ...patch, id };
      });
    },
  };
  const processor = config.weighingMode === 'unloading'
    ? createProcessor({ repository, deliveries, config })
    : createLoadingProcessor({ db, config, logger });
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const pending = await store.pending();
      if (!pending.length || !await store.claim(owner)) return;
      let renewedAt = Date.now();
      processor.resetBatch?.();
      for (const event of pending) {
        if (stopped) break;
        if (Date.now() - renewedAt > 30000) {
          if (!await store.claim(owner)) break;
          renewedAt = Date.now();
        }
        try {
          logger.log('[Access bridge] processing record:', event.id, event.table_name, event.payload);
          await store.save(event.id, await processor(event));
        }
        catch (error) {
          await store.save(event.id, { status: 'blocked', reason: error.code || error.message });
          logger.warn('[Access bridge] Capture awaiting resolution:', event.id, error.code || error.message);
        }
      }
      current.lastPollAt = new Date().toISOString();
      current.error = null;
    } catch (error) {
      current.error = error.message;
      logger.error('[Access bridge]', error.message);
    } finally { running = false; }
  }
  const timer = setInterval(tick, config.pollMs);
  timer.unref();
  void tick();
  return { async stop() {
    stopped = true;
    clearInterval(timer);
    while (running) await new Promise(resolve => setTimeout(resolve, 20));
    await store.release(owner);
  } };
}
module.exports = { startAccessBridge, status };

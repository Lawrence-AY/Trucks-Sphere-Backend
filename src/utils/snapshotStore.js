/**
 * Snapshot Store — In-memory cache backed by Firestore onSnapshot listeners.
 * Eliminates repeated collection reads — every request returns snapshot data instantly.
 *
 * Each collection is watched via onSnapshot once at startup; subsequent reads
 * are served from the local cache without hitting Firestore again.
 *
 * Collections watched:
 *   - fuelRecords
 *   - deliveryOrders
 *   - vendors
 *   - drivers
 *   - vehicles
 *   - purchaseOrders
 *   - materials
 *   - quarries
 *   - sites
 *   - weighments
 *   - checkpoints
 *   - uploads
 */
const { db } = require('../../config/firebase');

// ─── In-memory store ───
const store = new Map();           // collectionName → array of { id, ...data }
const ready = new Map();           // collectionName → boolean (listener has received first snapshot)

// ─── Subscribers for readiness notifications ───
const readinessSubscribers = [];

function notifyReady(collectionName) {
  ready.set(collectionName, true);
  console.log(`[Snapshot] ${collectionName} ready — ${store.get(collectionName)?.length || 0} docs cached`);
  // Check if all collections are ready
  const allReady = [...ready.entries()].every(([, v]) => v === true);
  if (allReady) {
    readinessSubscribers.forEach(cb => cb());
    readinessSubscribers.length = 0;
  }
}

/**
 * Start watching a Firestore collection via onSnapshot.
 * Any writes to Firestore are reflected in the local cache within milliseconds.
 */
function watchCollection(name, ref) {
  ready.set(name, false);
  store.set(name, []);

  ref.onSnapshot(
    (snapshot) => {
      const docs = [];
      snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
      store.set(name, docs);
      if (!ready.get(name)) notifyReady(name);
    },
    (error) => {
      console.error(`[Snapshot] Error on ${name}:`, error.message);
    }
  );
}

/**
 * Initialize all snapshot listeners.
 * Call once at server startup.
 */
function init() {
  console.log('[Snapshot] Initializing real-time caches...');

  watchCollection('fuelRecords', db.collection('fuelRecords'));
  watchCollection('deliveryOrders', db.collection('deliveryOrders'));
  watchCollection('vendors', db.collection('vendors'));
  watchCollection('drivers', db.collection('drivers'));
  watchCollection('vehicles', db.collection('vehicles'));
  watchCollection('purchaseOrders', db.collection('purchaseOrders'));
  watchCollection('materials', db.collection('materials'));
  watchCollection('quarries', db.collection('quarries'));
  watchCollection('sites', db.collection('sites'));
  watchCollection('weighments', db.collection('weighbridgeRecords'));
  watchCollection('checkpoints', db.collection('checkpoints'));
  watchCollection('uploads', db.collection('uploads'));
}

/**
 * Wait until all snapshot listeners have received their first data batch.
 */
function waitUntilReady() {
  const allReady = [...ready.entries()].every(([, v]) => v === true);
  if (allReady) return Promise.resolve();
  return new Promise(resolve => readinessSubscribers.push(resolve));
}

/**
 * Get all documents from a cached collection.
 * Returns array of { id, ...data } objects.
 */
function getAll(collectionName) {
  return store.get(collectionName) || [];
}

/**
 * Get a single document by ID from a cached collection.
 */
function getById(collectionName, id) {
  const docs = store.get(collectionName) || [];
  return docs.find(doc => doc.id === id) || null;
}

/**
 * Check if a collection cache has been populated.
 */
function isReady(collectionName) {
  return ready.get(collectionName) === true;
}

module.exports = { init, waitUntilReady, getAll, getById, isReady };
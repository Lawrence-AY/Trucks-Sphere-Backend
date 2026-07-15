/**
 * Snapshot Store — In-memory cache backed by Firestore onSnapshot listeners.
 * Eliminates repeated collection reads — every request returns snapshot data instantly.
 *
 * Each collection is watched via onSnapshot once at startup; subsequent reads
 * are served from the local cache without hitting Firestore again.
 *
 * Now integrated with Redis for persistence across server restarts.
 * The snapshotStore is always the authoritative source; Redis is a write-behind
 * persistence layer for warm restarts.
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
 *   - customers
 *   - fuelStations
 *   - users
 *   - roles
 *   - auditLogs
 *   - siteGeolocations
 */
const { db } = require('../../config/firebase');
const cacheService = require('./cacheService');

// ─── In-memory store ───
const store = new Map();           // collectionName → array of { id, ...data }
const ready = new Map();           // collectionName → boolean (listener has received first snapshot)
const hashes = new Map();          // collectionName → latest SHA-256 hash (for ETag)
const timestamps = new Map();      // collectionName → last update timestamp

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
 * Changes are also persisted to Redis asynchronously.
 */
function watchCollection(name, ref) {
  ready.set(name, false);
  store.set(name, []);
  hashes.set(name, '');
  timestamps.set(name, 0);

  ref.onSnapshot(
    (snapshot) => {
      const docs = [];
      snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
      store.set(name, docs);

      const hash = cacheService.generateHash(docs);
      hashes.set(name, hash);
      timestamps.set(name, Date.now());

      // Persist to Redis asynchronously (fire-and-forget)
      cacheService.persistSnapshot(name, docs).catch(() => {});

      if (!ready.get(name)) notifyReady(name);
    },
    (error) => {
      console.error(`[Snapshot] Error on ${name}:`, error.message);
    }
  );
}

/**
 * Try to warm a collection from Redis before Firestore listener connects.
 * Returns true if warm data was loaded, false otherwise.
 */
async function warmFromRedis(name) {
  try {
    const cached = await cacheService.loadSnapshot(name);
    if (cached && cached.docs && cached.docs.length > 0) {
      store.set(name, cached.docs);
      hashes.set(name, cached.hash || '');
      timestamps.set(name, cached.updatedAt || 0);
      console.log(`[Snapshot] ${name} warmed from Redis — ${cached.docs.length} docs`);
      return true;
    }
  } catch (err) {
    // Silently ignore — Firestore listener will populate the cache
  }
  return false;
}

/**
 * Initialize all snapshot listeners.
 * Tries to warm caches from Redis first, then starts Firestore onSnapshot listeners.
 * Call once at server startup.
 */
async function init() {
  console.log('[Snapshot] Initializing real-time caches...');

  const collections = [
    { name: 'fuelRecords', ref: db.collection('fuelRecords') },
    { name: 'deliveryOrders', ref: db.collection('deliveryOrders') },
    { name: 'vendors', ref: db.collection('vendors') },
    { name: 'drivers', ref: db.collection('drivers') },
    { name: 'vehicles', ref: db.collection('vehicles') },
    { name: 'purchaseOrders', ref: db.collection('purchaseOrders') },
    { name: 'materials', ref: db.collection('materials') },
    { name: 'quarries', ref: db.collection('quarries') },
    { name: 'sites', ref: db.collection('sites') },
    { name: 'weighments', ref: db.collection('weighbridgeRecords') },
    { name: 'checkpoints', ref: db.collection('checkpoints') },
    { name: 'uploads', ref: db.collection('uploads') },
    { name: 'customers', ref: db.collection('customers') },
    { name: 'fuelStations', ref: db.collection('fuelStations') },
    { name: 'users', ref: db.collection('users') },
    { name: 'roles', ref: db.collection('roles') },
    { name: 'auditLogs', ref: db.collection('auditLogs') },
    { name: 'siteGeolocations', ref: db.collection('siteGeolocations') },
  ];

  // Phase 1: Warm from Redis (parallel)
  await Promise.allSettled(
    collections.map(col => warmFromRedis(col.name))
  );

  // Mark collections as ready if they were warmed from Redis
  // The Firestore listener will update them with fresh data shortly
  for (const col of collections) {
    if (store.has(col.name) && store.get(col.name).length > 0) {
      ready.set(col.name, true);
      console.log(`[Snapshot] ${col.name} pre-warmed from Redis`);
    }
  }

  // Phase 2: Start Firestore listeners (these will update with any deltas)
  for (const col of collections) {
    watchCollection(col.name, col.ref);
  }
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

/**
 * Get the current hash for a collection (for ETag/304 support).
 */
function getHash(collectionName) {
  return hashes.get(collectionName) || '';
}

/**
 * Get the last update timestamp for a collection.
 */
function getTimestamp(collectionName) {
  return timestamps.get(collectionName) || 0;
}

/**
 * Manually invalidate a collection's Redis cache (e.g., after a direct write).
 * The in-memory cache is updated by onSnapshot automatically.
 */
async function invalidateRedisCache(collectionName) {
  await cacheService.invalidate(collectionName);
}

module.exports = {
  init,
  waitUntilReady,
  getAll,
  getById,
  isReady,
  getHash,
  getTimestamp,
  invalidateRedisCache,
};
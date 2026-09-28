/**
 * Unified Cache Service
 * Combines Redis (persistent, cross-process) with in-memory snapshotStore.
 *
 * Strategy:
 *   1. On startup: load cached data from Redis -> populate snapshotStore (if Redis is available)
 *   2. On each snapshotStore update (via onSnapshot): persist to Redis asynchronously
 *   3. On read: always serve from snapshotStore (fastest path)
 *   4. Redis acts as a warm-reload buffer so server restarts don't require full Firestore re-sync
 *
 * All operations are non-blocking — if Redis is down, the service continues seamlessly.
 */

const redis = require('../../config/redis');
const crypto = require('crypto');

const REDIS_PREFIX = 'snapshot:';
const REDIS_META_PREFIX = 'snapshot:meta:';

/**
 * Build Redis key for a collection.
 */
function redisKey(collectionName) {
  return `${REDIS_PREFIX}${collectionName}`;
}

function metaKey(collectionName) {
  return `${REDIS_META_PREFIX}${collectionName}`;
}

/**
 * Generate a hash of the data for ETag comparison.
 * Uses SHA-256 of the JSON-serialized data (fast enough for this use case).
 */
function generateHash(data) {
  if (!Array.isArray(data) || data.length === 0) return '';
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .substring(0, 16);
}

/**
 * Persist a collection's snapshot to Redis.
 * Called after onSnapshot delivers new data.
 */
async function persistSnapshot(collectionName, docs) {
  if (!redis.isAvailable()) return;
  try {
    const hash = generateHash(docs);
    await redis.set(redisKey(collectionName), docs, 0); // persist indefinitely
    await redis.set(metaKey(collectionName), { hash, updatedAt: Date.now() }, 0);
  } catch (err) {
    // Silently fail — in-memory cache is authoritative
  }
}

/**
 * Load a collection's snapshot from Redis.
 * Returns { docs, hash } or null if not found.
 */
async function loadSnapshot(collectionName) {
  if (!redis.isAvailable()) return null;
  try {
    const docs = await redis.get(redisKey(collectionName));
    const meta = await redis.get(metaKey(collectionName));
    if (!docs || !Array.isArray(docs)) return null;
    return {
      docs,
      hash: meta?.hash || '',
      updatedAt: meta?.updatedAt || 0,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Get the current hash for a collection from Redis.
 */
async function getHash(collectionName) {
  if (!redis.isAvailable()) return null;
  try {
    const meta = await redis.get(metaKey(collectionName));
    return meta?.hash || null;
  } catch {
    return null;
  }
}

/**
 * Invalidate a collection in Redis (e.g., after a write).
 */
async function invalidate(collectionName) {
  if (!redis.isAvailable()) return;
  try {
    await redis.del(redisKey(collectionName), metaKey(collectionName));
  } catch {
    // Silently fail
  }
}

/**
 * Invalidate multiple collections at once.
 */
async function invalidateMany(collectionNames) {
  if (!redis.isAvailable()) return;
  try {
    const keys = [];
    for (const name of collectionNames) {
      keys.push(redisKey(name), metaKey(name));
    }
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Silently fail
  }
}

module.exports = {
  persistSnapshot,
  loadSnapshot,
  getHash,
  invalidate,
  invalidateMany,
  generateHash,
};
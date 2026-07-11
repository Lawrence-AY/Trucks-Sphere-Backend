/**
 * Redis client with graceful fallback.
 * If Redis is unavailable, the application continues using in-memory caches.
 * Logs exactly one warning message when Redis is unreachable.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const CACHE_TTL_DEFAULT = 300; // 5 minutes default TTL

let redis = null;
let redisAvailable = false;
let redisErrorLogged = false;

function createClient() {
  try {
    const client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      retryStrategy(_times) {
        return null; // stop immediately on failure
      },
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    client.on('connect', () => {
      redisAvailable = true;
      redisErrorLogged = false;
      console.log('[Redis] Connected to', REDIS_URL);
    });

    client.on('error', () => {
      redisAvailable = false;
      if (!redisErrorLogged) {
        redisErrorLogged = true;
        console.warn('[Redis] Not available — running with in-memory cache only');
      }
    });

    client.on('close', () => {
      redisAvailable = false;
    });

    return client;
  } catch (_err) {
    if (!redisErrorLogged) {
      redisErrorLogged = true;
      console.warn('[Redis] Not available — running with in-memory cache only');
    }
    return null;
  }
}

/**
 * Initialize Redis connection.
 * Call once at server startup.
 */
async function init() {
  redis = createClient();
  if (!redis) return;
  try {
    await redis.connect();
    console.log('[Redis] Initialized successfully');
  } catch (_err) {
    redisAvailable = false;
    if (!redisErrorLogged) {
      redisErrorLogged = true;
      console.warn('[Redis] Not available — running with in-memory cache only');
    }
  }
}

/**
 * Check if Redis is available for operations.
 */
function isAvailable() {
  return redisAvailable && redis !== null && redis.status === 'ready';
}

/**
 * Get a value from Redis by key.
 * Returns parsed JSON or null.
 */
async function get(key) {
  if (!isAvailable()) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (_err) {
    return null;
  }
}

/**
 * Set a value in Redis with optional TTL (seconds).
 */
async function set(key, value, ttlSeconds = CACHE_TTL_DEFAULT) {
  if (!isAvailable()) return;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await redis.setex(key, ttlSeconds, serialized);
    } else {
      await redis.set(key, serialized);
    }
  } catch (_err) {
    // Silently fail — in-memory cache is authoritative
  }
}

/**
 * Delete one or more keys from Redis.
 */
async function del(...keys) {
  if (!isAvailable()) return;
  try {
    await redis.del(...keys);
  } catch (_err) {
    // Silently fail
  }
}

/**
 * Delete keys matching a pattern.
 */
async function delPattern(pattern) {
  if (!isAvailable()) return;
  try {
    const stream = redis.scanStream({ match: pattern, count: 100 });
    const pipeline = redis.pipeline();
    for await (const keys of stream) {
      if (keys.length > 0) {
        pipeline.del(...keys);
      }
    }
    await pipeline.exec();
  } catch (_err) {
    // Silently fail
  }
}

/**
 * Get the raw Redis client for advanced operations.
 */
function getClient() {
  return redis;
}

module.exports = {
  init,
  isAvailable,
  get,
  set,
  del,
  delPattern,
  getClient,
  CACHE_TTL_DEFAULT,
};
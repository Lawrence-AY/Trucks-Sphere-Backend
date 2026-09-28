/**
 * Redis Cache Checker
 * Run this to verify snapshot data has been persisted to Redis.
 *
 * Usage: node scripts/check-redis-cache.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const PREFIX = 'snapshot:';
const META_PREFIX = 'snapshot:meta:';

const collections = [
  'fuelRecords',
  'deliveryOrders',
  'vendors',
  'drivers',
  'vehicles',
  'purchaseOrders',
  'materials',
  'quarries',
  'sites',
  'weighments',
  'checkpoints',
  'uploads',
];

(async () => {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy() { return null; },
  });

  try {
    await redis.connect();
    console.log('✅ Connected to Redis at', REDIS_URL);
    console.log('');
    console.log('┌─────────────────────────┬────────┬───────────┐');
    console.log('│ Collection              │  Docs  │  Status   │');
    console.log('├─────────────────────────┼────────┼───────────┤');

    let totalDocs = 0;
    let cachedCount = 0;

    for (const name of collections) {
      const key = PREFIX + name;
      const metaKey = META_PREFIX + name;

      const docs = await redis.get(key);
      const meta = await redis.get(metaKey);

      const count = docs ? JSON.parse(docs).length : 0;
      const hash = meta ? JSON.parse(meta).hash : '-';
      const updated = meta ? new Date(JSON.parse(meta).updatedAt).toISOString() : '-';

      const status = count > 0 ? '✅ CACHED' : '❌ EMPTY';
      if (count > 0) {
        cachedCount++;
        totalDocs += count;
      }

      const nameCol = name.padEnd(23);
      const countCol = String(count).padStart(6);
      console.log(`│ ${nameCol}│${countCol} │ ${status.padEnd(9)} │`);
    }

    console.log('├─────────────────────────┼────────┼───────────┤');
    console.log(`│ TOTAL                   │ ${String(totalDocs).padStart(6)} │ ${cachedCount}/${collections.length} cached │`);
    console.log('└─────────────────────────┴────────┴───────────┘');
    console.log('');

    if (cachedCount === 0) {
      console.log('❌ No data found in Redis.');
      console.log('   Make sure the backend has been running with Redis available.');
      console.log('   The snapshotStore persists to Redis on every onSnapshot update.');
    } else if (cachedCount < collections.length) {
      console.log('⚠️  Some collections not yet cached.');
      console.log('   This is normal — wait for the backend onSnapshot listener to fire.');
    } else {
      console.log('✅ All collections cached in Redis!');
      console.log('   Server restarts will warm from Redis instead of Firestore.');
    }
  } catch (err) {
    console.error('❌ Cannot connect to Redis:', err.message);
    console.log('');
    console.log('To start Redis on Windows:');
    console.log('  npm run redis');
    console.log('');
    console.log('Or manually:');
    console.log('  "C:\\Program Files\\Redis\\redis-server.exe" --port 6379');
    console.log('');
    console.log('The backend will auto-connect once Redis is running.');
  } finally {
    redis.disconnect();
  }
})();
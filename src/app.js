// app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Import Firebase config (must be initialized before any routes that use it)
const { db, admin } = require('../config/firebase');

// Import Redis config
const redis = require('../config/redis');

// Initialize real-time snapshot cache (eliminates repeated Firestore reads)
const snapshotStore = require('./utils/snapshotStore');

// Start Redis connection in background, then init snapshot store
// SnapshotStore will warm from Redis if available, then start Firestore listeners
const initPromise = (async () => {
  await redis.init();
  await snapshotStore.init();
})();

// Import routes
const truckRoutes = require('../routes/trucks');
const authRoutes = require('./modules/auth/routes');
const vendorsRoutes = require('./modules/vendors/routes');
const driversRoutes = require('./modules/drivers/routes');
const vehiclesRoutes = require('./modules/vehicles/routes');
const materialsRoutes = require('./modules/materials/routes');
const purchaseOrdersRoutes = require('./modules/purchase-orders/routes');
const deliveryOrdersRoutes = require('./modules/delivery-orders/routes');
const weighbridgeRoutes = require('./modules/weighbridge/routes');
const quarryRoutes = require('./modules/quarry/routes');
const siteRoutes = require('./modules/site/routes');
const checkpointsRoutes = require('./modules/checkpoints/routes');
const fuelRoutes = require('./modules/fuel/routes');
const fuelAuthorizationRoutes = require('./modules/fuel-authorization/routes');
const uploadsRoutes = require('./modules/uploads/routes');
const customersRoutes = require('./modules/customers/routes');
const fuelStationsRoutes = require('./modules/fuel-stations/routes');
const reportsRoutes = require('./modules/reports/routes');
const analyticsRoutes = require('./modules/analytics/routes');
const auditLogsRoutes = require('./modules/audit-logs/routes');
const usersRoutes = require('./modules/users/routes');
const rolesRoutes = require('./modules/roles/routes');
const masterDataRoutes = require('./modules/master-data/routes');
const { getNextId } = require('./utils/counterService');

const app = express();

// Enable ETag for smart 304 responses — saves bandwidth for unchanged data
app.set('etag', 'weak');

// Middleware
app.use(helmet());           // Security headers
app.use(cors());             // Enable CORS
app.use(express.json());     // Parse JSON bodies
app.use(morgan('combined')); // Logging

// ─── Client-side caching headers (stale-while-revalidate compatible) ───
app.use((_req, res, next) => {
  // Allow clients to cache API responses for 30 seconds
  // stale-while-revalidate allows serving stale while re-fetching in background
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  next();
});

// ─── Collection-to-cache-name mapping for ETag middleware ───
const COLLECTION_ETAG_MAP = {
  '/api/vendors': 'vendors',
  '/api/drivers': 'drivers',
  '/api/vehicles': 'vehicles',
  '/api/materials': 'materials',
  '/api/purchase-orders': 'purchaseOrders',
  '/api/delivery-orders': 'deliveryOrders',
  '/api/weighbridge': 'weighments',
  '/api/quarries': 'quarries',
  '/api/sites': 'sites',
  '/api/checkpoints': 'checkpoints',
  '/api/fuel': 'fuelRecords',
  '/api/uploads': 'uploads',
  '/api/customers': 'customers',
  '/api/fuel-stations': 'fuelStations',
  '/api/audit-logs': 'auditLogs',
  '/api/users': 'users',
  '/api/roles': 'roles',
};

/**
 * ETag middleware — returns 304 Not Modified when data hasn't changed.
 * Client sends If-None-Match header with previous ETag.
 * If the snapshot hash matches, the server responds with 304 (no body).
 */
app.use((req, res, next) => {
  // Only process GET requests on API routes
  if (req.method !== 'GET') return next();

  const basePath = Object.keys(COLLECTION_ETAG_MAP).find(prefix =>
    req.path.startsWith(prefix)
  );
  if (!basePath) return next();

  const cacheName = COLLECTION_ETAG_MAP[basePath];
  const currentETag = snapshotStore.getHash(cacheName);
  const clientETag = req.get('If-None-Match');

  // Always set ETag on the response
  if (currentETag) {
    res.set('ETag', `W/"${currentETag}"`);
    res.set('Last-Modified', new Date(snapshotStore.getTimestamp(cacheName)).toUTCString());
  }

  // If client's ETag matches, return 304 Not Modified
  if (clientETag && currentETag && clientETag === `W/"${currentETag}"`) {
    return res.status(304).end();
  }

  next();
});

// ─── Server-Sent Events (SSE) endpoint for real-time collection updates ───
const sseClients = new Map(); // clientId → { res, collections: Set<string> }

app.get('/api/sync/stream', (req, res) => {
  const clientId = req.query.clientId || `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Register client
  sseClients.set(clientId, { res, collections: new Set() });

  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Handle client unsubscribe
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});

/**
 * Notify SSE clients that a collection has been updated.
 * Called externally when a write occurs (e.g., after create/update/delete).
 */
function notifySSEClients(collectionName, data) {
  sseClients.forEach(({ res }, clientId) => {
    try {
      res.write(`event: ${collectionName}\ndata: ${JSON.stringify({
        collection: collectionName,
        timestamp: Date.now(),
        hash: snapshotStore.getHash(collectionName),
        ...(data && { data }),
      })}\n\n`);
    } catch {
      sseClients.delete(clientId);
    }
  });
}

// Make notifySSEClients available on the app for routes to use
app.set('notifySSEClients', notifySSEClients);

// ─── Counter API for sequential IDs ───
app.get('/api/counter/:entityType', async (req, res) => {
  try {
    const { entityType } = req.params;
    const nextId = await getNextId(entityType);
    res.json({ id: nextId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Firebase connection test endpoint
app.get('/api/test-firebase', async (req, res) => {
  try {
    // Write a test document
    const testRef = db.collection('_test').doc('connection');
    await testRef.set({
      message: 'Firebase is connected!',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Read it back
    const snapshot = await testRef.get();
    const data = snapshot.data();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Firebase test failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mount routes
app.use('/api/trucks', truckRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/vendors', vendorsRoutes);
app.use('/api/drivers', driversRoutes);
app.use('/api/vehicles', vehiclesRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/delivery-orders', deliveryOrdersRoutes);
app.use('/api/weighbridge', weighbridgeRoutes);
app.use('/api/quarries', quarryRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/checkpoints', checkpointsRoutes);
app.use('/api/fuel', fuelRoutes);
app.use('/api/fuel-authorization', fuelAuthorizationRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/fuel-stations', fuelStationsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/audit-logs', auditLogsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/master-data', masterDataRoutes);

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
// Always includes the error message so the client can surface it to the user.
// In development, the full stack trace is also included.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ 
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

module.exports = app;

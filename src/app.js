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

// Import security middleware
const { authRateLimiter, apiRateLimiter, inputSanitizer, requestSizeLimiter, helmetConfig } = require('./middleware/securityMiddleware');
const { auditLogger } = require('./middleware/auditMiddleware');

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
const vendorReportRoutes = require('./modules/reports/vendorReportRoutes');
const analyticsRoutes = require('./modules/analytics/routes');
const usersRoutes = require('./modules/users/routes');
const rolesRoutes = require('./modules/roles/routes');
const masterDataRoutes = require('./modules/master-data/routes');
const trackingRoutes = require('./modules/tracking/routes');
const issuesRoutes = require('./modules/issues/routes');
const notificationsRoutes = require('./modules/notifications/routes');
const { getNextId } = require('./utils/counterService');

const app = express();

const configuredCorsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Authentication is bearer-token based, not cookie based.  Keep the browser
// origin allow-list explicit and do not enable credentials: a wildcard origin
// is never safe alongside credentialed requests.
const allowedCorsOrigins = [...new Set([
  'https://trucksphere.app',
  'https://admin.trucksphere.app',
  'https://truck-app.expo.app',
  // Expo web development origins. Add a different development port through
  // CORS_ALLOWED_ORIGINS rather than broadening this to a wildcard.
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
  // Expo web served over the current LAN address during local device testing.
  // Add other deliberate development origins through CORS_ALLOWED_ORIGINS.
  'http://192.168.1.199:8081',
  ...configuredCorsOrigins,
])];

const corsOptions = {
  origin(origin, callback) {
    // Native clients and server-to-server calls have no Origin header. CORS
    // does not apply to them, so they remain supported without weakening web
    // origin checks.
    if (!origin || allowedCorsOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Rejected origin: ${origin}`);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // If an older browser cache still sends a conditional header during the
  // rollout, allow the preflight; the API itself no longer emits 304s.
  allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  credentials: false,
  maxAge: 86400,
  optionsSuccessStatus: 204,
};

// ─── Trust proxy for accurate IP detection behind load balancers ───
app.set('trust proxy', 1);

// Collection responses are authenticated and real-time. Disable framework
// ETags so a browser cannot answer a GET with a stale 304/body pairing.
app.set('etag', false);

// ─── Security Middleware (order matters) ───

// 1. Helmet with hardened security headers
app.use(helmet(helmetConfig));

// 2. CORS — handle preflight before routing, then apply the same explicit
// policy to the actual request. This covers Authorization-bearing requests
// from Expo web without using a wildcard origin.
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

// 3. Parse JSON bodies with size limit
app.use(express.json({ limit: '10mb' }));

// 4. Request size limiter
app.use(requestSizeLimiter(10485760)); // 10MB max body

// 5. Input sanitization (XSS, SQL injection, NoSQL injection prevention)
app.use(inputSanitizer);

// 6. Rate limiting — auth routes get stricter limits
app.use('/api/auth', authRateLimiter);
app.use('/api', apiRateLimiter);

// 7. Audit logging (fire-and-forget to Firestore auditLogs)
app.use(auditLogger);

// 8. HTTP request logging
app.use(morgan('combined'));

// ─── API caching headers ───
app.use((_req, res, next) => {
  // API responses are account-scoped and are also used to update a live UI.
  // Do not let a browser or intermediary replay an empty/outdated response.
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.removeHeader('ETag');
  next();
});

// Temporary diagnostics for the collections that feed the management
// dashboard. Enable with API_DEBUG_LOGGING=true; no request bodies or tokens
// are logged.
const debugCollectionPaths = [
  '/api/drivers',
  '/api/vehicles',
  '/api/purchase-orders',
  '/api/delivery-orders',
  '/api/vendors',
];
app.use((req, res, next) => {
  if (process.env.API_DEBUG_LOGGING !== 'true' || !debugCollectionPaths.some((path) => req.path.startsWith(path))) {
    return next();
  }
  res.on('finish', () => {
    console.info(`[API debug] ${req.method} ${req.path} -> ${res.statusCode}`, {
      cacheControl: res.getHeader('Cache-Control'),
      hasETag: Boolean(res.getHeader('ETag')),
    });
  });
  return next();
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

// snapshotStore is the single Firestore onSnapshot listener for delivery
// orders. Broadcast only a change signal; each connected client subsequently
// reloads its own authorized and role-scoped collection.
snapshotStore.subscribe('deliveryOrders', () => {
  notifySSEClients('deliveryOrders');
});

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
app.use('/api/users', usersRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/master-data', masterDataRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/issues', issuesRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin/reports', reportsRoutes);
app.use('/api/vendor/reports', vendorReportRoutes);

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

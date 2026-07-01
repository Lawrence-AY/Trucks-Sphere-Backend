// app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

// Import Firebase config (must be initialized before any routes that use it)
const { db, admin } = require('../config/firebase');

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

const app = express();

// Middleware
app.use(helmet());           // Security headers
app.use(cors());             // Enable CORS
app.use(express.json());     // Parse JSON bodies
app.use(morgan('combined')); // Logging

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

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;

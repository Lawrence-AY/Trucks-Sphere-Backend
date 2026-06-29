const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { errorHandler, notFoundHandler } = require('./middleware/errorMiddleware');
const firebaseAdmin = require('../config/firebase');
 
const app = express();

// Security
app.use(helmet());
app.use(cors());

// Logging
app.use(morgan('dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// API Routes
app.use('/api/v1', require('./modules/v1'));
if (firebaseAdmin.apps.length) {
  app.use('/api/auth', require('./modules/auth/routes'));
  app.use('/api/vendors', require('./modules/vendors/routes'));
  app.use('/api/drivers', require('./modules/drivers/routes'));
  app.use('/api/vehicles', require('./modules/vehicles/routes'));
  app.use('/api/materials', require('./modules/materials/routes'));
  app.use('/api/purchase-orders', require('./modules/purchase-orders/routes'));
  app.use('/api/delivery-orders', require('./modules/delivery-orders/routes'));
  app.use('/api/weighbridge', require('./modules/weighbridge/routes'));
  app.use('/api/quarry', require('./modules/quarry/routes'));
  app.use('/api/site', require('./modules/site/routes'));
  app.use('/api/checkpoints', require('./modules/checkpoints/routes'));
  app.use('/api/firebase', require('./modules/firebase/routes'));
} else {
  app.use('/api/legacy/*', (req, res) => {
    res.status(503).json({
      success: false,
      error: {
        code: 'FIREBASE_NOT_CONFIGURED',
        message: 'Legacy Firebase API is disabled because Firebase credentials are not configured',
        details: [],
      },
    });
  });
}

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

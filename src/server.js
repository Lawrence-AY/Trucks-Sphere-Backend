// server.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const app = require('./app');

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    app.listen(PORT, () => {
      console.log(`TruckSphere API server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      console.log(`Firebase test: http://localhost:${PORT}/api/test-firebase`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
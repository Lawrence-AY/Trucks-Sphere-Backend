const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { assertCryptoConfiguration } = require('./utils/cryptoUtils');
const app = require('./app');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';   // 👈 add this

async function startServer() {
  try {
    // Refresh-token encryption is used by authentication in every environment.
    // Fail fast here instead of accepting requests that will later fail with 500.
    assertCryptoConfiguration();
    app.listen(PORT, HOST, () => {   // 👈 use HOST
      console.log(`TruckSphere API server running on ${HOST}:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`Firebase test: http://localhost:${PORT}/api/test-firebase`);
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

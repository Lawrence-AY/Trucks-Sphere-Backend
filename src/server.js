const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { assertCryptoConfiguration } = require('./utils/cryptoUtils');
const { processDueAccountDeletions } = require('./modules/auth/accountDeletionService');
const app = require('./app');

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';   // 👈 add this

async function startServer() {
  try {
    // Refresh-token encryption is used by authentication in every environment.
    // Fail fast here instead of accepting requests that will later fail with 500.
    assertCryptoConfiguration();
    const accessBridge = require('./integrations/access-bridge/worker').startAccessBridge({
      db: require('../config/firebase').db,
      deliveries: require('./modules/delivery-orders/service'),
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      accessBridge.stop().finally(() => process.exit(0));
    });
    require('./integrations/odooSync').startOdooSync({ db: require('../config/firebase').db });
    processDueAccountDeletions().catch((error) => console.error('[Account deletion] Initial cleanup failed:', error.message));
    setInterval(() => {
      processDueAccountDeletions().catch((error) => console.error('[Account deletion] Cleanup failed:', error.message));
    }, 6 * 60 * 60 * 1000).unref();
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

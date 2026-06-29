require('dotenv').config();
const app = require('./app');
const { sequelize } = require('./database/models');
const seedCore = require('./database/seedCore');

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    if (process.env.DB_SYNC === 'true') {
      await sequelize.sync({ alter: process.env.DB_SYNC_ALTER === 'true' });
      console.log('Database synchronized');
      if (process.env.DB_SEED === 'true') {
        await seedCore();
        console.log('Core seed data ensured');
      }
    }

    app.listen(PORT, () => {
      console.log(`TruckSphere API server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      console.log(`V1 API: http://localhost:${PORT}/api/v1`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

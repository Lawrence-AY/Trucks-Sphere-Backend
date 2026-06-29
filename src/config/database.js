const { Sequelize } = require('sequelize');

const databaseUrl = process.env.DATABASE_URL;

const sequelize = databaseUrl
  ? new Sequelize(databaseUrl, {
      dialect: 'postgres',
      logging: process.env.SQL_LOGGING === 'true' ? console.log : false,
    })
  : new Sequelize(
      process.env.DB_NAME || 'trucksphere',
      process.env.DB_USER || 'postgres',
      process.env.DB_PASSWORD || 'postgres',
      {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        dialect: 'postgres',
        logging: process.env.SQL_LOGGING === 'true' ? console.log : false,
      }
    );

module.exports = sequelize;

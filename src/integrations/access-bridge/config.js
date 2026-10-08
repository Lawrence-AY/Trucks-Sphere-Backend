function readConfig(env = process.env) {
  const enabled = env.TARTIM_ENABLED === 'true';
  const config = {
    enabled,
    sourceId: env.TARTIM_SOURCE_ID || 'manual-final-test',
    apiKey: env.TARTIM_API_KEY || '',
    utcOffset: env.TARTIM_UTC_OFFSET || '+03:00',
    pollMs: Number(env.TARTIM_POLL_MS || 3000),
    driverField: env.TARTIM_DRIVER_FIELD || 'DIGER3_ISIM',
    poField: env.TARTIM_PO_FIELD || 'DIGER5_ISIM',
    sourceWeightUnit: env.TARTIM_SOURCE_WEIGHT_UNIT || '',
  };
  if (!/^[\w-]{1,80}$/.test(config.sourceId) || !Number.isInteger(config.pollMs) || config.pollMs < 1000 || config.pollMs > 60000) throw new Error('Invalid Access bridge source ID or poll interval.');
  if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(config.utcOffset)) throw new Error('Invalid TARTIM_UTC_OFFSET.');
  if (enabled && config.apiKey.length < 32) throw new Error('TARTIM_API_KEY must contain at least 32 characters.');
  if (config.sourceWeightUnit && !['kg', 'tonnes'].includes(config.sourceWeightUnit)) throw new Error('TARTIM_SOURCE_WEIGHT_UNIT must be kg or tonnes.');
  return config;
}
module.exports = { readConfig };

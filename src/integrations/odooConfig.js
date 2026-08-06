/** Odoo integration is deliberately opt-in so TruckSphere can run locally. */
function isOdooEnabled() {
  return String(process.env.ODOO_ENABLED || '').trim().toLowerCase() === 'true';
}

module.exports = { isOdooEnabled };

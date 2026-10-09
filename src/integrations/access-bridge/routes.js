const router = require('express').Router();
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireRoles } = require('../../middleware/authorizationMiddleware');
const { createHash, timingSafeEqual } = require('node:crypto');
const { db } = require('../../../config/firebase');
const { createStore } = require('./store');
const { readConfig } = require('./config');
const { status } = require('./worker');
router.post('/captures', async (req, res, next) => {
  try {
    const config = readConfig();
    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const hash = value => createHash('sha256').update(value).digest();
    if (!config.enabled || !config.apiKey || !timingSafeEqual(hash(supplied), hash(config.apiKey))) return res.status(401).json({ code: 'BRIDGE_UNAUTHORIZED' });
    const { sourceId, records, complete } = req.body || {};
    if (sourceId !== config.sourceId || !Array.isArray(records) || records.length > 100 || (complete !== undefined && typeof complete !== 'boolean')) return res.status(400).json({ code: 'INVALID_BRIDGE_BATCH' });
    if (!records.length) return res.json({ changed: 0, heartbeat: complete === true });
    console.log('[Access bridge] payload:', JSON.stringify(req.body));
    for (const record of records) console.log('[Access bridge] record:', JSON.stringify(record));
    res.json(await createStore(db, sourceId).observe(records, complete === true));
  } catch (error) {
    if (/^(INVALID_|CAPTURE_TOO_LARGE|CONFLICTING_DUPLICATE_CAPTURE)/.test(error.message)) return res.status(400).json({ code: error.message });
    next(error);
  }
});
router.use(verifyToken, requireRoles('superadmin', 'admin', 'adminlite'));
router.get('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await db.collection('accessBridgeTickets').doc(req.params.id).get();
    if (!ticket.exists) return res.status(404).json({ code: 'BRIDGE_TICKET_NOT_FOUND' });
    res.json({ ...ticket.data(), id: ticket.id });
  } catch (error) { next(error); }
});
router.get('/', async (_req, res, next) => {
  try { res.json({ ...status(), ...await createStore(db, readConfig().sourceId).logs() }); } catch (error) { next(error); }
});
module.exports = router;

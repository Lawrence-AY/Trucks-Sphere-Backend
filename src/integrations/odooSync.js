const contracts = require('./odoo-contract.json');
const { randomUUID } = require('node:crypto');

function payloadFor(slug, record, contract = contracts[slug]) {
  if (!contract || typeof record.id !== 'string' || !record.id) throw new Error('ODOO_INVALID_RECORD');
  const values = {};
  for (const field of contract.fields) {
    if (contract.preserveMissing && !Object.hasOwn(record, field.source)) continue;
    let value = record[field.source];
    if (field.type === 'date' || field.type === 'datetime') {
      if (value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error('ODOO_INVALID_DATE');
        value = field.type === 'date' ? date.toISOString().slice(0, 10) : date.toISOString().slice(0, 19).replace('T', ' ');
      }
    }
    if (field.type === 'selection' && value != null) {
      value = String(value).toLowerCase();
      if (field.selection && !field.selection.includes(value)) throw new Error('ODOO_INVALID_SELECTION');
    }
    if (value == null) { values[field.name] = false; continue; }
    if (field.encoding === 'JSON') values[field.name] = JSON.stringify(value);
    else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error('ODOO_INVALID_BOOLEAN');
      values[field.name] = value;
    } else if (field.type === 'float') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('ODOO_INVALID_NUMBER');
      values[field.name] = value;
    } else {
      if (typeof value !== 'string') throw new Error('ODOO_INVALID_TEXT');
      values[field.name] = value;
    }
  }
  values.x_name = slug === 'stocks' ? `${record.materialName || 'Material'} - ${record.jobId || record.id}` : record.name || record.companyName || record.fullName || record.registrationNumber || record.plateNumber || record.warehouseReference || record.receiptNoteId || record.id;
  return values;
}

function createClient(env = process.env, transport = fetch) {
  const url = new URL(env.ODOO_BASE_URL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('ODOO_HTTPS_REQUIRED');
  if (url.username || url.password || url.search || url.hash) throw new Error('ODOO_INVALID_URL');
  if (!env.ODOO_API_KEY) throw new Error('ODOO_API_KEY_REQUIRED');
  return async (model, method, body) => {
    const response = await transport(`${url.href.replace(/\/+$/, '')}/json/2/${model}/${method}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.ODOO_API_KEY}`, 'Content-Type': 'application/json', ...(env.ODOO_DATABASE ? { 'X-Odoo-Database': env.ODOO_DATABASE } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`ODOO_HTTP_${response.status}`);
    return response.json();
  };
}

async function validateSchema(call, mappings = contracts) {
  for (const contract of Object.values(mappings)) {
    const expected = { x_name: 'char', ...Object.fromEntries(contract.fields.map(f => [f.name, f.type])) };
    const actual = await call(contract.model, 'fields_get', { allfields: Object.keys(expected), attributes: ['type'] });
    for (const [name, type] of Object.entries(expected)) {
      if (actual[name]?.type !== type) throw new Error(`ODOO_SCHEMA_MISMATCH:${contract.model}.${name}`);
    }
  }
}

async function syncRecord(call, slug, record, contract = contracts[slug]) {
  if (slug === 'fuels' && (!String(record.fmsTransactionId || '').trim() || !(Number(record.fuelAmount) > 0) || String(record.status || '').toLowerCase() !== 'completed')) return 'skipped';
  if (slug === 'stocks' && !record.mifNumber) return 'skipped';
  const values = payloadFor(slug, record, contract);
  const model = contract.model;
  const idField = contract.fields.find(field => field.source === 'id').name;
  const matches = await call(model, 'search_read', { domain: [[idField, '=', record.id]], fields: Object.keys(values), limit: 2 });
  if (!Array.isArray(matches) || matches.length > 1) throw new Error('ODOO_DUPLICATE_SOURCE_ID');
  if (!matches.length) {
    await call(model, 'create', { vals_list: [values] });
    return 'created';
  }
  // Odoo represents unset numeric fields as zero.
  const unchanged = Object.entries(values).every(([key, value]) => matches[0][key] === value || (value === false && matches[0][key] === 0));
  if (unchanged) return 'unchanged';
  await call(model, 'write', { ids: [matches[0].id], vals: values });
  return 'updated';
}

function startOdooSync({ db, env = process.env, logger = console, call, watch = true } = {}) {
  if (env.ODOO_ENABLED !== 'true') return { stop() {} };
  let request;
  try { request = call || createClient(env); } catch { logger.error('[Odoo] Invalid server configuration; synchronization disabled.'); return { stop() {} }; }
  const owner = randomUUID();
  const live = env.ODOO_MAPPING_PROFILE === 'spadestest';
  const mappings = live ? require('./odoo-live-contract.json') : contracts;
  const sent = new Map();
  let validated = false;
  let timer;
  let dirty = false;
  const subscriptions = [];
  const lease = db.collection('integrationLocks').doc('odooSync');
  let running = false;
  let stopped = false;
  function schedule(delay = 1000) {
    if (stopped) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref?.();
  }
  async function renew() {
    return db.runTransaction(async tx => {
      const doc = await tx.get(lease);
      const current = doc.data();
      if (current && current.owner !== owner && current.expiresAt > Date.now()) return false;
      tx.set(lease, { owner, expiresAt: Date.now() + 300000 });
      return true;
    });
  }
  async function tick() {
    if (running || stopped) { dirty = !stopped; return; }
    running = true;
    dirty = false;
    let retry = false;
    try {
      if (!await renew()) { retry = true; return; }
      if (!validated) { await validateSchema(request, mappings); validated = true; }
      const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      const sources = [...Object.entries(mappings), ...(live ? [['purchaseOrders', { collection: 'purchaseOrders' }]] : [])];
      for (const [slug, contract] of sources) {
        let cursor;
        while (!stopped) {
          if (!await renew()) throw new Error('ODOO_LEASE_LOST');
          let query = db.collection(contract.collection).orderBy('__name__').limit(100);
          if (cursor) query = query.startAfter(cursor);
          const page = await query.get();
          for (const doc of page.docs) {
            if (stopped) break;
            if (!await renew()) throw new Error('ODOO_LEASE_LOST');
            try {
              const record = { ...doc.data(), id: doc.id };
              if (slug === 'fuels' && record.driverId && !record.driverCode) {
                const driver = (await db.collection('drivers').doc(record.driverId).get()).data() || {};
                record.driverCode = driver.baseDriverCode || driver.driverCode || driver.code || record.driverId;
              }
              if (live && (record.vendorId || slug === 'vendors')) {
                const vendor = slug === 'vendors' ? record : (await db.collection('vendors').doc(record.vendorId).get()).data() || {};
                record.vendorName = vendor.companyName || vendor.name || record.vendorName || '';
                record.vendorContactPerson = vendor.contactPerson || '';
              }
              const key = `${slug}:${doc.id}`;
              const fingerprint = JSON.stringify(record);
              if (sent.get(key) === fingerprint) { counts.unchanged++; continue; }
              let result;
              if (slug === 'purchaseOrders') {
                const vendorDoc = record.vendorId ? await db.collection('vendors').doc(record.vendorId).get() : null;
                const materials = await db.collection('materials').get();
                result = await require('./odooPurchaseOrders').syncPurchaseOrder(request, record, vendorDoc?.data() || {}, materials.docs.map(item => ({...item.data(),id:item.id})));
              } else {
                if (live) for (const field of contract.fields) {
                  const value = record[field.source];
                  if (value == null || field.encoding === 'JSON') continue;
                  if (['char','text'].includes(field.type) && typeof value !== 'string') record[field.source] = typeof value === 'object' ? JSON.stringify(value) : String(value);
                  if (field.type === 'float' && typeof value === 'string' && value.trim()) record[field.source] = Number(value);
                }
                result = await syncRecord(request, slug, record, { ...contract, preserveMissing: live });
              }
              counts[result]++;
              sent.set(key, fingerprint);
            } catch (error) {
              counts.failed++; retry = true;
              logger.error('[Odoo] Record export failed', { collection: contract.collection, code: String(error.message).startsWith('ODOO_') ? error.message : 'VALIDATION_OR_NETWORK_ERROR' });
            }
          }
          if (page.size < 100) break;
          cursor = page.docs[page.docs.length - 1];
        }
      }
      logger.info('[Odoo] Sync complete', counts);
      return counts;
    } catch {
      // Never log request errors: they may carry API keys or personal records.
      logger.error('[Odoo] Sync failed; check connection, permissions and installed module versions. Will retry.');
      retry = true;
    } finally {
      try {
        await db.runTransaction(async tx => {
          const doc = await tx.get(lease);
          if (doc.data()?.owner === owner) tx.delete(lease);
        });
      } catch { /* The lease expires automatically. */ }
      running = false;
      if (dirty || retry) schedule(retry ? 60000 : 1000);
    }
  }
  if (watch) {
    const snapshots = require('../utils/snapshotStore');
    for (const collection of [...Object.values(mappings).map(item => item.collection), ...(live ? ['purchaseOrders'] : [])]) {
      subscriptions.push(snapshots.subscribe(collection, change => { if (change.type !== 'removed') schedule(); }));
    }
  }
  const ready = tick();
  return { stop() { stopped = true; clearTimeout(timer); subscriptions.forEach(unsubscribe => unsubscribe()); }, tick, ready };
}

module.exports = { payloadFor, createClient, validateSchema, syncRecord, startOdooSync };

#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { normalizeName } = require('../src/utils/vendorMatching');

const CANONICAL = 'METRO CONCEPTS EAST AFRICA LIMITED';
const ALIASES = ['METRO CONCEPTS EA LTD', CANONICAL];
const collections = ['vendors', 'purchaseOrders', 'deliveryOrders', 'vehicles', 'drivers', 'stocks', 'stockMovements', 'warehouseJobs', 'accessBridgeTickets', 'users', 'vendorAliases', 'vendorUniqueKeys'];
const names = new Set(ALIASES.map(normalizeName));

function vendorName(row) { return row.companyName || row.name || row.vendorName || ''; }
function patch(value, keep, source) {
  if (!value || typeof value !== 'object' || value instanceof Date || typeof value.toDate === 'function') return value;
  if (Array.isArray(value)) return value.map(item => patch(item, keep, source));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (['raw', 'rawPayload', 'payload', 'sourceRecord', 'rawRecord', 'original', 'before', 'metadata'].includes(key)) { out[key] = item; continue; }
    if (['vendorId', 'vendorNumber', 'supplierId'].includes(key) && item === source) out[key] = keep;
    else if (key === 'vendorIds' && Array.isArray(item)) out[key] = [...new Set(item.map(id => id === source ? keep : id))].sort();
    else if (['vendorName', 'supplierName', 'companyName'].includes(key) && typeof item === 'string' && names.has(normalizeName(item))) out[key] = CANONICAL;
    else out[key] = patch(item, keep, source);
  }
  return out;
}

function plan(state) {
  const matches = (state.vendors || []).filter(row => names.has(normalizeName(vendorName(row))));
  const keeper = matches.find(row => normalizeName(vendorName(row)) === normalizeName(CANONICAL));
  const source = matches.find(row => row !== keeper && normalizeName(vendorName(row)) === normalizeName('METRO CONCEPTS EA LTD'));
  if (!keeper) throw Error(`Canonical vendor not found: ${CANONICAL}`);
  if (!source) return [];
  if (keeper.id === source.id) throw Error('Canonical and source vendor IDs are identical');
  const changes = [];
  for (const collection of collections) for (const row of state[collection] || []) {
    if (collection === 'vendors' && row.id === source.id) continue;
    let after = patch(row, keeper.id, source.id);
    if (collection === 'vendors' && row.id === keeper.id) after = { ...after, id: keeper.id, name: CANONICAL, companyName: CANONICAL, vendorName: CANONICAL, vendorId: keeper.vendorId || keeper.id, aliases: [...new Set([...(keeper.aliases || []), ...ALIASES])] };
    if (JSON.stringify(after) !== JSON.stringify(row)) changes.push({ collection, id: row.id, before: row, after });
  }
  for (const alias of ALIASES) {
    const aliasNormalized = normalizeName(alias);
    const id = createHash('sha256').update(aliasNormalized).digest('hex');
    const before = (state.vendorAliases || []).find(row => row.id === id);
    if (before && before.vendorId !== keeper.id && before.vendorId !== source.id) throw Error(`Alias belongs to another vendor: ${alias}`);
    changes.push({ collection: 'vendorAliases', id, before: before || null, after: { ...(before || {}), id, vendorId: keeper.id, alias, aliasNormalized } });
  }
  changes.push({ collection: 'vendors', id: source.id, before: source, after: null });
  return changes;
}

async function readState(db, reader) {
  const snapshots = await Promise.all(collections.map(name => reader.get(db.collection(name))));
  return Object.fromEntries(collections.map((name, index) => [name, snapshots[index].docs.map(doc => ({ ...doc.data(), id: doc.id }))]));
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: node scripts/merge-metro-concepts-vendor.js [--apply]');
  const { db, admin } = require('../config/firebase');
  try {
    if (process.env.FIREBASE_PROJECT_ID !== 'trucksphere') throw Error('Expected project trucksphere');
    const directory = path.resolve('.po-repair-backups', `metro-vendor-${Date.now()}-${randomUUID()}`);
    const changes = apply ? await db.runTransaction(async tx => {
      const state = await readState(db, tx);
      const rows = plan(state);
      if (rows.length > 490) throw Error(`Merge needs ${rows.length} writes`);
      if (rows.length) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify({ state, rows }, null, 2), { flag: 'wx' }); }
      for (const row of rows) { const ref = db.collection(row.collection).doc(row.id); row.after ? tx.set(ref, row.after) : tx.delete(ref); }
      return rows;
    }) : plan(await readState(db, { get: ref => ref.get() }));
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', canonical: CANONICAL, writes: changes.length, byCollection: changes.reduce((out, row) => (out[row.collection] = (out[row.collection] || 0) + 1, out), {}), backup: apply ? directory : null }, null, 2));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { plan };

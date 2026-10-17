const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeName } = require('../src/utils/vendorMatching');
const NAME = 'SPADES ATLAS COMPANY LIMITED';
const KEEP = 'V006';
const ALIASES = ['SPADE ATLAS COMPANY', 'SPADES ATLAS', 'SPADES ATLAS COMPANY', 'SPADES ATLAS COMPANY LTD', NAME];
const names = new Set(ALIASES.map(normalizeName));
const collections = ['vendors', 'purchaseOrders', 'deliveryOrders', 'vehicles', 'drivers', 'stocks', 'stockMovements', 'warehouseJobs', 'accessBridgeTickets', 'users', 'vendorAliases', 'vendorUniqueKeys'];
function patchRecord(value) {
  if (!value || typeof value !== 'object' || value instanceof Date || typeof value.toDate === 'function') return value;
  if (Array.isArray(value)) return value.map(patchRecord);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (['raw', 'rawPayload', 'payload', 'sourceRecord', 'rawRecord', 'original', 'before', 'metadata', 'sourceVendorName'].includes(key)) out[key] = item;
    else if (['vendorName', 'supplierName', 'companyName'].includes(key) && typeof item === 'string' && names.has(normalizeName(item))) out[key] = NAME;
    else out[key] = patchRecord(item);
  }
  return out;
}
function plan(state) {
  const vendor = (state.vendors || []).find(row => row.id === KEEP);
  if (!vendor || !names.has(normalizeName(vendor.companyName || vendor.name))) throw new Error('Unexpected vendor at V006');
  if (state.vendors.some(row => row.id !== KEEP && names.has(normalizeName(row.companyName || row.name)))) throw new Error('Another matching vendor requires an explicit merge');
  const changes = [];
  for (const collection of collections) for (const before of state[collection] || []) {
    let after = patchRecord(before);
    if (collection === 'vendors' && before.id === KEEP) after = { ...after, name: NAME, companyName: NAME, vendorName: NAME,
      companyNameNormalized: NAME.toLowerCase().replace(/[^a-z0-9]/g, ''), aliases: [...new Set([...(before.aliases || []), ...ALIASES])] };
    if (collection === 'users' && before.vendorId === KEEP && names.has(normalizeName(before.displayName))) after.displayName = NAME;
    if (collection === 'accessBridgeTickets' && before.vendorName !== after.vendorName && !before.sourceVendorName) after.sourceVendorName = before.vendorName;
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ collection, id: before.id, before, after });
  }
  for (const alias of ALIASES) {
    const aliasNormalized = normalizeName(alias);
    const id = createHash('sha256').update(aliasNormalized).digest('hex');
    const before = (state.vendorAliases || []).find(row => row.id === id);
    if (before && before.vendorId !== KEEP) throw new Error('Alias belongs to another vendor');
    if (!before && !changes.some(row => row.collection === 'vendorAliases' && row.id === id)) changes.push({ collection: 'vendorAliases', id, before: null, after: { id, vendorId: KEEP, alias, aliasNormalized } });
    const key = 'company:' + alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    const reservation = (state.vendorUniqueKeys || []).find(row => row.id === key);
    if (reservation && reservation.vendorId !== KEEP) throw new Error('Company reservation belongs to another vendor');
    if (!reservation) changes.push({ collection: 'vendorUniqueKeys', id: key, before: null, after: { id: key, key, vendorId: KEEP } });
  }
  return changes;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/canonicalize-spades-vendor.js [--apply]');
  const { db, admin } = require('../config/firebase');
  try {
    const versions = new Map();
    const snapshots = await Promise.all(collections.map(name => db.collection(name).get()));
    const state = Object.fromEntries(collections.map((name, index) => [name, snapshots[index].docs.map(doc => {
      versions.set(name + '/' + doc.id, doc.updateTime);
      return { ...doc.data(), id: doc.id };
    })]));
    const changes = plan(state);
    let backup = null;
    if (args.includes('--apply') && changes.length) {
      const directory = path.resolve('.po-repair-backups', 'spades-canonicalization');
      fs.mkdirSync(directory, { recursive: true });
      backup = path.join(directory, `${Date.now()}-${randomUUID()}.json`);
      fs.writeFileSync(backup, JSON.stringify({ project: process.env.FIREBASE_PROJECT_ID, changes }, null, 2), { flag: 'wx' });
      for (let index = 0; index < changes.length; index += 400) {
        const batch = db.batch();
        for (const row of changes.slice(index, index + 400)) {
          const ref = db.collection(row.collection).doc(row.id);
          if (!row.before) batch.create(ref, row.after);
          else {
            const updates = Object.fromEntries(Object.entries(row.after).filter(([key, value]) => JSON.stringify(row.before[key]) !== JSON.stringify(value)));
            batch.update(ref, updates, { lastUpdateTime: versions.get(row.collection + '/' + row.id) });
          }
        }
        await batch.commit();
      }
    }
    console.log(JSON.stringify({ mode: args.includes('--apply') ? 'apply' : 'dry-run', vendorId: KEEP, name: NAME, aliases: ALIASES, writes: changes.length,
      byCollection: changes.reduce((out, row) => { out[row.collection] = (out[row.collection] || 0) + 1; return out; }, {}), backup }, null, 2));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { plan, patchRecord, ALIASES, NAME };

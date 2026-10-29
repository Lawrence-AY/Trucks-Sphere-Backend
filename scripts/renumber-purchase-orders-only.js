#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const pad = value => String(value).padStart(4, '0');
const PO_RE = /^PO\d+\/V\d+$/i;
const COLLECTIONS = ['purchaseOrders', 'deliveryOrders', 'jobCounters', 'accessBridgeTickets', 'stocks', 'stockMovements', 'notifications', 'reports'];
const preserved = new Set(['jobId', 'receiptNoteId', 'originalPayload', 'payload']);

function rewrite(value, maps, field = '') {
  if (typeof value === 'string') {
    if (preserved.has(field)) return value;
    if (maps.has(value)) return maps.get(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rewrite(item, maps, field));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, maps, key)]));
  }
  return value;
}

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  if (args.some(arg => !['--apply', '--help'].includes(arg))) throw new Error('Usage: node scripts/renumber-purchase-orders-only.js [--apply]');
  if (args.includes('--help')) return console.log('PO-only renumbering; defaults to dry-run. Warehouse orders and materials are never changed.');
  const { db, admin } = require('../config/firebase');
  try {
    const snapshots = await Promise.all(COLLECTIONS.map(async name => [name, await db.collection(name).get()]));
    const state = Object.fromEntries(snapshots.map(([name, snapshot]) => [name, snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }))]));
    const orders = state.purchaseOrders.filter(row => PO_RE.test(String(row.poNumber || '')))
      .sort((a, b) => Number(String(a.poNumber).match(/\d+/)[0]) - Number(String(b.poNumber).match(/\d+/)[0]) || String(a.id).localeCompare(String(b.id)));
    const maps = new Map();
    const orderPlan = orders.map((row, index) => {
      const vendor = String(row.vendorId).replace(/^V?0*(\d+)$/i, (_, n) => `V${pad(Number(n)).slice(-3)}`);
      const next = `PO${pad(index + 1)}/${vendor}`;
      const old = String(row.poNumber);
      maps.set(old, next); maps.set(row.id, next.replace('/', '-'));
      return { from: row.id, to: next.replace('/', '-'), oldNumber: old, poNumber: next, vendorId: vendor };
    });
    const changes = [];
    for (const [collection, rows] of Object.entries(state)) {
      for (const row of rows) {
        const after = collection === 'purchaseOrders'
          ? (() => { const mapping = orderPlan.find(item => item.from === row.id); return mapping ? { ...row, ...rewrite(row, maps), id: mapping.to, poNumber: mapping.poNumber, vendorId: mapping.vendorId } : row; })()
          : rewrite(row, maps);
        const id = collection === 'purchaseOrders' && orderPlan.find(item => item.from === row.id)?.to || row.id;
        if (JSON.stringify(after) !== JSON.stringify(row) || id !== row.id) changes.push({ collection, id, before: row, after });
      }
    }
    const counters = { purchase_order_v2_counter: orders.length, purchase_order_counter: orders.length };
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', orders: orderPlan, counters, writes: changes.length, warehouseOrdersUnchanged: true, materialsUnchanged: true }, null, 2));
    if (!apply || !changes.length) return console.log('No database writes.');
    if (changes.length > 450) throw new Error(`Repair needs ${changes.length} writes; exceeds Firestore transaction limit.`);
    const revision = `po-only-${Date.now()}-${randomUUID()}`;
    const backupDir = path.resolve('.po-repair-backups', revision);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'before.json'), JSON.stringify({ state, orderPlan, counters }, null, 2), { flag: 'wx' });
    await db.runTransaction(async tx => {
      for (const change of changes) {
        const ref = db.collection(change.collection).doc(change.id);
        if (change.before.id !== change.id) tx.delete(db.collection(change.collection).doc(change.before.id));
        tx.set(ref, { ...change.after, updatedAt: new Date().toISOString() });
      }
      tx.set(db.collection('counters').doc('auto_ids'), counters, { merge: true });
    });
    console.log(`Applied ${changes.length} writes. Backup: ${backupDir}. Next PO: PO${pad(orders.length + 1)}`);
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

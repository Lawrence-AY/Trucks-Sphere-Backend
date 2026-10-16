#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildFleetIndex, fleetStats, normalizeVendorId } = require('../src/utils/vendorFleet');
function planFleet(state) {
  const index = buildFleetIndex(state.vehicles, state.deliveryOrders, state.purchaseOrders);
  const stats = fleetStats(state.vehicles, state.deliveryOrders, state.purchaseOrders, index);
  const valid = new Set(state.vendors.map(v => normalizeVendorId(v.id)));
  const changes = [];
  for (const vehicle of state.vehicles) {
    const vendorIds = [...index.get(vehicle.id)].sort();
    if (vendorIds.some(id => !valid.has(id))) throw Error(`Unknown vendor on vehicle ${vehicle.id}`);
    if (!vendorIds.length) continue;
    const patch = { vendorIds };
    if (!vehicle.vendorId && vendorIds.length === 1) patch.vendorId = vendorIds[0];
    if (Object.entries(patch).some(([key,value]) => JSON.stringify(value) !== JSON.stringify(vehicle[key]))) changes.push({ collection: 'vehicles', id: vehicle.id, patch });
  }
  for (const vendor of state.vendors) {
    const patch = stats.get(normalizeVendorId(vendor.id)) || { fleetSize: 0, truckCount: 0, tripCount: 0 };
    if (Object.entries(patch).some(([key,value]) => vendor[key] !== value)) changes.push({ collection: 'vendors', id: vendor.id, patch });
  }
  return { changes, unassigned: state.vehicles.filter(v => !index.get(v.id).size).map(v => v.id), shared: state.vehicles.filter(v => index.get(v.id).size > 1).map(v => ({ id: v.id, vendorIds: [...index.get(v.id)] })) };
}
async function readState(reader, db) {
  const names = ['vehicles', 'vendors', 'deliveryOrders', 'purchaseOrders'];
  const snapshots = await Promise.all(names.map(name => reader.get(db.collection(name))));
  return Object.fromEntries(names.map((name,i) => [name, snapshots[i].docs.map(doc => ({ ...doc.data(), id: doc.id }))]));
}
async function applyFleet(db, backup) {
  return db.runTransaction(async transaction => {
    const state = await readState(transaction, db);
    const plan = planFleet(state);
    if (plan.changes.length > 450) throw Error('Too many changes for one transaction');
    if (plan.changes.length) {
      await backup({ state, plan });
      for (const change of plan.changes) transaction.update(db.collection(change.collection).doc(change.id), change.patch);
    }
    return plan;
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw Error('Usage: node scripts/repair-vendor-fleet.js [--apply]');
  require('dotenv').config();
  const { db, admin } = require('../config/firebase');
  try {
    if (process.env.FIREBASE_PROJECT_ID !== 'trucksphere') throw Error('Expected project trucksphere');
    console.log(`Project trucksphere; database ${db.databaseId || '(default)'}; ${args.includes('--apply') ? 'APPLY' : 'DRY RUN'}`);
    let plan;
    if (args.includes('--apply')) {
      const directory = path.resolve('.po-repair-backups', `vendor-fleet-${Date.now()}-${randomUUID()}`);
      plan = await applyFleet(db, async originals => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, `before-${randomUUID()}.json`), JSON.stringify(originals, null, 2), { flag: 'wx' });
      });
      console.log(`Backups: ${directory}`);
    } else plan = planFleet(await readState({ get: ref => ref.get() }, db));
    console.log(JSON.stringify(plan, null, 2));
    const state = await readState({ get: ref => ref.get() }, db);
    console.log(JSON.stringify({ vehicles: state.vehicles.length, trips: state.deliveryOrders.length, tripVendorMismatches: state.deliveryOrders.filter(trip => { const po = state.purchaseOrders.find(po => po.id === trip.purchaseOrderId || (trip.poNumber && trip.poNumber === po.poNumber)); return po && normalizeVendorId(po.vendorId) !== normalizeVendorId(trip.vendorId); }).length, remainingWrites: planFleet(state).changes.length }));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { planFleet, applyFleet };

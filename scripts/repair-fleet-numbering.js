const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planNumbering } = require('./lib/repairFleetNumbering');
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply'].includes(arg))) throw Error('Usage: node scripts/repair-fleet-numbering.js [--apply]');
  const { db, admin } = require('../config/firebase');
  try {
    if (process.env.FIREBASE_PROJECT_ID !== 'trucksphere') throw Error('Expected project trucksphere');
    const refs = (await db.listCollections()).filter(ref => ref.id !== 'accessBridgeSources');
    for (const source of (await db.collection('accessBridgeSources').get()).docs) {
      refs.push(source.ref.collection('snapshots'), source.ref.collection('events'));
    }
    const read = async reader => {
      const snapshots = await Promise.all(refs.map(ref => reader.get(ref)));
      return Object.fromEntries(refs.map((ref,i) => [ref.path, snapshots[i].docs.map(doc => ({ ...doc.data(), id: doc.id }))]));
    };
    const state = await read({ get: ref => ref.get() });
    const plan = planNumbering(state);
    console.log(JSON.stringify({ project: 'trucksphere', mode: args.includes('--apply') ? 'apply' : 'dry-run', writes: plan.changes.reduce((n,row) => n + (row.from === row.id ? 1 : 2),0),
      mappings: plan.mappings, issues: plan.issues, collections: Object.fromEntries(refs.map(ref => [ref.path,plan.changes.filter(row => row.collection === ref.path).length])) }, null, 2));
    if (!args.includes('--apply') || !plan.changes.length) return;
    if (plan.changes.reduce((n,row) => n + (row.from === row.id ? 1 : 2),0) > 450) throw Error('Repair exceeds one atomic transaction');
    for (const change of plan.changes.filter(row => row.from !== row.id)) {
      if ((await db.collection(change.collection).doc(change.from).listCollections()).length) throw Error('Subcollections require explicit migration: ' + change.collection + '/' + change.from);
    }
    const directory = path.resolve('.po-repair-backups', 'fleet-numbering-' + Date.now() + '-' + randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory,'before.json'), JSON.stringify({ state,plan }, null,2), { flag: 'wx' });
    console.log('Backup: ' + directory);
    await db.runTransaction(async transaction => {
      const current = await read(transaction);
      const fresh = planNumbering(current);
      const shape = value => JSON.stringify({ mappings: value.mappings, targets: value.changes.map(row => [row.collection,row.from,row.id]) });
      if (shape(fresh) !== shape(plan)) throw Error('Numbering plan changed since review; rerun repair');
      fs.writeFileSync(path.join(directory,'transaction-' + randomUUID() + '.json'), JSON.stringify({ state: current, plan: fresh },null,2), { flag:'wx' });
      const targets = fresh.changes.filter(row => row.from !== row.id);
      const probes = await Promise.all(targets.map(row => transaction.get(db.collection(row.collection).doc(row.id))));
      if (probes.some(doc => doc.exists)) throw Error('Target exists');
      for (const change of fresh.changes) {
        transaction.set(db.collection(change.collection).doc(change.id),change.after);
        if (change.from !== change.id) transaction.delete(db.collection(change.collection).doc(change.from));
      }
    });
    const final = await read({ get: ref => ref.get() });
    const remaining = planNumbering(final);
    console.log(JSON.stringify({ remainingWrites: remaining.changes.length, drivers: final.drivers.length, trucks: final.vehicles.length, trips: final.deliveryOrders.length, issues: remaining.issues }));
    if (remaining.changes.length) throw Error('Repair verification failed');
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

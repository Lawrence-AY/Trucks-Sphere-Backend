#!/usr/bin/env node
// Importing this file does not initialize Firebase or perform a migration.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readState, planRepairs, pairChanges, applyBatch, repairCounter, planMergedDeletions, deleteMergedBatch } = require('./lib/repairBridgePurchaseOrders');
function parseArgs(args) {
  const options = { apply: false, backupDir: '.po-repair-backups' };
  const values = { '--env-file': 'envFile', '--project': 'project', '--vendor': 'vendor', '--material': 'material', '--keep-po': 'keepPO', '--backup-dir': 'backupDir' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--delete-merged') options.deleteMerged = true;
    else if (args[i] === '--cleanup-only') { options.cleanupOnly = true; options.deleteMerged = true; }
    else if (args[i] === '--counters-only') options.countersOnly = true;
    else if (args[i] === '--dry-run') options.apply = false;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else if (values[args[i]]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing value for ${args[i]}`);
      options[values[args[i]]] = args[++i];
    } else throw Error(`Unknown option: ${args[i]}`);
  }
  return options;
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(`Repair trip-created duplicate Access Bridge purchase orders (dry-run by default).

node scripts/repair-access-bridge-pos.js [options]
  --env-file <path>       Load .env.env or another dotenv file (default: .env)
  --vendor <ID or name>   Limit duplicate groups to this vendor
  --material <ID/name>   Limit duplicate groups to this material
  --keep-po <ID/number>  Explicit open PO to retain; other groups are skipped
  --apply                Apply repairs to the configured Firebase project
  --project <ID>         Optional check against the configured project
  --counters-only        Repair global PO counters without merging orders
  --delete-merged        Delete merged duplicates after checking references
  --cleanup-only         Delete already-merged duplicates; do not merge new POs
  --backup-dir <path>    Before-images and plans (default: .po-repair-backups)
  --dry-run              Show changes without database writes

Pause bridge workers and backend writes while applying. Only bridge-created
zero-quantity duplicates are archived. Trips, receipts and issued numbers remain.
Counters advance past issued numbers; they are never reduced.`);
    return;
  }
  require('dotenv').config({ path: path.resolve(options.envFile || '.env'), override: !!options.envFile });
  const configured = process.env.FIREBASE_PROJECT_ID;
  if (!configured) throw Error('FIREBASE_PROJECT_ID is required in the selected environment file.');
  if (options.project && options.project !== configured) throw Error(`Project mismatch: requested ${options.project}, configured ${configured}.`);
  const { db, admin } = require('../config/firebase');
  try {
    console.log(`Project: ${configured}; database: ${db.databaseId || '(default)'}; mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
    const { state } = await readState({ get: ref => ref.get() }, db);
    const plan = options.countersOnly || options.cleanupOnly ? { pairs: [], skipped: [], counter: require('./lib/repairBridgePurchaseOrders').counterRepair(state) } : planRepairs(state, options);
    const ready = [];
    for (const pair of plan.pairs) {
      try {
        const changes = pairChanges(state, pair, new Date().toISOString());
        const jobCounter = changes.find(change => change.collection === 'jobCounters');
        pair.plannedWrites = changes.length;
        pair.retainedTripCounter = jobCounter?.patch.nextJobNumber;
        ready.push(pair);
      }
      catch (error) { plan.skipped.push({ ids: [pair.sourceId], reason: error.message }); }
    }
    plan.pairs = ready;
    if (options.deleteMerged && !options.countersOnly) plan.deletions = planMergedDeletions(state, options);
    console.log(JSON.stringify(plan, null, 2));
    if (!options.apply) { console.log('Dry run complete. No database writes.'); return; }
    const directory = path.resolve(options.backupDir, `${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify({ project: configured, plan }, null, 2), { flag: 'wx' });
    const backup = async changes => {
      fs.writeFileSync(path.join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ project: configured,
        at: new Date().toISOString(), changes }, null, 2), { flag: 'wx' });
    };
    console.log(`Backups: ${directory}`);
    // Repair counters before the potentially long-running merge loop.
    const counterWrites = await repairCounter(db, backup);
    const savedCounters = (await db.collection('counters').doc('auto_ids').get()).data() || {};
    console.log(`counters/auto_ids: ${counterWrites ? 'repaired' : 'already correct'}; purchase_order_v2_counter=${savedCounters.purchase_order_v2_counter ?? 0}; purchase_order_counter=${savedCounters.purchase_order_counter ?? 0}; next PO=PO${String(Number(savedCounters.purchase_order_v2_counter || 0) + 1).padStart(4, '0')}`);
    const batches = [];
    let batch = [], estimatedWrites = 0;
    for (const pair of plan.pairs) {
      if (batch.length && (batch[0].keepId !== pair.keepId || estimatedWrites + pair.plannedWrites > 400)) {
        batches.push(batch); batch = []; estimatedWrites = 0;
      }
      batch.push(pair); estimatedWrites += pair.plannedWrites;
    }
    if (batch.length) batches.push(batch);
    let completed = 0;
    for (const items of batches) {
      const count = await applyBatch(db, items, backup);
      completed += items.length;
      console.log(`${completed}/${plan.pairs.length} duplicate POs processed; keeper=${items[0].keepId}; ${count} documents updated atomically`);
    }
    if (options.deleteMerged && !options.countersOnly) {
      const freshState = (await readState({ get: ref => ref.get() }, db)).state;
      const deletions = planMergedDeletions(freshState, options);
      console.log(`Deletion phase: ${deletions.pairs.length} fully merged duplicates; ${deletions.skipped.length} blocked.`);
      for (let i = 0; i < deletions.pairs.length; i += 100) {
        const items = deletions.pairs.slice(i, i + 100);
        await deleteMergedBatch(db, items, backup);
        console.log(`Deleted ${Math.min(i + 100, deletions.pairs.length)}/${deletions.pairs.length} merged duplicate POs; redirects retained in purchaseOrderMerges.`);
      }
      if (deletions.skipped.length) console.log(JSON.stringify(deletions.skipped, null, 2));
      await repairCounter(db, backup);
    }
    console.log(`Repair complete. ${plan.skipped.length} skipped items; see plan.`);
  } finally {
    await Promise.all(admin.apps.map(app => app.delete()));
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, main };

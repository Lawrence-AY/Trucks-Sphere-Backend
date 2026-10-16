#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readNumbering, buildNumbering, applyNumbering } = require('./lib/renumberOrdersMaterials');
async function main(args = process.argv.slice(2)) {
  let apply = false, project;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--project' && args[i + 1]) project = args[++i];
    else if (args[i] === '--help') { console.log('node scripts/renumber-pos-materials.js [--apply] [--project ID]\nDefaults to dry run. Compacts current PO/material IDs and counters; preserves issued trip/receipt IDs.'); return; }
    else throw Error(`Unknown option: ${args[i]}`);
  }
  const { db, admin } = require('../config/firebase');
  try {
    if (project && project !== process.env.FIREBASE_PROJECT_ID) throw Error('Firebase project mismatch.');
    console.log(`Project: ${process.env.FIREBASE_PROJECT_ID}; database: ${db.databaseId || '(default)'}; ${apply ? 'APPLY' : 'DRY RUN'}`);
    const revision = `compact-${Date.now()}-${randomUUID()}`;
    const { state } = await readNumbering({ get: ref => ref.get() }, db);
    const preview = buildNumbering(state, revision, new Date().toISOString());
    console.log(JSON.stringify({ ...preview.plan, writes: preview.changes.length }, null, 2));
    if (!apply) { console.log('No database writes.'); return; }
    const directory = path.resolve('.po-repair-backups', revision);
    fs.mkdirSync(directory, { recursive: true });
    const result = await applyNumbering(db, revision, async data => fs.writeFileSync(path.join(directory, `before-${randomUUID()}.json`),
      JSON.stringify({ project: process.env.FIREBASE_PROJECT_ID, ...data }, null, 2), { flag: 'wx' }));
    console.log(`Renumbering complete: ${result.writes} writes. Next PO: PO${String(result.plan.counters.purchase_order_v2_counter + 1).padStart(4, '0')}; next material: MAT${String(result.plan.counters.material_counter + 1).padStart(3, '0')}. Backups: ${directory}`);
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

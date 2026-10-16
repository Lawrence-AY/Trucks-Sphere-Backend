#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { planMaterials, buildMaterialChanges, readMaterialState, applyMaterials } = require('./lib/repairMaterials');
async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--help') options.help = true;
    else if (['--project', '--env-file'].includes(args[i]) && args[i + 1]) options[args[i++].slice(2)] = args[i];
    else throw Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (options.help) { console.log('node scripts/repair-material-duplicates.js [--apply] [--project ID] [--env-file PATH]\nDefaults to dry run. Merges compatible typo materials, updates references and stock IDs, keeps aliases, backs up all writes.'); return; }
  const env = require('dotenv').config({ path: path.resolve(options['env-file'] || '.env'), override: !!options['env-file'] });
  if (options['env-file'] && env.error) throw env.error;
  if (!process.env.FIREBASE_PROJECT_ID) throw Error('FIREBASE_PROJECT_ID is required.');
  if (options.project && options.project !== process.env.FIREBASE_PROJECT_ID) throw Error('Firebase project mismatch.');
  const { db, admin } = require('../config/firebase');
  try {
    console.log(`Project: ${process.env.FIREBASE_PROJECT_ID}; database: ${db.databaseId || '(default)'}; ${options.apply ? 'APPLY' : 'DRY RUN'}`);
    const { state } = await readMaterialState({ get: ref => ref.get() }, db);
    const plan = planMaterials(state);
    const changes = buildMaterialChanges(state, plan, new Date().toISOString());
    console.log(JSON.stringify({ groups: plan, writes: changes.length, affected: changes.map(c => `${c.collection}/${c.id}`) }, null, 2));
    if (!options.apply) { console.log('No database writes.'); return; }
    const directory = path.resolve('.po-repair-backups', `materials-${Date.now()}-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify({ project: process.env.FIREBASE_PROJECT_ID, plan }, null, 2), { flag: 'wx' });
    const count = await applyMaterials(db, plan, async originals => fs.writeFileSync(path.join(directory, `before-${randomUUID()}.json`), JSON.stringify(originals, null, 2), { flag: 'wx' }));
    console.log(`Material repair complete: ${count} writes. Backups: ${directory}`);
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };

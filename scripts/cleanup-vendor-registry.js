// Safe vendor cleanup. Dry-run by default; --apply archives unused registry
// vendors and migrates SALSHI only when V008 has no references.
const fs = require('node:fs');
const path = require('node:path');
const { db, admin } = require('../config/firebase');

const KEEP_IDS = new Set(['V001', 'V002', 'V003', 'V004', 'V005', 'V006', 'V007']);
const SALSHI_OLD = 'V110';
const SALSHI_NEW = 'V008';
const COLLECTIONS = ['purchaseOrders', 'deliveryOrders', 'accessBridgeTickets', 'drivers', 'vehicles', 'users', 'notifications', 'reports', 'auditLogs'];

function containsVendor(value, id) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => containsVendor(item, id));
  return Object.entries(value).some(([key, item]) =>
    (['vendorId', 'vendorNumber', 'entityId'].includes(key) && String(item) === id) || containsVendor(item, id));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirm = process.argv.includes('--confirm-salshi-migration');
  const vendorSnap = await db.collection('vendors').get();
  const vendors = new Map(vendorSnap.docs.map(doc => [doc.id, { id: doc.id, ...doc.data() }]));
  const refs = new Map([...vendors.keys()].map(id => [id, []]));
  const records = [];
  for (const collection of COLLECTIONS) {
    const snap = await db.collection(collection).get();
    for (const doc of snap.docs) records.push({ collection, doc, data: doc.data() });
  }
  for (const { collection, doc, data } of records) for (const id of refs.keys()) if (containsVendor(data, id)) refs.get(id).push(`${collection}/${doc.id}`);

  const registryOnly = [...vendors.values()].filter(v => v.registrySource === 'VENDORE.xlsx' && !KEEP_IDS.has(v.id) && v.id !== SALSHI_OLD);
  const archive = registryOnly.filter(v => (refs.get(v.id) || []).length === 0);
  const blocked = registryOnly.filter(v => (refs.get(v.id) || []).length > 0);
  const v008Refs = refs.get(SALSHI_NEW) || [];
  const salshiRefs = refs.get(SALSHI_OLD) || [];
  const canMigrateSalshi = vendors.has(SALSHI_OLD) && !v008Refs.length;
  const plan = { archive: archive.map(v => ({ id: v.id, name: v.companyName || v.name })), blocked, salshi: { from: SALSHI_OLD, to: SALSHI_NEW, oldReferences: salshiRefs.length, newReferences: v008Refs.length, canMigrate: canMigrateSalshi } };

  if (apply) {
    if (blocked.length) throw new Error(`Cannot archive referenced registry vendors: ${blocked.map(v => v.id).join(', ')}`);
    if (confirm && !canMigrateSalshi) throw new Error('SALSHI migration is unsafe: V008 is occupied/referenced or V110 is missing.');
    const backupDir = path.resolve('.vendor-cleanup-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, JSON.stringify({ vendors: [...vendors.values()], references: Object.fromEntries(refs) }, null, 2), { flag: 'wx' });
    let batch = db.batch(); let writes = 0;
    for (const vendor of archive) { batch.set(db.collection('vendors').doc(vendor.id), { status: 'inactive', hiddenFromDirectory: true, archivedAt: new Date().toISOString(), archivedReason: 'Unused Excel reference vendor' }, { merge: true }); if (++writes === 400) { await batch.commit(); batch = db.batch(); writes = 0; } }
    if (confirm && canMigrateSalshi) {
      const old = vendors.get(SALSHI_OLD); const migrated = { ...old, id: SALSHI_NEW, vendorId: SALSHI_NEW, companyName: old.companyName || old.name, name: old.name || old.companyName, migratedFrom: SALSHI_OLD, migratedAt: new Date().toISOString() };
      batch.set(db.collection('vendors').doc(SALSHI_NEW), migrated);
      for (const { collection, doc, data } of records) if (containsVendor(data, SALSHI_OLD)) {
        const replace = value => Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (['vendorId', 'vendorNumber', 'entityId'].includes(k) && String(v) === SALSHI_OLD) ? SALSHI_NEW : replace(v)])) : value;
        batch.set(db.collection(collection).doc(doc.id), replace(data), { merge: false });
      }
      batch.delete(db.collection('vendors').doc(SALSHI_OLD));
    }
    if (writes || (confirm && canMigrateSalshi)) await batch.commit();
    plan.applied = true; plan.backup = backup;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', vendors: vendors.size, plan }, null, 2));
  await Promise.all(admin.apps.map(app => app.delete()));
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

// Recon: list all top-level Firestore collections + doc counts, and flag AB-* references.
const { db } = require('../config/firebase');

async function main() {
  const collections = await db.listCollections();
  const names = collections.map(c => c.id).sort();
  console.log('Collections (' + names.length + '):');
  for (const name of names) {
    let count = 0;
    try { count = (await db.collection(name).count().get()).data().count; } catch (_) {}
    console.log(`  ${name}: ${count}`);
  }
  console.log('\n--- scanning for AB-* references outside the 5 known collections ---');
  const known = new Set(['vendors', 'drivers', 'vehicles', 'purchaseOrders', 'deliveryOrders']);
  for (const name of names) {
    if (known.has(name)) continue;
    try {
      const snap = await db.collection(name).limit(500).get();
      for (const d of snap.docs) {
        const s = JSON.stringify(d.data());
        if (s.includes('AB-')) {
          console.log(`  [${name}/${d.id}] contains AB-*`);
        }
      }
    } catch (_) {}
  }
  console.log('\n--- deliveryOrders: fields present (union across sample) ---');
  const dos = await db.collection('deliveryOrders').limit(50).get();
  const fields = new Set();
  for (const d of dos.docs) Object.keys(d.data()).forEach(k => fields.add(k));
  console.log('  ' + [...fields].sort().join(', '));
  console.log('\n--- receiptNotes / other collections referencing jobId ---');
  for (const name of ['receiptNotes', 'warehouseJobs', 'stocks', 'auditLogs']) {
    if (!names.includes(name)) continue;
    const snap = await db.collection(name).limit(20).get();
    console.log(`  ${name} sample ids:`, snap.docs.slice(0, 5).map(d => d.id).join(', '));
  }
  process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

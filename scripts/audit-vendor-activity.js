// Read-only vendor activity audit. Never writes or deletes Firestore data.
const { db, admin } = require('../config/firebase');

const CUTOFF = Date.parse('2026-10-17T00:00:00Z');
const collections = ['purchaseOrders', 'deliveryOrders', 'accessBridgeTickets', 'drivers', 'vehicles', 'users', 'notifications', 'reports', 'auditLogs'];
const dateValue = record => ['createdAt', 'updatedAt', 'recordedAt', 'capturedAt', 'weighInAt', 'weighOutAt', 'siteWeighInAt', 'siteWeighOutAt', 'date'].map(key => Date.parse(String(record[key] || ''))).find(Number.isFinite) || 0;
const vendorValues = record => [...new Set([record.vendorId, record.vendorNumber, record.entityId, record.vendor?.id, record.vendor?.vendorId].filter(Boolean).map(String))];

async function main() {
  try {
    const vendorSnap = await db.collection('vendors').get();
    const snapshots = await Promise.all(collections.map(async name => [name, await db.collection(name).get()]));
    const rows = new Map(vendorSnap.docs.map(doc => [doc.id, { vendorId: doc.id, name: doc.data().companyName || doc.data().name || '', collections: {}, total: 0 }]));
    for (const [collection, snapshot] of snapshots) for (const doc of snapshot.docs) {
      const record = doc.data();
      if (dateValue(record) < CUTOFF) continue;
      for (const vendorId of vendorValues(record)) {
        if (!rows.has(vendorId)) continue;
        const row = rows.get(vendorId);
        row.collections[collection] = (row.collections[collection] || 0) + 1;
        row.total++;
      }
    }
    const report = [...rows.values()].map(row => ({ ...row, decision: row.total ? 'KEEP_ACTIVE' : 'REVIEW_OR_ARCHIVE' })).sort((a, b) => b.total - a.total || a.vendorId.localeCompare(b.vendorId));
    console.log(JSON.stringify({ cutoff: '2026-10-17T00:00:00Z', vendors: report.length, active: report.filter(row => row.total).length, reviewOrArchive: report.filter(row => !row.total).length, report }, null, 2));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

// Concise summary of naming state in production Firestore (read-only).
const { db } = require('../config/firebase');

const collections = ['vendors', 'drivers', 'vehicles', 'purchaseOrders', 'deliveryOrders', 'sites', 'materials'];

function maxNum(ids, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  let m = 0;
  for (const id of ids) {
    const match = String(id).match(re);
    if (match) m = Math.max(m, parseInt(match[1], 10));
  }
  return m;
}

async function main() {
  console.log('FIREBASE_PROJECT_ID =', process.env.FIREBASE_PROJECT_ID);
  const data = {};
  for (const name of collections) {
    const snap = await db.collection(name).get();
    data[name] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  for (const name of ['vendors', 'drivers', 'vehicles', 'purchaseOrders', 'sites', 'materials']) {
    const docs = data[name];
    const ids = docs.map(d => d.id);
    const ab = ids.filter(id => String(id).startsWith('AB-'));
    const nonAb = ids.filter(id => !String(id).startsWith('AB-')).sort();
    console.log(`\n=== ${name}: total=${docs.length} ab=${ab.length} ===`);
    console.log('  non-AB ids:', JSON.stringify(nonAb));
    if (name === 'vendors') console.log('  max V#:', maxNum(ids, 'V'));
    if (name === 'drivers') console.log('  max D#:', maxNum(ids, 'D'));
    if (name === 'vehicles') console.log('  max T#:', maxNum(ids, 'T'));
    if (name === 'purchaseOrders') {
      console.log('  max PO#:', maxNum(ids.map(i => String(i).split('-')[0]), 'PO'));
      console.log('  poNumber samples:', JSON.stringify(docs.filter(d => !String(d.id).startsWith('AB-')).slice(0, 10).map(d => ({ id: d.id, poNumber: d.poNumber, vendorId: d.vendorId }))));
    }
  }
  // deliveryOrders summary
  const dos = data['deliveryOrders'];
  const abJob = dos.filter(d => String(d.jobId || '').includes('AB-'));
  const nonAbJob = dos.filter(d => !String(d.jobId || '').includes('AB-'));
  console.log(`\n=== deliveryOrders: total=${dos.length} jobIdContainsAB=${abJob.length} ===`);
  console.log('  non-AB jobId samples:', JSON.stringify(nonAbJob.slice(0, 8).map(d => ({ id: d.id, jobId: d.jobId }))));
  console.log('  AB jobId samples:', JSON.stringify(abJob.slice(0, 8).map(d => ({ id: d.id, jobId: d.jobId, purchaseOrderId: d.purchaseOrderId, vendorId: d.vendorId, driverId: d.driverId, vehicleId: d.vehicleId }))));
  // sites / materials AB counts
  for (const name of ['sites', 'materials']) {
    const ab = data[name].filter(d => String(d.id).startsWith('AB-'));
    console.log(`\n${name} AB sample:`, JSON.stringify(ab.slice(0, 6).map(d => ({ id: d.id, name: d.name, bridgeCreated: d.bridgeCreated }))));
  }
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

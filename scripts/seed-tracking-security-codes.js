/* Seeds named security-code locations. Run with: npm run seed-tracking-security */
require('dotenv').config();
const { admin, db } = require('../config/firebase');

const CODES = [
  { id: 'TSG01', name: 'Main Gate Security', location: 'Main Gate', securityCode: 'TSG01', phone: '' },
  { id: 'TSG02', name: 'Weighbridge Security', location: 'Weighbridge', securityCode: 'TSG02', phone: '' },
  { id: 'TSG03', name: 'Site Gate Security', location: 'Site Gate', securityCode: 'TSG03', phone: '' },
];

async function run() {
  const createdAt = new Date().toISOString();
  await Promise.all(CODES.map((record) => db.collection('securityCodes').doc(record.id).set({
    ...record, isActive: true, createdAt, createdBy: 'seed-tracking-security-codes',
  }, { merge: true })));
  console.log(`Seeded ${CODES.length} tracking security codes.`);
  await admin.app().delete();
}
run().catch(async (error) => { console.error(error); await admin.app().delete().catch(() => {}); process.exitCode = 1; });

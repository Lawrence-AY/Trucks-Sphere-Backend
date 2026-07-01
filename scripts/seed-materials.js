/**
 * Seed Script — Material Master Catalog
 * Replaces all existing materials with the 7-item standard catalog.
 * Also initializes counters for auto-numbering.
 *
 * Usage: node scripts/seed-materials.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { db } = require('../config/firebase');
const { resetAllCounters } = require('../src/utils/counterService');

const MASTER_MATERIALS = [
  { id: 'MAT001', name: 'Murram (Clay Gravel)', description: 'Clay gravel material for road base and fill', unit: 'tons', category: 'aggregate', active: true },
  { id: 'MAT002', name: 'Fine Aggregate for Concrete 0-2mm', description: 'Fine aggregate (sand) for concrete mixing, 0-2mm', unit: 'tons', category: 'aggregate', active: true },
  { id: 'MAT003', name: 'Graded crushed Aggregate for Concrete 6-10mm', description: 'Medium graded crushed aggregate for concrete, 6-10mm', unit: 'tons', category: 'aggregate', active: true },
  { id: 'MAT004', name: 'Graded crushed Aggregate for Concrete 14-20mm', description: 'Coarse graded crushed aggregate for concrete, 14-20mm', unit: 'tons', category: 'aggregate', active: true },
  { id: 'MAT005', name: 'Aggregate Coarse Base (Graded Crushed Aggregate)', description: 'Coarse base aggregate for road construction', unit: 'tons', category: 'aggregate', active: true },
  { id: 'MAT006', name: 'Cement', description: 'Portland cement', unit: 'bags', category: 'binder', active: true },
  { id: 'MAT007', name: 'Rebar', description: 'Steel reinforcement bars', unit: 'tons', category: 'steel', active: true },
];

async function seedMaterials() {
  console.log('[Seed] Deleting existing materials...');
  const existingSnapshot = await db.collection('materials').get();
  const batch = db.batch();
  existingSnapshot.forEach(doc => batch.delete(doc.ref));
  if (existingSnapshot.size > 0) await batch.commit();
  console.log(`[Seed] Deleted ${existingSnapshot.size} existing materials`);

  console.log('[Seed] Inserting 7 master materials...');
  const writeBatch = db.batch();
  for (const mat of MASTER_MATERIALS) {
    const ref = db.collection('materials').doc(mat.id);
    writeBatch.set(ref, { ...mat, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  await writeBatch.commit();
  console.log('[Seed] Master materials seeded successfully.');

  await resetAllCounters();
  console.log('[Seed] All auto-increment counters reset to 0.');

  const verifySnapshot = await db.collection('materials').orderBy('id').get();
  console.log('\nMaterials catalog:');
  verifySnapshot.forEach(doc => console.log(`  ${doc.data().id} — ${doc.data().name} (${doc.data().unit})`));
  console.log('\nDone. Seed complete.');
}

seedMaterials().then(() => process.exit(0)).catch(err => { console.error('Seed failed:', err); process.exit(1); });
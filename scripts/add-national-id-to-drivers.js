/**
 * TruckSphere — Add National ID to Existing Drivers
 *
 * This script iterates over all drivers in the Firestore 'drivers' collection
 * and adds a `nationalId` field if one is missing.
 *
 * For drivers that already have a license number, it uses that as the nationalId.
 * Otherwise, it generates a placeholder Kenya-style national ID.
 *
 * Usage:
 *   node scripts/add-national-id-to-drivers.js
 *
 * Options:
 *   --dry-run    Preview changes without writing to Firestore
 *   --reset      Re-generate national IDs for ALL drivers (even those with one)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { db } = require('../config/firebase');

// ─── National ID Generation ──────────────────────────────────────────
// Kenya national ID format: 8 digits (e.g., 12345678)
function generateKenyanNationalId(index) {
  // Generate a deterministic 8-digit ID based on index
  const base = 30000000 + (index * 13 + 7) % 70000000;
  return String(base).padStart(8, '0');
}

function deriveNationalId(driver, index) {
  // If driver already has a nationalId, keep it (unless --reset)
  if (driver.nationalId && !process.argv.includes('--reset')) {
    return driver.nationalId;
  }

  // Use license number if it looks like a valid ID (8+ digits)
  if (driver.licenseNumber) {
    const digits = driver.licenseNumber.replace(/\D/g, '');
    if (digits.length >= 8) {
      return digits.slice(0, 8);
    }
    // If license has some digits but not 8, pad to 8
    if (digits.length > 0) {
      return digits.padStart(8, '0');
    }
  }

  // Generate a deterministic national ID from the index
  return generateKenyanNationalId(index);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const isReset = process.argv.includes('--reset');

  console.log('═══════════════════════════════════════════════');
  console.log('  TruckSphere — Add National ID to Drivers');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log(`  Mode: ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE (will write to Firestore)'}`);
  if (isReset) console.log('  Reset: Will re-generate for ALL drivers');
  console.log('');

  // Fetch all drivers
  const driversSnapshot = await db.collection('drivers').get();
  const drivers = [];

  driversSnapshot.forEach((doc) => {
    drivers.push({ docId: doc.id, ...doc.data() });
  });

  console.log(`  📋 Found ${drivers.length} drivers in Firestore`);
  console.log('');

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i];
    const nationalId = deriveNationalId(driver, i);

    // Check if update is needed
    if (driver.nationalId === nationalId) {
      console.log(`  ⏭️  SKIP: ${driver.name || driver.docId} — already has nationalId: ${nationalId}`);
      skipped++;
      continue;
    }

    console.log(`  ${isDryRun ? '🔍 [DRY RUN]' : '✏️ '} UPDATE: ${driver.name || driver.docId}`);
    console.log(`     License: ${driver.licenseNumber || 'N/A'}`);
    console.log(`     Old nationalId: ${driver.nationalId || '(none)'}`);
    console.log(`     New nationalId: ${nationalId}`);

    if (!isDryRun) {
      try {
        await db.collection('drivers').doc(driver.docId).update({
          nationalId,
          updatedAt: new Date().toISOString(),
        });
        updated++;
        console.log(`     ✅ Written to Firestore`);
      } catch (err) {
        console.error(`     ❌ Error: ${err.message}`);
        errors++;
      }
    } else {
      updated++;
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  📊 Summary');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total drivers:     ${drivers.length}`);
  console.log(`  Would update:      ${updated}`);
  console.log(`  Already correct:   ${skipped}`);
  if (errors > 0) console.log(`  Errors:            ${errors}`);
  console.log('');

  if (isDryRun) {
    console.log('  🔍 DRY RUN complete. No changes were written.');
    console.log('     Run without --dry-run to apply changes.');
  } else {
    console.log('  🎉 National IDs added successfully!');
  }
  console.log('');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
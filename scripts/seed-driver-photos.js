/**
 * Seed Driver Photos
 *
 * Uploads actual driver profile images from the local Drivers/ folder
 * to Firebase Storage and updates each driver's photoURL in Firestore.
 *
 * Image → Driver mapping:
 *   d_v1_1.jpeg → d1 (David Mwangi)
 *   d_v2_1.jpeg → d3 (James Ochieng)
 *   d_v2_2.jpeg → d4 (Grace Akinyi)
 *   d_v2_3.jpeg → d2 (Sarah Wanjiku)
 *
 * Usage: node scripts/seed-driver-photos.js
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../config/firebase');
const { uploadFile } = require('../src/utils/cloudStorage');

const DRIVERS_DIR = path.resolve(__dirname, '../../Drivers');

const MAPPING = [
  { file: 'd_v1_1.jpeg', driverId: 'd1', name: 'David Mwangi' },
  { file: 'd_v2_1.jpeg', driverId: 'd3', name: 'James Ochieng' },
  { file: 'd_v2_2.jpeg', driverId: 'd4', name: 'Grace Akinyi' },
  { file: 'd_v2_3.jpeg', driverId: 'd2', name: 'Sarah Wanjiku' },
];

async function seedDriverPhotos() {
  console.log('📸 Seeding driver profile photos from local Drivers/ folder...\n');

  for (const { file, driverId, name } of MAPPING) {
    const filePath = path.join(DRIVERS_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️  ${file} — file not found at ${filePath}, skipping`);
      continue;
    }

    try {
      // Check if driver exists in Firestore
      const driverDoc = await db.collection('drivers').doc(driverId).get();
      if (!driverDoc.exists) {
        console.log(`  ⚠️  ${driverId} (${name}) — not found in Firestore, skipping`);
        continue;
      }

      // Read file from disk
      const buffer = fs.readFileSync(filePath);

      // Upload to Firebase Storage
      const { url } = await uploadFile(buffer, file, 'driver', driverId);

      // Update Firestore
      await db.collection('drivers').doc(driverId).update({
        photoURL: url,
        updatedAt: new Date().toISOString(),
      });

      console.log(`  ✅ ${driverId} (${name}) ← ${file}`);
      console.log(`     ${url}`);
    } catch (error) {
      console.error(`  ❌ ${driverId} (${name}) — ${error.message}`);
    }
  }

  console.log('\n🎉 Driver photos seeded!');
  console.log('📂 Check: https://console.firebase.google.com/project/trucksphere/storage/trucksphere.firebasestorage.app/files');
  process.exit(0);
}

seedDriverPhotos();
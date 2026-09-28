/**
 * Set vendor counter to 6 so the next vendor ID will be v007.
 * Run: node scripts/set-vendor-counter-v6.js
 */
const { db } = require('../config/firebase');

(async () => {
  try {
    const counterRef = db.collection('counters').doc('auto_ids');
    await counterRef.set({ vendor_counter: 6 }, { merge: true });
    console.log('[Counter] Vendor counter set to 6. Next vendor will be v007.');
    process.exit(0);
  } catch (err) {
    console.error('[Counter] Failed to set vendor counter:', err.message);
    process.exit(1);
  }
})();
/**
 * TruckSphere — Compliance & Insurance Data Seeder
 *
 * Populates existing drivers and vendors with compliance, insurance,
 * and regulatory fields.
 *
 * DRIVERS get:
 *   - nationalId (if missing)
 *   - Wiba Policy Provider + Start/End dates (Worker Injury Benefit Act)
 *   - Insurance Supplier Name + Start Date
 *   - Insurance Company + Commencing/Expiring Date + Insurance Number
 *   - NTSA Inspection Expiry Date
 *
 * VENDORS get:
 *   - Company Act / CR12
 *   - KRA PIN
 *   - Business Permit
 *   - Tax Compliance
 *
 * Usage:
 *   node scripts/seed-compliance.js
 *   node scripts/seed-compliance.js --dry-run
 *
 * Also available via npm:
 *   npm run seed-compliance
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { db } = require('../config/firebase');

// ─── Sample Data ───────────────────────────────────────────────────
const WIBA_PROVIDERS = [
  'Jubilee Insurance (WIBA)',
  'APA Insurance (WIBA)',
  'CIC General Insurance (WIBA)',
  'Britam General Insurance (WIBA)',
  'Old Mutual General (WIBA)',
  'Kenya Orient Insurance (WIBA)',
];

const INSURANCE_COMPANIES = [
  'Jubilee Insurance Co. Ltd',
  'APA Insurance Ltd',
  'CIC General Insurance Ltd',
  'Britam General Insurance Ltd',
  'Old Mutual General Insurance',
  'Kenya Orient Insurance Ltd',
  'GA Insurance Ltd',
  'UAP Old Mutual Insurance',
];

const INSURANCE_SUPPLIERS = [
  'First Assurance Agency',
  'AON Minet Insurance Brokers',
  'Resolution Insurance Brokers',
  'Pioneer Insurance Brokers',
  'Heritage Insurance Brokers',
  'Pacific Insurance Brokers',
];

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Generate a Kenya-style national ID (8 digits).
 */
function generateNationalId(index) {
  const base = 30000000 + ((index * 13 + 7) % 70000000);
  return String(base).padStart(8, '0');
}

/**
 * Derive nationalId from driver data, or generate one.
 */
function deriveNationalId(driver, index) {
  if (driver.nationalId) return driver.nationalId;
  if (driver.licenseNumber) {
    const digits = driver.licenseNumber.replace(/\D/g, '');
    if (digits.length >= 8) return digits.slice(0, 8);
    if (digits.length > 0) return digits.padStart(8, '0');
  }
  return generateNationalId(index);
}

/**
 * Format a date as ISO string.
 * @param {number} yearOffset - offset from current year (e.g., -1 = last year)
 * @param {number} monthOffset - offset in months
 */
function isoDate(yearOffset, monthOffset, day) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + yearOffset);
  if (monthOffset) d.setMonth(d.getMonth() + monthOffset);
  if (day) d.setDate(day);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

// ─── Driver Compliance Builder ─────────────────────────────────────
function buildDriverCompliance(driver, index) {
  const providerIdx = index % WIBA_PROVIDERS.length;
  const insuranceIdx = index % INSURANCE_COMPANIES.length;
  const supplierIdx = index % INSURANCE_SUPPLIERS.length;

  // WIBA policy: starts between 2023-2025, valid 1 year
  const wibaStartYear = 2023 + (index % 3);
  const wibaStart = `${wibaStartYear}-01-15`;
  const wibaEnd = `${wibaStartYear + 1}-01-14`;

  // Insurance policy
  const insStartYear = 2024 + (index % 2);
  const insStart = `${insStartYear}-06-01`;
  const insEnd = `${insStartYear + 1}-05-31`;
  const insCommencing = `${insStartYear}-05-28`;

  // NTSA inspection: every 6 months
  const ntsaMonth = (index % 2 === 0) ? '06-30' : '12-31';
  const ntsaYear = 2025 + Math.floor(index / 6);
  const ntsaExpiry = `${ntsaYear}-${ntsaMonth}`;

  return {
    nationalId: deriveNationalId(driver, index),

    // WIBA (Worker Injury Benefit Act)
    wibaProvider: WIBA_PROVIDERS[providerIdx],
    wibaStartDate: wibaStart,
    wibaEndDate: wibaEnd,

    // Insurance
    insuranceSupplier: INSURANCE_SUPPLIERS[supplierIdx],
    insuranceStartDate: insStart,
    insuranceCompany: INSURANCE_COMPANIES[insuranceIdx],
    insuranceCommencingDate: insCommencing,
    insuranceExpiryDate: insEnd,
    insuranceNumber: `POL/${insStartYear}/${String(1000 + index * 27).padStart(6, '0')}`,

    // NTSA
    ntsaInspectionExpiry: ntsaExpiry,
  };
}

// ─── Vendor Compliance Builder ─────────────────────────────────────
function buildVendorCompliance(vendor, index) {
  // Company Act / CR12 number
  const cr12 = `CPR/${2018 + (index % 6)}/${String(5000 + index * 41).padStart(5, '0')}`;

  // KRA PIN (Kenya-style: A followed by 9 digits)
  const kraPin = `A${String(100000000 + index * 73).padStart(9, '0')}Z`;

  // Business Permit
  const permitYear = 2025 + (index % 2);
  const businessPermit = `BP-${permitYear}-${String(300 + index * 17).padStart(6, '0')}`;

  // Tax Compliance
  const taxYear = 2025 + (index % 2);
  const taxCompliance = `TC-${taxYear}-${String(800 + index * 13).padStart(6, '0')}`;

  return {
    companyActCR12: cr12,
    kraPin,
    businessPermit,
    taxCompliance,
  };
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════════');
  console.log('  TruckSphere — Compliance & Insurance Seeder');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log(`  Mode: ${isDryRun ? 'DRY RUN (no writes)' : 'LIVE (will write to Firestore)'}`);
  console.log('');

  const now = new Date().toISOString();

  // ── DRIVERS ────────────────────────────────────────────────────
  console.log('───────────────────────────────────────────────');
  console.log('  👨‍✈️  DRIVERS');
  console.log('───────────────────────────────────────────────');
  console.log('');

  const driversSnapshot = await db.collection('drivers').get();
  const drivers = [];
  driversSnapshot.forEach((doc) => drivers.push({ docId: doc.id, ...doc.data() }));
  console.log(`  📋 Found ${drivers.length} drivers`);
  console.log('');

  let driverUpdated = 0;
  let driverSkipped = 0;
  let driverErrors = 0;

  for (let i = 0; i < drivers.length; i++) {
    const driver = drivers[i];
    const compliance = buildDriverCompliance(driver, i);

    // Check which fields are actually needed
    const existingNat = driver.nationalId || '';
    const needsUpdate =
      compliance.nationalId !== existingNat ||
      !driver.wibaProvider ||
      !driver.insuranceCompany ||
      !driver.ntsaInspectionExpiry;

    if (!needsUpdate) {
      console.log(`  ⏭️  SKIP: ${driver.name || driver.docId} — all compliance fields present`);
      driverSkipped++;
      continue;
    }

    console.log(`  ${isDryRun ? '🔍 [DRY RUN]' : '✏️ '} ${driver.name || driver.docId}`);
    console.log(`     nationalId:      ${compliance.nationalId}`);
    console.log(`     WIBA Provider:    ${compliance.wibaProvider} (${compliance.wibaStartDate} → ${compliance.wibaEndDate})`);
    console.log(`     Insurance Supplier: ${compliance.insuranceSupplier} (from ${compliance.insuranceStartDate})`);
    console.log(`     Insurance Co:     ${compliance.insuranceCompany}`);
    console.log(`     Insurance #:      ${compliance.insuranceNumber} (${compliance.insuranceCommencingDate} → ${compliance.insuranceExpiryDate})`);
    console.log(`     NTSA Expiry:      ${compliance.ntsaInspectionExpiry}`);

    if (!isDryRun) {
      try {
        await db.collection('drivers').doc(driver.docId).update({
          ...compliance,
          updatedAt: now,
        });
        driverUpdated++;
        console.log(`     ✅ Written to Firestore`);
      } catch (err) {
        console.error(`     ❌ Error: ${err.message}`);
        driverErrors++;
      }
    } else {
      driverUpdated++;
    }
    console.log('');
  }

  // ── VENDORS ────────────────────────────────────────────────────
  console.log('───────────────────────────────────────────────');
  console.log('  🏢 VENDORS');
  console.log('───────────────────────────────────────────────');
  console.log('');

  const vendorsSnapshot = await db.collection('vendors').get();
  const vendors = [];
  vendorsSnapshot.forEach((doc) => vendors.push({ docId: doc.id, ...doc.data() }));
  console.log(`  📋 Found ${vendors.length} vendors`);
  console.log('');

  let vendorUpdated = 0;
  let vendorSkipped = 0;
  let vendorErrors = 0;

  for (let i = 0; i < vendors.length; i++) {
    const vendor = vendors[i];
    const compliance = buildVendorCompliance(vendor, i);

    const needsUpdate =
      !vendor.companyActCR12 ||
      !vendor.kraPin ||
      !vendor.businessPermit ||
      !vendor.taxCompliance;

    if (!needsUpdate) {
      console.log(`  ⏭️  SKIP: ${vendor.name || vendor.docId} — all compliance fields present`);
      vendorSkipped++;
      continue;
    }

    console.log(`  ${isDryRun ? '🔍 [DRY RUN]' : '✏️ '} ${vendor.name || vendor.docId}`);
    console.log(`     Company Act/CR12: ${compliance.companyActCR12}`);
    console.log(`     KRA PIN:          ${compliance.kraPin}`);
    console.log(`     Business Permit:   ${compliance.businessPermit}`);
    console.log(`     Tax Compliance:    ${compliance.taxCompliance}`);

    if (!isDryRun) {
      try {
        await db.collection('vendors').doc(vendor.docId).update({
          ...compliance,
          updatedAt: now,
        });
        vendorUpdated++;
        console.log(`     ✅ Written to Firestore`);
      } catch (err) {
        console.error(`     ❌ Error: ${err.message}`);
        vendorErrors++;
      }
    } else {
      vendorUpdated++;
    }
    console.log('');
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════');
  console.log('  📊 SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log(`  Drivers: ${driverUpdated + driverSkipped} total | ${driverUpdated} would-update | ${driverSkipped} skipped | ${driverErrors} errors`);
  console.log(`  Vendors: ${vendorUpdated + vendorSkipped} total | ${vendorUpdated} would-update | ${vendorSkipped} skipped | ${vendorErrors} errors`);
  console.log('');

  const total = driverErrors + vendorErrors;

  if (isDryRun) {
    console.log('  🔍 DRY RUN complete. No changes were written.');
    console.log('     Run without --dry-run to apply changes.');
  } else {
    console.log('  🎉 Compliance data seeded successfully!');
  }
  console.log('');

  process.exit(total > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
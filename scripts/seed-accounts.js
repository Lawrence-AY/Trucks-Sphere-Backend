/**
 * TruckSphere — Comprehensive Account & Sample Data Seed Script
 *
 * Seeds Firebase Auth users AND Firestore documents for:
 *   - Management (admin)
 *   - 6 Vendors (each with 3 drivers + 3 trucks = 18 drivers, 18 trucks)
 *   - Quarries (3)
 *   - Sites (4)
 *   - Materials (the 7-item standard catalog)
 *
 * Usage:
 *   node scripts/seed-accounts.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { db, auth } = require('../config/firebase');

// ============================================================
// MATERIALS — exactly the 7 materials specified
// ============================================================
const MATERIALS = [
  { id: 'MAT001', name: 'Murram (Clay Gravel)',             description: 'Clay gravel material for road base and fill',                       unit: 'tons', category: 'aggregate' },
  { id: 'MAT002', name: 'Fine Aggregate for Concrete 0-2mm', description: 'Fine aggregate (sand) for concrete mixing, 0-2mm',               unit: 'tons', category: 'aggregate' },
  { id: 'MAT003', name: 'Graded crushed Aggregate for Concrete 6-10mm',  description: 'Medium graded crushed aggregate for concrete, 6-10mm',   unit: 'tons', category: 'aggregate' },
  { id: 'MAT004', name: 'Graded crushed Aggregate for Concrete 14-20mm', description: 'Coarse graded crushed aggregate for concrete, 14-20mm',  unit: 'tons', category: 'aggregate' },
  { id: 'MAT005', name: 'Aggregate Coarse Base (Graded Crushed Aggregate)', description: 'Coarse base aggregate for road construction',         unit: 'tons', category: 'aggregate' },
  { id: 'MAT006', name: 'Cement',                           description: 'Portland cement (50kg bags)',                                      unit: 'bags', category: 'binder'    },
  { id: 'MAT007', name: 'Rebar',                            description: 'Steel reinforcement bars',                                         unit: 'tons', category: 'steel'     },
];

// ============================================================
// QUARRIES
// ============================================================
const QUARRIES = [
  { id: 'q1', name: 'Mombasa Road Quarry',     contact: '+254700111001', status: 'active', email: 'quarry1@truck.com', location: { address: 'Mombasa Road, Machakos',    latitude: -1.4567, longitude: 36.9782 } },
  { id: 'q2', name: 'Kisumu Aggregate Quarry', contact: '+254700111002', status: 'active', email: 'quarry2@truck.com', location: { address: 'Kisumu Industrial Area',     latitude: -0.0917, longitude: 34.7680 } },
  { id: 'q3', name: 'Ngong Stone Quarry',       contact: '+254700111003', status: 'active', email: 'quarry3@truck.com', location: { address: 'Ngong Road, Kajiado',       latitude: -1.3965, longitude: 36.7456 } },
];

// ============================================================
// SITES  (construction sites where materials are delivered)
// ============================================================
const SITES = [
  { id: 's1', name: 'Site 1', contact: '+254711001001', status: 'active', email: 'site@truck.com', location: { address: 'Ruiru, Kiambu', latitude: -1.1556, longitude: 36.8956 } },
];

// ============================================================
// 6 VENDORS — each vendor gets 3 drivers + 3 trucks
// ============================================================
const VENDORS = [
  { id: 'v1', name: 'Mwangi Heavy Transport Ltd',  phone: '+254712001001', email: 'info@mwangiheavy.co.ke',    address: 'Nairobi Industrial Area',  active: true },
  { id: 'v2', name: 'Kamau & Sons Trucking',        phone: '+254712001002', email: 'info@kamausons.co.ke',      address: 'Mombasa Road, Nairobi',    active: true },
  { id: 'v3', name: 'Ochieng Logistics Ltd',        phone: '+254712001003', email: 'info@ochienglogistics.co.ke',address: 'Kisumu Industrial Park',  active: true },
  { id: 'v4', name: 'Njoroge Hauliers Ltd',         phone: '+254712001004', email: 'info@njorogehauliers.co.ke',address: 'Thika Road, Nairobi',     active: true },
  { id: 'v5', name: 'Wanjiku Transport Services',   phone: '+254712001005', email: 'info@wanjikutransport.co.ke',address: 'Nakuru Highway',         active: true },
  { id: 'v6', name: 'Kiprop Fleet Services',        phone: '+254712001006', email: 'info@kipropfleet.co.ke',     address: 'Eldoret Road, Nakuru',     active: true },
];

// Driver & truck names per vendor (3 each)
const DRIVER_NAMES = [
  // v1 drivers
  [ { name: 'David Mwangi',  phone: '+254721000101', license: 'DL-2020-00101' },
    { name: 'Sarah Wanjiku', phone: '+254721000102', license: 'DL-2020-00102' },
    { name: 'Peter Kamau',   phone: '+254721000103', license: 'DL-2020-00103' } ],
  // v2 drivers
  [ { name: 'James Ochieng', phone: '+254721000201', license: 'DL-2020-00201' },
    { name: 'Grace Akinyi',  phone: '+254721000202', license: 'DL-2020-00202' },
    { name: 'Boniface Ouma', phone: '+254721000203', license: 'DL-2020-00203' } ],
  // v3 drivers
  [ { name: 'John Kiprop',   phone: '+254721000301', license: 'DL-2020-00301' },
    { name: 'Mary Njoroge',  phone: '+254721000302', license: 'DL-2020-00302' },
    { name: 'Esther Chebet', phone: '+254721000303', license: 'DL-2020-00303' } ],
  // v4 drivers
  [ { name: 'Samuel Maina',  phone: '+254721000401', license: 'DL-2020-00401' },
    { name: 'Faith Wambui',  phone: '+254721000402', license: 'DL-2020-00402' },
    { name: 'Daniel Gichuki',phone: '+254721000403', license: 'DL-2020-00403' } ],
  // v5 drivers
  [ { name: 'Anne Nyambura', phone: '+254721000501', license: 'DL-2021-00501' },
    { name: 'George Otieno', phone: '+254721000502', license: 'DL-2021-00502' },
    { name: 'Jane Muthoni',  phone: '+254721000503', license: 'DL-2021-00503' } ],
  // v6 drivers
  [ { name: 'Paul Kiplagat', phone: '+254721000601', license: 'DL-2021-00601' },
    { name: 'Lucy Chepkoech',phone: '+254721000602', license: 'DL-2021-00602' },
    { name: 'Hillary Kemboi',phone: '+254721000603', license: 'DL-2021-00603' } ],
];

const TRUCK_PLATES = [
  // v1 trucks
  [ 'KCA 101A', 'KCA 102B', 'KCA 103C' ],
  // v2 trucks
  [ 'KCB 201D', 'KCB 202E', 'KCB 203F' ],
  // v3 trucks
  [ 'KCC 301G', 'KCC 302H', 'KCC 303J' ],
  // v4 trucks
  [ 'KCD 401K', 'KCD 402L', 'KCD 403M' ],
  // v5 trucks
  [ 'KCE 501N', 'KCE 502P', 'KCE 503Q' ],
  // v6 trucks
  [ 'KCF 601R', 'KCF 602S', 'KCF 603T' ],
];

// ============================================================
// AUTH USERS  (Firebase Authentication + Firestore users doc)
// ============================================================
const AUTH_USERS = [
  // --- management / admin ---
  { email: 'admin@truck.com',      password: '123456', displayName: 'James Admin',       role: 'management',       firestoreId: 'u_admin' },
  { email: 'manager2@truck.com',   password: '123456', displayName: 'Christine Manager', role: 'management',       firestoreId: 'u_manager2' },

  // --- quarry operators (one per quarry) ---
  { email: 'quarry1@truck.com',    password: '123456', displayName: 'Paul Op Quarry1',   role: 'operator_quarry',  firestoreId: 'u_qop1', quarryId: 'q1' },
  { email: 'quarry2@truck.com',    password: '123456', displayName: 'Ruth Op Quarry2',   role: 'operator_quarry',  firestoreId: 'u_qop2', quarryId: 'q2' },
  { email: 'quarry3@truck.com',    password: '123456', displayName: 'Ben Op Quarry3',    role: 'operator_quarry',  firestoreId: 'u_qop3', quarryId: 'q3' },

  // --- site operator ---
  { email: 'site@truck.com',       password: '123456', displayName: 'Anna Site Op',      role: 'operator_site',    firestoreId: 'u_sop1',  siteId: 's1' },

  // --- fuel operator ---
  { email: 'fuel@truck.com',       password: '123456', displayName: 'Mike Fuel Operator', role: 'operator_fuel',  firestoreId: 'u_fuel'  },

  // --- vendor accounts (one per vendor) ---
  { email: 'vendor1@truck.com',    password: '123456', displayName: 'Vendor Mwangi',     role: 'vendor',          firestoreId: 'u_v1',    vendorId: 'v1' },
  { email: 'vendor2@truck.com',    password: '123456', displayName: 'Vendor Kamau',      role: 'vendor',          firestoreId: 'u_v2',    vendorId: 'v2' },
  { email: 'vendor3@truck.com',    password: '123456', displayName: 'Vendor Ochieng',    role: 'vendor',          firestoreId: 'u_v3',    vendorId: 'v3' },
  { email: 'vendor4@truck.com',    password: '123456', displayName: 'Vendor Njoroge',    role: 'vendor',          firestoreId: 'u_v4',    vendorId: 'v4' },
  { email: 'vendor5@truck.com',    password: '123456', displayName: 'Vendor Wanjiku',    role: 'vendor',          firestoreId: 'u_v5',    vendorId: 'v5' },
  { email: 'vendor6@truck.com',    password: '123456', displayName: 'Vendor Kiprop',     role: 'vendor',          firestoreId: 'u_v6',    vendorId: 'v6' },
];

// ============================================================
// HELPERS
// ============================================================
const now = new Date().toISOString();

function buildDriver(vi, di) {
  const v = VENDORS[vi];
  const d = DRIVER_NAMES[vi][di];
  const id = `d_${v.id}_${di + 1}`;
  return {
    id,
    vendorId: v.id,
    name: d.name,
    phone: d.phone,
    email: `${d.name.toLowerCase().replace(/\s+/g, '.')}@truck.com`,
    licenseNumber: d.license,
    licenseExpiry: '2027-12-31',
    status: 'active',
    assignedTruckId: `t_${v.id}_${di + 1}`,
    photoURL: '',
    totalTrips: 0,
    rating: 5.0,
    createdAt: now,
  };
}

function buildTruck(vi, ti) {
  const v = VENDORS[vi];
  const id = `t_${v.id}_${ti + 1}`;
  const makes = ['Volvo', 'Mercedes-Benz', 'MAN', 'Scania', 'Isuzu', 'Hino'];
  const models = ['FH 460', 'Actros 3348', 'TGX 26.480', 'R 500', 'FVR 900', '500 Series'];
  const colors = ['White', 'Blue', 'Red', 'Silver', 'Yellow', 'Green'];
  return {
    id,
    vendorId: v.id,
    plateNumber: TRUCK_PLATES[vi][ti],
    make: makes[vi],
    model: models[vi],
    year: 2023 + ti,
    color: colors[vi],
    capacity: 38 + (ti * 2),
    status: 'active',
    assignedDriverId: `d_${v.id}_${ti + 1}`,
    insuranceExpiry: '2027-06-30',
    lastInspection: now,
    createdAt: now,
  };
}

// ============================================================
// SEED FIREBASE AUTH USERS
// ============================================================
async function seedAuthUsers() {
  console.log('\n🔐 Seeding Firebase Auth users...\n');
  const uidMap = {}; // email -> uid

  for (const u of AUTH_USERS) {
    try {
      const userRecord = await auth.createUser({
        email: u.email,
        password: u.password,
        displayName: u.displayName,
        emailVerified: true,
      });
      await auth.setCustomUserClaims(userRecord.uid, { role: u.role });
      uidMap[u.email] = userRecord.uid;
      console.log(`  ✅ Created Auth: ${u.email}  (${u.role})  uid: ${userRecord.uid}`);
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        const existing = await auth.getUserByEmail(u.email);
        await auth.updateUser(existing.uid, { password: u.password, displayName: u.displayName, emailVerified: true });
        await auth.setCustomUserClaims(existing.uid, { role: u.role });
        uidMap[u.email] = existing.uid;
        console.log(`  🔄 Updated Auth: ${u.email}  (${u.role})  uid: ${existing.uid}`);
      } else {
        console.error(`  ❌ Auth failed for ${u.email}: ${err.message}`);
      }
    }
  }
  return uidMap;
}

// ============================================================
// SEED FIRESTORE COLLECTIONS
// ============================================================
async function seedFirestore(uidMap) {
  console.log('\n🗄️  Seeding Firestore collections...\n');

  // ---------- users collection ----------
  const userBatch = db.batch();
  for (const u of AUTH_USERS) {
    const doc = {
      id: u.firestoreId,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      authUid: uidMap[u.email] || '',
      phone: '+254700000000',
      createdAt: now,
      updatedAt: now,
    };
    if (u.quarryId) doc.quarryId = u.quarryId;
    if (u.siteId) doc.siteId = u.siteId;
    if (u.vendorId) doc.vendorId = u.vendorId;
    userBatch.set(db.collection('users').doc(u.firestoreId), doc);
  }
  await userBatch.commit();
  console.log(`  ✅ users: ${AUTH_USERS.length} documents`);

  // ---------- materials ----------
  const matBatch = db.batch();
  for (const m of MATERIALS) {
    matBatch.set(db.collection('materials').doc(m.id), { ...m, active: true, createdAt: now, updatedAt: now });
  }
  await matBatch.commit();
  console.log(`  ✅ materials: ${MATERIALS.length} documents`);

  // ---------- quarries ----------
  const quarryBatch = db.batch();
  for (const q of QUARRIES) {
    quarryBatch.set(db.collection('quarries').doc(q.id), { ...q, createdAt: now, updatedAt: now });
  }
  await quarryBatch.commit();
  console.log(`  ✅ quarries: ${QUARRIES.length} documents`);

  // ---------- sites ----------
  const siteBatch = db.batch();
  for (const s of SITES) {
    siteBatch.set(db.collection('sites').doc(s.id), { ...s, createdAt: now, updatedAt: now });
  }
  await siteBatch.commit();
  console.log(`  ✅ sites: ${SITES.length} documents`);

  // ---------- vendors ----------
  const vendorBatch = db.batch();
  for (const v of VENDORS) {
    vendorBatch.set(db.collection('vendors').doc(v.id), { ...v, fleetSize: 3, status: 'active', createdAt: now, updatedAt: now });
  }
  await vendorBatch.commit();
  console.log(`  ✅ vendors: ${VENDORS.length} documents`);

  // ---------- drivers ----------
  let driverCount = 0;
  const driverBatch = db.batch();
  for (let vi = 0; vi < VENDORS.length; vi++) {
    for (let di = 0; di < 3; di++) {
      const d = buildDriver(vi, di);
      driverBatch.set(db.collection('drivers').doc(d.id), d);
      driverCount++;
    }
  }
  await driverBatch.commit();
  console.log(`  ✅ drivers: ${driverCount} documents (3 per vendor)`);

  // ---------- vehicles ----------
  let truckCount = 0;
  const truckBatch = db.batch();
  for (let vi = 0; vi < VENDORS.length; vi++) {
    for (let ti = 0; ti < 3; ti++) {
      const t = buildTruck(vi, ti);
      truckBatch.set(db.collection('vehicles').doc(t.id), t);
      truckCount++;
    }
  }
  await truckBatch.commit();
  console.log(`  ✅ vehicles: ${truckCount} documents (3 per vendor)`);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  TruckSphere — Account & Sample Data Seeder');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('  📦 Vendors:     6  (each with 3 drivers + 3 trucks)');
  console.log('  🚛 Trucks:      18');
  console.log('  👨‍✈️  Drivers:     18');
  console.log('  ⛰️  Quarries:    3');
  console.log('  🏗️  Sites:       1');
  console.log('  🧱 Materials:   7');
  console.log('  👤 Auth users:  13  (2 admin, 3 quarry ops, 1 site op, 1 fuel op, 6 vendors)');
  console.log('');

  const uidMap = await seedAuthUsers();
  await seedFirestore(uidMap);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  🎉 Seeding complete!');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('  📋 LOGIN CREDENTIALS');
  console.log('     Password for all accounts:  123456');
  console.log('     Username:  type the short name (e.g. "admin")');
  console.log('               or the full email (e.g. "admin@truck.com")');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  MANAGEMENT (admin):');
  console.log('    Username: admin        Email: admin@truck.com');
  console.log('    Username: manager2     Email: manager2@truck.com');
  console.log('  QUARRY OPERATORS:');
  console.log('    Username: quarry1      Email: quarry1@truck.com    (Mombasa Road Quarry)');
  console.log('    Username: quarry2      Email: quarry2@truck.com    (Kisumu Aggregate Quarry)');
  console.log('    Username: quarry3      Email: quarry3@truck.com    (Ngong Stone Quarry)');
  console.log('  SITE OPERATOR:');
  console.log('    Username: site         Email: site@truck.com      (Site 1)');
  console.log('  FUEL OPERATOR:');
  console.log('    Username: fuel         Email: fuel@truck.com');
  console.log('  VENDORS:');
  console.log('    Username: vendor1      Email: vendor1@truck.com    (Mwangi Heavy Transport Ltd)');
  console.log('    Username: vendor2      Email: vendor2@truck.com    (Kamau & Sons Trucking)');
  console.log('    Username: vendor3      Email: vendor3@truck.com    (Ochieng Logistics Ltd)');
  console.log('    Username: vendor4      Email: vendor4@truck.com    (Njoroge Hauliers Ltd)');
  console.log('    Username: vendor5      Email: vendor5@truck.com    (Wanjiku Transport Services)');
  console.log('    Username: vendor6      Email: vendor6@truck.com    (Kiprop Fleet Services)');
  console.log('');

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
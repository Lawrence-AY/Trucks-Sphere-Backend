// Migrate bridge-created "AB-*" records to the app's canonical naming:
//   vendor V###, driver D###, truck T###, PO PO####/V###, job PO####/V###/D###/T###/J####
// Read-only by default (dry-run). Run with --apply to write.
const { db } = require('../config/firebase');

const APPLY = process.argv.includes('--apply');

const pad = (n, w) => String(n).padStart(w, '0');
const isAB = v => String(v ?? '').includes('AB-');

async function loadAll(name) {
  const snap = await db.collection(name).get();
  const docs = [];
  snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
  return docs;
}

function maxNum(ids, prefix) {
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  let m = 0;
  for (const id of ids) if (re.test(String(id))) m = Math.max(m, parseInt(String(id).match(re)[1], 10));
  return m;
}

function vendorShort(id) {
  const match = String(id ?? '').trim().match(/^[Vv]?(\\d+)$/);
  return match ? `V${pad(parseInt(match[1], 10), 3)}` : String(id ?? '');
}

async function main() {
  console.log(`MODE: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (read-only)'}`);
  console.log('FIREBASE_PROJECT_ID =', process.env.FIREBASE_PROJECT_ID);

  const [vendors, drivers, vehicles, orders, deliveryOrders, stocks, vehRegs] = await Promise.all([
    loadAll('vendors'), loadAll('drivers'), loadAll('vehicles'), loadAll('purchaseOrders'),
    loadAll('deliveryOrders'), loadAll('stocks'), loadAll('vehicleRegistrations'),
  ]);

  // ---- Build rename maps (deterministic: sort AB-* by id) ----
  const abVendors = vendors.filter(v => isAB(v.id)).sort((a, b) => a.id.localeCompare(b.id));
  const abDrivers = drivers.filter(d => isAB(d.id)).sort((a, b) => a.id.localeCompare(b.id));
  const abVehicles = vehicles.filter(v => isAB(v.id)).sort((a, b) => a.id.localeCompare(b.id));
  const abOrders = orders.filter(o => isAB(o.id)).sort((a, b) => a.id.localeCompare(b.id));

  let vn = maxNum(vendors.map(v => v.id), 'V');
  let dn = maxNum(drivers.map(d => d.id), 'D');
  let tn = maxNum(vehicles.map(v => v.id), 'T');
  let pn = maxNum(orders.map(o => String(o.id).split('-')[0]), 'PO');

  const vendorMap = new Map();
  for (const v of abVendors) vendorMap.set(v.id, `V${pad(++vn, 3)}`);
  const driverMap = new Map();
  for (const d of abDrivers) driverMap.set(d.id, `D${pad(++dn, 3)}`);
  const truckMap = new Map();
  for (const t of abVehicles) truckMap.set(t.id, `T${pad(++tn, 3)}`);

  // PO map depends on vendor map (PO's vendorId must resolve first).
  const poMap = new Map(); // old PO id -> { id, poNumber }
  for (const o of abOrders) {
    const newVendor = vendorMap.get(o.vendorId) || o.vendorId;
    const poNumber = `PO${pad(++pn, 4)}/${vendorShort(newVendor)}`;
    poMap.set(o.id, { id: poNumber.replace(/\//g, '-'), poNumber });
  }

  const ops = { sets: [], deletes: [] }; // sets: [{ref, data}], deletes: [ref]
  const summary = { vendors: 0, drivers: 0, trucks: 0, pos: 0, deliveryOrders: 0, stocks: 0, vehRegs: 0, jobCounters: 0 };
  const anomalies = [];

  // ---- Vendors ----
  for (const v of abVendors) {
    ops.sets.push({ ref: db.collection('vendors').doc(vendorMap.get(v.id)), data: { ...v, id: vendorMap.get(v.id) } });
    ops.deletes.push(db.collection('vendors').doc(v.id));
    summary.vendors++;
  }
  // ---- Drivers ----
  for (const d of abDrivers) {
    const data = { ...d, id: driverMap.get(d.id), vendorId: vendorMap.get(d.vendorId) || d.vendorId };
    ops.sets.push({ ref: db.collection('drivers').doc(driverMap.get(d.id)), data });
    ops.deletes.push(db.collection('drivers').doc(d.id));
    summary.drivers++;
  }
  // ---- Vehicles ----
  for (const t of abVehicles) {
    const data = { ...t, id: truckMap.get(t.id), vendorId: vendorMap.get(t.vendorId) || t.vendorId };
    ops.sets.push({ ref: db.collection('vehicles').doc(truckMap.get(t.id)), data });
    ops.deletes.push(db.collection('vehicles').doc(t.id));
    summary.trucks++;
  }
  // ---- Purchase orders ----
  for (const o of abOrders) {
    const np = poMap.get(o.id);
    const data = { ...o, id: np.id, poNumber: np.poNumber, vendorId: vendorMap.get(o.vendorId) || o.vendorId };
    ops.sets.push({ ref: db.collection('purchaseOrders').doc(np.id), data });
    ops.deletes.push(db.collection('purchaseOrders').doc(o.id));
    summary.pos++;
  }

  // ---- Delivery orders ----
  const doDocMap = new Map(); // old docId -> new docId
  const doJobMap = new Map(); // old jobId -> new jobId
  const poMaxJ = new Map();   // new PO id -> max J number
  for (const d of deliveryOrders) {
    if (![d.jobId, d.purchaseOrderId, d.vendorId, d.driverId, d.vehicleId].some(isAB)) continue;
    const oldJobId = String(d.jobId || '');
    const np = poMap.get(d.purchaseOrderId);
    const newPurchaseOrderId = np ? np.id : (d.purchaseOrderId || '');
    const newPoNumber = np ? np.poNumber : (d.poNumber || '');
    const newVendor = vendorMap.get(d.vendorId) || d.vendorId;
    const newDriver = driverMap.get(d.driverId) || d.driverId;
    const newTruck = truckMap.get(d.vehicleId) || d.vehicleId;
    const poPart = String(newPoNumber).split('/')[0] || 'PO';
    const jm = oldJobId.match(/\/J(\d+)$/);
    const jn = jm ? parseInt(jm[1], 10) : 1;
    const newJobKey = `${poPart}/${newVendor}/${newDriver}/${newTruck}`;
    const newJobId = `${newJobKey}/J${pad(jn, 4)}`;
    const newDocId = newJobId.replace(/\//g, '-');

    if (poMaxJ.has(newPurchaseOrderId)) poMaxJ.set(newPurchaseOrderId, Math.max(poMaxJ.get(newPurchaseOrderId), jn));
    else poMaxJ.set(newPurchaseOrderId, jn);

    const data = {
      ...d, id: newDocId, jobId: newJobId, jobKey: newJobKey,
      poNumber: newPoNumber, purchaseOrderId: newPurchaseOrderId,
      vendorId: newVendor, driverId: newDriver, vehicleId: newTruck,
    };
    if (d.receiptNoteId && oldJobId) data.receiptNoteId = String(d.receiptNoteId).split(oldJobId).join(newJobId);
    ops.sets.push({ ref: db.collection('deliveryOrders').doc(newDocId), data });
    ops.deletes.push(db.collection('deliveryOrders').doc(d.id));
    doDocMap.set(d.id, newDocId);
    doJobMap.set(oldJobId, newJobId);
    summary.deliveryOrders++;
  }

  // ---- Stocks (in-place field updates) ----
  for (const s of stocks) {
    if (![s.deliveryOrderId, s.jobId, s.purchaseOrderId, s.poNumber].some(isAB)) continue;
    const data = { ...s };
    if (s.deliveryOrderId) data.deliveryOrderId = doDocMap.get(s.deliveryOrderId) || s.deliveryOrderId;
    if (s.jobId) data.jobId = doJobMap.get(s.jobId) || s.jobId;
    if (s.purchaseOrderId) {
      const np = poMap.get(s.purchaseOrderId);
      if (np) { data.purchaseOrderId = np.id; data.poNumber = np.poNumber; }
    }
    ops.sets.push({ ref: db.collection('stocks').doc(s.id), data });
    summary.stocks++;
  }

  // ---- vehicleRegistrations ----
  for (const v of vehRegs) {
    if (!isAB(v.vehicleId)) continue;
    ops.sets.push({ ref: db.collection('vehicleRegistrations').doc(v.id), data: { ...v, vehicleId: truckMap.get(v.vehicleId) || v.vehicleId } });
    summary.vehRegs++;
  }

  // ---- jobCounters ----
  const jc = await loadAll('jobCounters');
  const preservedJC = new Map(); // new PO id -> nextJobNumber
  for (const c of jc) {
    if (!isAB(c.id) && !isAB(c.purchaseOrderId)) continue;
    const np = poMap.get(c.purchaseOrderId) || poMap.get(c.id);
    if (!np) { anomalies.push(`jobCounters/${c.id} references unknown PO ${c.purchaseOrderId}`); continue; }
    const next = Math.max(Number(c.nextJobNumber) || 0, (poMaxJ.get(np.id) || 0) + 1);
    preservedJC.set(np.id, next);
    ops.sets.push({ ref: db.collection('jobCounters').doc(np.id), data: { purchaseOrderId: np.id, nextJobNumber: next, updatedAt: new Date().toISOString() } });
    ops.deletes.push(db.collection('jobCounters').doc(c.id));
    summary.jobCounters++;
  }
  // Ensure every migrated PO has a job counter (even if it had none before).
  for (const o of abOrders) {
    const np = poMap.get(o.id);
    if (!preservedJC.has(np.id)) {
      const next = (poMaxJ.get(np.id) || 0) + 1;
      ops.sets.push({ ref: db.collection('jobCounters').doc(np.id), data: { purchaseOrderId: np.id, nextJobNumber: next, updatedAt: new Date().toISOString() } });
      summary.jobCounters++;
    }
  }

  // ---- Counters ----
  const countersUpdate = {
    vendor_counter: vn,
    driver_counter: dn,
    truck_counter: tn,
    vehicle_counter: tn,
    purchase_order_v2_counter: pn,
  };

  // ---- Duplicate detection ----
  const seen = new Set();
  for (const op of ops.sets) {
    if (seen.has(op.ref.path)) anomalies.push(`DUPLICATE new doc target: ${op.ref.path}`);
    seen.add(op.ref.path);
  }

  // ---- Report ----
  console.log('\n=== MIGRATION SUMMARY ===');
  console.log(`vendors:          ${summary.vendors}  (AB -> V${pad(vn - summary.vendors + 1, 3)}..V${pad(vn, 3)})`);
  console.log(`drivers:          ${summary.drivers}  (AB -> D${pad(dn - summary.drivers + 1, 3)}..D${pad(dn, 3)})`);
  console.log(`trucks/vehicles:  ${summary.trucks}  (AB -> T${pad(tn - summary.trucks + 1, 3)}..T${pad(tn, 3)})`);
  console.log(`purchaseOrders:   ${summary.pos}  (AB -> PO${pad(pn - summary.pos + 1, 4)}..PO${pad(pn, 4)})`);
  console.log(`deliveryOrders:   ${summary.deliveryOrders}`);
  console.log(`stocks:           ${summary.stocks}`);
  console.log(`vehicleRegs:      ${summary.vehRegs}`);
  console.log(`jobCounters:      ${summary.jobCounters}`);
  console.log(`total sets:       ${ops.sets.length}`);
  console.log(`total deletes:    ${ops.deletes.length}`);
  console.log(`new counters:     ${JSON.stringify(countersUpdate)}`);
  if (anomalies.length) {
    console.log(`\n=== ANOMALIES (${anomalies.length}) ===`);
    for (const a of anomalies.slice(0, 50)) console.log('  ' + a);
  } else {
    console.log('\nNo anomalies detected.');
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to write.');
    process.exit(0);
  }

  // ---- Apply ----
  console.log('\nApplying...');
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

  for (const batch of chunk(ops.sets, 450)) {
    const b = db.batch();
    for (const op of batch) b.set(op.ref, op.data);
    await b.commit();
    process.stdout.write('.');
  }
  console.log('\nSets committed.');
  for (const batch of chunk(ops.deletes, 450)) {
    const b = db.batch();
    for (const ref of batch) b.delete(ref);
    await b.commit();
    process.stdout.write('.');
  }
  console.log('\nDeletes committed.');
  await db.collection('counters').doc('auto_ids').set(countersUpdate, { merge: true });
  console.log('Counters updated:', JSON.stringify(countersUpdate));
  console.log('\nDONE.');
  process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

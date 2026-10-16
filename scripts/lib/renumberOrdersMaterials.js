const { stockRows } = require('../../src/modules/stocks/model');
const COLLECTIONS = ['materials', 'purchaseOrders', 'deliveryOrders', 'accessBridgeTickets', 'stocks', 'stockMovements',
  'warehouseJobs', 'jobCounters', 'purchaseOrderMerges', 'materialMerges', 'numberingMigrations'];
const pad = (value, width) => String(value).padStart(width, '0');
const ordinal = id => Number(String(id).match(/^(?:MAT|M|PO|WH)(\d+)/i)?.[1] || 0);
const sort = rows => rows.slice().sort((a, b) => ordinal(a.id) - ordinal(b.id) || a.id.localeCompare(b.id));
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
function planNumbering(state) {
  const materials = sort(state.materials).map((row, index) => ({ from: row.id, to: `MAT${pad(index + 1, 3)}`, name: row.name || row.materialName }));
  const orders = sort(state.purchaseOrders).map((row, index) => {
    if (!row.vendorId || !row.poNumber) throw Error(`Missing PO/vendor reference on ${row.id}`);
    const vendor = String(row.vendorId).replace(/^[Vv]?0*(\d+)$/, (_, number) => `V${pad(Number(number), 3)}`);
    const poNumber = `${/^WH/i.test(row.poNumber) ? 'WH' : 'PO'}${pad(index + 1, 4)}/${vendor}`;
    return { from: row.id, to: poNumber.replace(/\//g, '-'), oldNumber: row.poNumber, poNumber, vendorId: vendor };
  });
  return { materials, orders, counters: { material_counter: materials.length, purchase_order_v2_counter: orders.length, purchase_order_counter: orders.length } };
}
function buildNumbering(state, revisionId, now) {
  const plan = planNumbering(state);
  const materialMap = new Map(plan.materials.map(row => [row.from, row]));
  const poMap = new Map(plan.orders.flatMap(row => [[row.from, row], [row.oldNumber, row]]));
  const currentMaterialIds = new Set(plan.materials.map(row => row.to));
  const identity = plan.materials.every(row => row.from === row.to) && plan.orders.every(row => row.from === row.to && row.oldNumber === row.poNumber);
  const countersCorrect = Object.entries(plan.counters).every(([key, value]) => state.autoIds[key] === value);
  const unchangedNumbering = identity && countersCorrect && state.autoIds.numberingRevision?.purchaseOrders && state.autoIds.numberingRevision?.materials;
  const effectiveRevision = unchangedNumbering ? state.autoIds.numberingRevision.id : revisionId;
  const history = new Map(state.purchaseOrderMerges.flatMap(row => [row.id, row.originalPurchaseOrderId, row.originalPoNumber].filter(Boolean).map(key => [key, row.mergedIntoPurchaseOrderId])));
  const resolvePO = value => {
    const seen = new Set();
    while (value && !seen.has(value)) {
      if (poMap.has(value)) return poMap.get(value);
      seen.add(value); value = history.get(value);
    }
    return null;
  };
  const stockMap = new Map();
  function rewrite(value) {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!plain(value)) return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    const material = materialMap.get(value.materialId);
    if (material) {
      result.materialId = material.to;
      if (Object.hasOwn(value, 'materialNumber')) result.materialNumber = material.to.replace(/^MAT/, '');
    }
    if (Array.isArray(value.materialIds)) result.materialIds = value.materialIds.map(id => materialMap.get(id)?.to || id);
    for (const key of ['purchaseOrderId', 'mergedIntoPurchaseOrderId']) if (resolvePO(value[key])) result[key] = resolvePO(value[key]).to;
    for (const key of ['poNumber', 'purchaseOrderNumber', 'mergedIntoPoNumber']) if (resolvePO(value[key])) result[key] = resolvePO(value[key]).poNumber;
    if (materialMap.has(value.mergedIntoMaterialId)) result.mergedIntoMaterialId = materialMap.get(value.mergedIntoMaterialId).to;
    if (stockMap.has(value.stockId)) result.stockId = stockMap.get(value.stockId);
    return result;
  }
  const desired = new Map(COLLECTIONS.map(name => [name, new Map()]));
  const put = (collection, id, data) => {
    if (desired.get(collection).has(id)) throw Error(`Renumbering collision at ${collection}/${id}`);
    desired.get(collection).set(id, data);
  };
  for (const stock of state.stocks) {
    const result = rewrite(stock);
    let nextId = stock.id;
    if (stock.materialId !== result.materialId) {
      const delivery = state.deliveryOrders.find(row => row.id === stock.deliveryOrderId);
      if (!delivery) throw Error(`Missing delivery for stock ${stock.id}`);
      const before = stockRows(delivery), after = stockRows(rewrite(delivery));
      const index = before.findIndex(row => row.id === stock.id);
      if (index < 0 || !after[index]) throw Error(`Unrecognized stock ID ${stock.id}`);
      nextId = after[index].id;
    }
    if ([...stockMap.values()].includes(nextId)) throw Error(`Stock collision: ${nextId}`);
    stockMap.set(stock.id, nextId);
  }
  for (const material of state.materials) {
    const mapping = materialMap.get(material.id);
    const result = { ...material, id: mapping.to, materialId: mapping.to, materialNumber: mapping.to.replace(/^MAT/, ''), numberingRevision: effectiveRevision };
    // Old merged IDs may now identify a different material. Keep spelling aliases,
    // but remove those conflicting identifier aliases from runtime matching.
    result.mergedMaterialIds = (material.mergedMaterialIds || []).filter(id => !currentMaterialIds.has(id));
    put('materials', mapping.to, result);
  }
  for (const order of state.purchaseOrders) {
    const mapping = poMap.get(order.id);
    put('purchaseOrders', mapping.to, { ...rewrite(order), id: mapping.to, poNumber: mapping.poNumber,
      vendorId: mapping.vendorId, numberingRevision: effectiveRevision });
  }
  for (const collection of COLLECTIONS.filter(name => !['materials', 'purchaseOrders', 'jobCounters', 'numberingMigrations'].includes(name))) {
    for (const row of state[collection]) {
      const result = rewrite(row);
      const id = collection === 'stocks' ? stockMap.get(row.id) : row.id;
      put(collection, id, collection === 'stocks' ? { ...result, id } : result);
    }
  }
  const jobs = [...state.deliveryOrders, ...state.warehouseJobs].map(rewrite);
  const suffix = row => Number(String(row.jobId || '').match(/\/J(\d+)(?:$|\/)/)?.[1] || 0);
  for (const mapping of plan.orders) {
    const counter = state.jobCounters.find(row => row.id === mapping.from.replace(/\//g, '-'));
    const linked = jobs.filter(row => row.purchaseOrderId === mapping.to);
    // Preserve issued J suffixes even if their old embedded PO prefix is reused.
    const historicalPrefix = jobs.filter(row => String(row.jobId || '').startsWith(mapping.poNumber + '/'));
    const nextJobNumber = Math.max(Number(counter?.nextJobNumber || 0), linked.length, ...linked.map(suffix), ...historicalPrefix.map(suffix));
    put('jobCounters', mapping.to, { ...counter, id: mapping.to, purchaseOrderId: mapping.to, nextJobNumber });
  }
  for (const counter of state.jobCounters.filter(row => !poMap.has(row.id))) put('jobCounters', counter.id, counter);
  for (const history of state.numberingMigrations) put('numberingMigrations', history.id, history);
  if (!unchangedNumbering) put('numberingMigrations', revisionId, { id: revisionId, createdAt: now, materials: plan.materials, orders: plan.orders,
    countersBefore: { material_counter: state.autoIds.material_counter, purchase_order_v2_counter: state.autoIds.purchase_order_v2_counter,
      purchase_order_counter: state.autoIds.purchase_order_counter }, countersAfter: plan.counters, issuedTripAndReceiptIdsPreserved: true });
  const changes = [];
  for (const collection of COLLECTIONS) {
    const old = new Map(state[collection].map(row => [row.id, row]));
    for (const [id, data] of desired.get(collection)) {
      if (JSON.stringify(old.get(id)) !== JSON.stringify(data)) changes.push({ collection, id, data: { ...data, updatedAt: now } });
    }
    for (const id of old.keys()) if (!desired.get(collection).has(id)) changes.push({ collection, id, delete: true });
  }
  if (!unchangedNumbering) changes.push({ collection: 'counters', id: 'auto_ids', patch: { ...plan.counters,
    numberingRevision: { id: revisionId, at: now, purchaseOrders: true, materials: true } } });
  if (changes.length > 450) throw Error(`Renumbering needs ${changes.length} writes; exceeds 450-write atomic limit.`);
  return { plan, changes };
}
async function readNumbering(reader, db) {
  const originals = new Map();
  const entries = await Promise.all(COLLECTIONS.map(async collection => {
    const snapshot = await reader.get(db.collection(collection));
    return [collection, snapshot.docs.map(doc => { originals.set(`${collection}/${doc.id}`, doc.data()); return { ...doc.data(), id: doc.id }; })];
  }));
  const counter = await reader.get(db.collection('counters').doc('auto_ids'));
  if (counter.exists) originals.set('counters/auto_ids', counter.data());
  return { state: { ...Object.fromEntries(entries), autoIds: counter.data() || {} }, originals };
}
async function applyNumbering(db, revisionId, backup) {
  return db.runTransaction(async tx => {
    const { state, originals } = await readNumbering(tx, db);
    const { plan, changes } = buildNumbering(state, revisionId, new Date().toISOString());
    if (!changes.length) return { plan, writes: 0 };
    await backup({ plan, changes: changes.map(change => ({ path: `${change.collection}/${change.id}`, existed: originals.has(`${change.collection}/${change.id}`),
      before: originals.get(`${change.collection}/${change.id}`) || null, operation: change.delete ? 'delete' : 'set', after: change.data || change.patch })) });
    for (const change of changes) {
      const ref = db.collection(change.collection).doc(change.id);
      if (change.delete) tx.delete(ref); else if (change.patch) tx.set(ref, change.patch, { merge: true }); else tx.set(ref, change.data);
    }
    return { plan, writes: changes.length };
  });
}
module.exports = { COLLECTIONS, planNumbering, buildNumbering, readNumbering, applyNumbering };

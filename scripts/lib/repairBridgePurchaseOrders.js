const { normalizeName } = require('../../src/utils/vendorMatching');
const { materialNamesMatch } = require('../../src/utils/materialMatching');
const { selectBridgePurchaseOrder } = require('../../src/utils/bridgePurchaseOrder');
const { isWarehousePurchaseOrder } = require('../../src/modules/purchase-orders/warehouse');
const { buildDeliverySummary } = require('../../src/modules/purchase-orders/deliverySummary');

const COLLECTIONS = ['purchaseOrders', 'vendors', 'materials', 'deliveryOrders', 'accessBridgeTickets',
  'stocks', 'stockMovements', 'warehouseJobs', 'jobCounters', 'purchaseOrderMerges'];
const REFERENCES = ['deliveryOrders', 'accessBridgeTickets', 'stocks', 'stockMovements'];
const closed = new Set(['COMPLETED', 'COMPLETE', 'DELIVERED', 'FULFILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'ARCHIVED', 'EXCESS', 'OVERDELIVERED', 'OVER_DELIVERED']);
const text = value => String(value ?? '').trim();
const norm = value => text(value).toUpperCase();
const vendorId = value => norm(value).replace(/^V?0*(\d+)$/, 'V$1');
const materialId = value => norm(value).replace(/^(?:MAT|M)?0*(\d+)$/, 'MAT$1');
const bridge = order => order.bridgeCreated === true || order.createdBy === 'access_bridge';
const round = value => Math.round(value * 1e6) / 1e6;
const unit = value => /^(t|tons?|tonnes?|metric tonnes)$/i.test(text(value)) ? 'tonnes' : text(value).toLowerCase();
const active = order => !order.mergedIntoPurchaseOrderId && !closed.has(norm(order.status));
const number = value => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw Error(`Invalid counter: ${value}`);
  return result;
};
const matchesPO = (row, order) => !!row.purchaseOrderId && [order.id, order.poNumber].includes(text(row.purchaseOrderId))
  || (!row.purchaseOrderId && [row.poNumber, row.purchaseOrderNumber].some(value => norm(value) && norm(value) === norm(order.poNumber)));

function vendorKey(order, state) {
  const vendor = state.vendors.find(v => vendorId(v.id) === vendorId(order.vendorId));
  return vendorId(vendor?.id || order.vendorId) || normalizeName(order.vendorName || order.companyName);
}
function materialName(order, state) {
  const material = state.materials.find(m => materialId(m.id) === materialId(order.materialId));
  return order.materialName || material?.name || material?.materialName || '';
}
function sameMaterial(a, b, state) {
  if (a.materialId && b.materialId) return materialId(a.materialId) === materialId(b.materialId);
  return materialNamesMatch(materialName(a, state), materialName(b, state));
}
function eligible(order, state) {
  return !order.mergedIntoPurchaseOrderId && norm(order.status) !== 'ARCHIVED'
    && !isWarehousePurchaseOrder(order, state.materials) && (order.materials?.length || 0) <= 1
    && !!vendorKey(order, state) && !!(order.materialId || materialName(order, state));
}
function filterOrder(order, options, state) {
  const vendor = !options.vendor || vendorId(options.vendor) === vendorId(order.vendorId)
    || normalizeName(order.vendorName || order.companyName).includes(normalizeName(options.vendor));
  const material = !options.material || materialId(options.material) === materialId(order.materialId)
    || materialNamesMatch(options.material, materialName(order, state));
  return vendor && material;
}

function planRepairs(state, options = {}) {
  const groups = [], skipped = [];
  const orders = state.purchaseOrders.filter(order => eligible(order, state));
  for (const order of orders) {
    const group = groups.find(items => vendorKey(items[0], state) === vendorKey(order, state) && sameMaterial(items[0], order, state));
    if (group) group.push(order); else groups.push([order]);
  }
  const pairs = [];
  for (const group of groups.filter(items => items.length > 1 && items.some(order => filterOrder(order, options, state)))) {
    const candidates = group.filter(order => active(order) && text(order.poNumber));
    const keep = options.keepPO ? candidates.find(order => [order.id, order.poNumber].includes(options.keepPO))
      : selectBridgePurchaseOrder(candidates, { vendor: vendorKey(group[0], state), material: group[0].materialId || materialName(group[0], state) });
    if (!keep) { skipped.push({ ids: group.map(order => order.id), reason: 'No unique open keeper; use --keep-po with --vendor/--material after review.' }); continue; }
    for (const source of group.filter(order => order.id !== keep.id)) {
      let reason;
      if (!bridge(source)) reason = 'Manually created PO retained; only Access Bridge duplicates can be retired.';
      else if (['CANCELLED', 'CANCELED'].includes(norm(source.status))) reason = 'Cancelled PO retained.';
      else if ([source.quantity, ...(source.materials || []).map(line => line.quantity)].some(value => value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) !== 0))) reason = 'Duplicate has an ordered quantity; contractual quantities require review.';
      else if (unit(source.unit || keep.unit) !== unit(keep.unit || source.unit)) reason = 'PO units differ.';
      else if (['siteId', 'siteName', 'quarryId', 'quarryName', 'quarryLocation'].some(field => source[field] && keep[field] && norm(source[field]) !== norm(keep[field]))) reason = 'Site or quarry differs.';
      else if (state.warehouseJobs.some(row => matchesPO(row, source))) reason = 'Warehouse shipment references this PO.';
      if (reason) { skipped.push({ ids: [source.id], reason }); continue; }
      pairs.push({ sourceId: source.id, keepId: keep.id, sourceNumber: source.poNumber, keepNumber: keep.poNumber,
        references: Object.fromEntries(REFERENCES.map(name => [name, state[name].filter(row => matchesPO(row, source)).length])) });
    }
  }
  return { pairs, skipped, counter: counterRepair(state) };
}

function counterRepair(state) {
  const before = state.autoIds || {};
  const compacted = before.numberingRevision?.purchaseOrders;
  let max = 0;
  for (const row of [...state.purchaseOrders, ...state.deliveryOrders, ...state.warehouseJobs, ...state.accessBridgeTickets, ...(state.purchaseOrderMerges || [])]) {
    for (const value of (compacted
      ? [row.poNumber, row.purchaseOrderId, row.purchaseOrderNumber, row.mergedIntoPoNumber, row.mergedIntoPurchaseOrderId, ...(state.purchaseOrders.includes(row) ? [row.id] : [])]
      : [row.id, row.poNumber, row.purchaseOrderId, row.purchaseOrderNumber, row.jobId, row.originalPurchaseOrderId, row.originalPoNumber])) {
      const match = text(value).match(/^(?:PO|WH)(\d+)(?:[/-]|$)/i);
      if (match) max = Math.max(max, number(match[1]));
    }
  }
  return { before: { purchase_order_v2_counter: number(before.purchase_order_v2_counter), purchase_order_counter: number(before.purchase_order_counter) },
    after: { purchase_order_v2_counter: Math.max(max, number(before.purchase_order_v2_counter)),
      purchase_order_counter: Math.max(max, number(before.purchase_order_counter)) } };
}

function pairChanges(state, pair, now) {
  const source = state.purchaseOrders.find(order => order.id === pair.sourceId);
  const keep = state.purchaseOrders.find(order => order.id === pair.keepId);
  if (source?.mergedIntoPurchaseOrderId === pair.keepId) return [];
  const fresh = planRepairs({ ...state, purchaseOrders: [source, keep].filter(Boolean) }, { keepPO: pair.keepId });
  if (!source || !keep || !fresh.pairs.some(item => item.sourceId === pair.sourceId && item.keepId === pair.keepId)) throw Error(`PO eligibility changed: ${pair.sourceId}; rerun dry-run.`);
  const changes = [];
  const stamp = { repair: 'access-bridge-duplicate-po-v1', at: now, from: source.id, to: keep.id };
  const nestedReferences = value => {
    if (Array.isArray(value)) return value.map(nestedReferences);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
    const updated = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nestedReferences(item)]));
    if ([source.id, source.poNumber].includes(value.purchaseOrderId)) updated.purchaseOrderId = keep.id;
    for (const field of ['poNumber', 'purchaseOrderNumber']) if (value[field] && [source.id, source.poNumber].includes(value[field])) updated[field] = keep.poNumber;
    return updated;
  };
  for (const name of REFERENCES) {
    for (const row of state[name].filter(item => matchesPO(item, source))) {
      const patch = { purchaseOrderId: keep.id, poNumber: keep.poNumber, poRepair: stamp, updatedAt: now };
      if (Object.hasOwn(row, 'purchaseOrderNumber')) patch.purchaseOrderNumber = keep.poNumber;
      for (const [field, value] of Object.entries(row)) {
        if (!value || typeof value !== 'object') continue;
        const updated = nestedReferences(value);
        if (JSON.stringify(value) !== JSON.stringify(updated)) patch[field] = updated;
      }
      changes.push({ collection: name, id: row.id, patch });
    }
  }
  const deliveries = state.deliveryOrders.filter(row => matchesPO(row, keep) || matchesPO(row, source))
    .map(row => ({ ...row, purchaseOrderId: keep.id }));
  const summary = buildDeliverySummary(keep, deliveries);
  const pending = order => {
    const value = Number(order.pendingQualityControl || 0);
    if (!Number.isFinite(value) || value < 0) throw Error(`Invalid pendingQualityControl on ${order.id}`);
    return value;
  };
  const keepPatch = { pendingQualityControl: round(pending(keep) + pending(source)), deliverySummary: summary, updatedAt: now };
  if (summary.totals.length === 1) Object.assign(keepPatch, { quantityDelivered: summary.totals[0].deliveredQuantity, excessQuantity: summary.totals[0].excessQuantity });
  changes.push({ collection: 'purchaseOrders', id: keep.id, patch: keepPatch });
  changes.push({ collection: 'purchaseOrders', id: source.id, patch: { status: 'archived', mergedIntoPurchaseOrderId: keep.id,
    mergedIntoPoNumber: keep.poNumber, mergedAt: now, pendingQualityControl: 0, quantityDelivered: 0,
    excessQuantity: 0, deliverySummary: buildDeliverySummary(source, []), poRepair: stamp, updatedAt: now } });
  const counterIds = [keep.id, source.id].map(id => id.replace(/\//g, '-'));
  const relatedJobs = [...deliveries, ...state.warehouseJobs.filter(row => matchesPO(row, keep))];
  let maxJob = relatedJobs.length;
  for (const job of relatedJobs) {
    const match = text(job.jobId).match(/\/J(\d+)(?:$|\/)/);
    if (match) maxJob = Math.max(maxJob, number(match[1]));
  }
  for (const counter of state.jobCounters.filter(row => counterIds.includes(row.id))) maxJob = Math.max(maxJob, number(counter.nextJobNumber));
  changes.push({ collection: 'jobCounters', id: counterIds[0], patch: { nextJobNumber: maxJob, purchaseOrderId: keep.id, updatedAt: now } });
  if (changes.length > 450) throw Error(`${source.id} needs ${changes.length} writes; exceeds the 450-write atomic repair limit. No part of this PO was changed.`);
  return changes;
}

async function readState(reader, db) {
  const entries = await Promise.all(COLLECTIONS.map(async name => [name, await reader.get(db.collection(name))]));
  const counter = await reader.get(db.collection('counters').doc('auto_ids'));
  const originals = new Map();
  const state = Object.fromEntries(entries.map(([name, snapshot]) => [name, snapshot.docs.map(doc => {
    originals.set(`${name}/${doc.id}`, doc.data());
    return { ...doc.data(), id: doc.id };
  })]));
  state.autoIds = counter.data() || {};
  if (counter.exists) originals.set('counters/auto_ids', counter.data());
  return { state, originals };
}
// Each merge reads only the keeper/source references. Reading every collection
// per duplicate made large repairs slow and locked unrelated live records.
async function readPairState(reader, db, pair, includeMerged = false) {
  const state = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  state.autoIds = {};
  const originals = new Map();
  const remember = (name, docs) => {
    const unique = new Map();
    for (const doc of docs.filter(doc => doc.exists !== false)) {
      originals.set(`${name}/${doc.id}`, doc.data());
      unique.set(doc.id, { ...doc.data(), id: doc.id });
    }
    state[name] = [...unique.values()];
  };
  const pairs = Array.isArray(pair) ? pair : [pair];
  const ids = [...new Set(pairs.flatMap(item => [item.sourceId, item.keepId]))];
  const pos = await Promise.all(ids.map(id => reader.get(db.collection('purchaseOrders').doc(id))));
  remember('purchaseOrders', pos);
  if (!includeMerged && pairs.every(item => state.purchaseOrders.find(order => order.id === item.sourceId)?.mergedIntoPurchaseOrderId === item.keepId)) return { state, originals };
  const numbers = [...new Set(state.purchaseOrders.map(order => order.poNumber).filter(Boolean))];
  const references = [...new Set([...ids, ...numbers])];
  await Promise.all([
    ...[...REFERENCES, 'warehouseJobs'].map(async name => {
      const queries = [];
      for (const [field, values] of [['purchaseOrderId', references], ['poNumber', numbers], ['purchaseOrderNumber', numbers]]) {
        for (let i = 0; i < values.length; i += 30) queries.push(db.collection(name).where(field, 'in', values.slice(i, i + 30)));
      }
      const snapshots = await Promise.all(queries.map(query => reader.get(query)));
      remember(name, snapshots.flatMap(snapshot => snapshot.docs));
    }),
    (async () => remember('jobCounters', await Promise.all(ids.map(id => reader.get(db.collection('jobCounters').doc(id.replace(/\//g, '-')))))))(),
    (async () => remember('purchaseOrderMerges', await Promise.all(pairs.map(item => reader.get(db.collection('purchaseOrderMerges').doc(item.sourceId))))))(),
    (async () => remember('materials', (await reader.get(db.collection('materials'))).docs))(),
  ]);
  return { state, originals };
}
async function commitChanges(db, build, backup, load = readState) {
  return db.runTransaction(async tx => {
    const { state, originals } = await load(tx, db);
    const changes = build(state);
    if (!changes.length) return 0;
    // A backup must succeed before the transaction can write anything. Transaction
    // retries may leave additional backup files; all describe pre-commit values.
    await backup(changes.map(change => ({ path: `${change.collection}/${change.id}`,
      existed: originals.has(`${change.collection}/${change.id}`),
      before: originals.get(`${change.collection}/${change.id}`) || null, operation: change.delete ? 'delete' : 'merge', patch: change.patch })));
    for (const change of changes) {
      const ref = db.collection(change.collection).doc(change.id);
      if (change.delete) tx.delete(ref); else tx.set(ref, change.patch, { merge: true });
    }
    return changes.length;
  });
}
async function applyPair(db, pair, backup) {
  return commitChanges(db, state => pairChanges(state, pair, new Date().toISOString()), backup, (reader, database) => readPairState(reader, database, pair));
}
function batchChanges(state, pairs, now) {
  // Apply patches to the isolated transaction snapshot so balances and summaries
  // from earlier sources are included exactly once in the final keeper update.
  const working = Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? value.map(row => ({ ...row })) : value]));
  const changes = new Map();
  for (const pair of pairs) {
    for (const change of pairChanges(working, pair, now)) {
      const key = `${change.collection}/${change.id}`;
      const previous = changes.get(key);
      changes.set(key, { ...change, patch: { ...previous?.patch, ...change.patch } });
      const index = working[change.collection].findIndex(row => row.id === change.id);
      if (index < 0) working[change.collection].push({ id: change.id, ...change.patch });
      else working[change.collection][index] = { ...working[change.collection][index], ...change.patch };
    }
  }
  if (changes.size > 450) throw Error(`Batch needs ${changes.size} writes; exceeds the 450-write atomic repair limit.`);
  return [...changes.values()];
}
async function applyBatch(db, pairs, backup) {
  return commitChanges(db, state => batchChanges(state, pairs, new Date().toISOString()), backup,
    (reader, database) => readPairState(reader, database, pairs));
}
function deletionChanges(state, pairs, now) {
  const changes = [];
  for (const pair of pairs) {
    const source = state.purchaseOrders.find(order => order.id === pair.sourceId);
    if (!source) continue;
    const keep = state.purchaseOrders.find(order => order.id === pair.keepId);
    if (!keep || keep.mergedIntoPurchaseOrderId || !bridge(source) || norm(source.status) !== 'ARCHIVED'
      || source.mergedIntoPurchaseOrderId !== keep.id || source.poRepair?.repair !== 'access-bridge-duplicate-po-v1'
      || Number(source.pendingQualityControl || 0) !== 0) throw Error(`Deletion refused: ${source.id} is not a fully merged bridge duplicate.`);
    const references = new Set([source.id, source.poNumber].filter(Boolean));
    const dangling = [...REFERENCES, 'warehouseJobs'].some(name => state[name].some(row =>
      [row.purchaseOrderId, row.poNumber, row.purchaseOrderNumber].some(value => references.has(value))));
    if (dangling) throw Error(`Deletion refused: ${source.id} still has live references.`);
    const sourceCounter = state.jobCounters.find(row => row.id === source.id.replace(/\//g, '-'));
    const keepCounter = state.jobCounters.find(row => row.id === keep.id.replace(/\//g, '-'));
    if (number(sourceCounter?.nextJobNumber) > number(keepCounter?.nextJobNumber)) throw Error(`Deletion refused: ${source.id} trip counter has not been transferred.`);
    changes.push({ collection: 'purchaseOrderMerges', id: source.id, patch: { originalPurchaseOrderId: source.id,
      originalPoNumber: source.poNumber || '', mergedIntoPurchaseOrderId: keep.id, mergedIntoPoNumber: keep.poNumber,
      originalNextJobNumber: number(sourceCounter?.nextJobNumber), mergedAt: source.mergedAt || '', deletedAt: now } });
    changes.push({ collection: 'purchaseOrders', id: source.id, delete: true });
    if (sourceCounter) changes.push({ collection: 'jobCounters', id: sourceCounter.id, delete: true });
  }
  if (changes.length > 450) throw Error('Deletion batch exceeds the 450-write atomic limit.');
  return changes;
}
function planMergedDeletions(state, options = {}) {
  const pairs = [], skipped = [];
  for (const order of state.purchaseOrders.filter(order => order.mergedIntoPurchaseOrderId && filterOrder(order, options, state))) {
    if (options.keepPO && ![order.mergedIntoPurchaseOrderId, order.mergedIntoPoNumber].includes(options.keepPO)) continue;
    const pair = { sourceId: order.id, keepId: order.mergedIntoPurchaseOrderId };
    try { deletionChanges(state, [pair], new Date().toISOString()); pairs.push(pair); }
    catch (error) { skipped.push({ ids: [order.id], reason: error.message }); }
  }
  return { pairs, skipped };
}
async function deleteMergedBatch(db, pairs, backup) {
  return commitChanges(db, state => deletionChanges(state, pairs, new Date().toISOString()), backup,
    (reader, database) => readPairState(reader, database, pairs, true));
}
async function repairCounter(db, backup) {
  return commitChanges(db, state => {
    const { before, after } = counterRepair(state);
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ collection: 'counters', id: 'auto_ids', patch: after }];
  }, backup);
}
module.exports = { COLLECTIONS, planRepairs, counterRepair, pairChanges, readState, applyPair, applyBatch, batchChanges, repairCounter, planMergedDeletions, deleteMergedBatch, deletionChanges };

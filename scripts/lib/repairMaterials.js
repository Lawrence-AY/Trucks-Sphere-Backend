const { normalizeMaterial, materialNamesMatch } = require('../../src/utils/materialMatching');
const { stockRows } = require('../../src/modules/stocks/model');
const BUSINESS = ['purchaseOrders', 'deliveryOrders', 'accessBridgeTickets', 'stocks', 'stockMovements', 'warehouseJobs'];
const COLLECTIONS = ['materials', 'materialMerges', ...BUSINESS];
const name = m => m.name || m.materialName || '';
const unit = m => String(m.measurementType || m.defaultUnit || m.unit || 'tonnes').toLowerCase().replace(/^(t|tons?|tonnes?)$/, 'tonnes');
const compatible = (a, b) => !!a.isWarehouseMaterial === !!b.isWarehouseMaterial && unit(a) === unit(b)
  && (!a.code || !b.code || normalizeMaterial(a.code) === normalizeMaterial(b.code));
function planMaterials(state) {
  const groups = [];
  for (const material of state.materials.slice().sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
    const matches = groups.filter(group => group.every(other => compatible(other, material) && materialNamesMatch(name(other), name(material))));
    if (matches.length === 1) matches[0].push(material);
    else groups.push([material]);
  }
  return groups.filter(group => group.length > 1).map(group => ({ keepId: group[0].id, keepName: name(group[0]),
    sources: group.slice(1).map(m => ({ id: m.id, name: name(m) })) }));
}
function plain(value) { return value && Object.getPrototypeOf(value) === Object.prototype; }
function rewrite(value, mapping, aliases, stockMap = new Map()) {
  if (Array.isArray(value)) return value.map(item => rewrite(item, mapping, aliases, stockMap));
  if (!plain(value)) return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, mapping, aliases, stockMap)]));
  const target = mapping.get(String(value.materialId || '').toUpperCase());
  if (target) {
    result.materialId = target.id;
    result.materialName = name(target);
    if (Object.hasOwn(value, 'materialNumber')) result.materialNumber = target.id.replace(/^MAT/i, '');
    for (const field of ['productName', 'name']) if (Object.hasOwn(value, field) && materialNamesMatch(value[field], name(target))) result[field] = name(target);
  } else if (!value.materialId && value.materialName && aliases.has(normalizeMaterial(value.materialName))) result.materialName = aliases.get(normalizeMaterial(value.materialName));
  if (stockMap.has(value.stockId)) result.stockId = stockMap.get(value.stockId);
  if (Array.isArray(value.materialIds)) result.materialIds = value.materialIds.map(id => mapping.get(String(id).toUpperCase())?.id || id);
  return result;
}
function buildMaterialChanges(state, plan, now) {
  const mapping = new Map(), aliases = new Map(), changes = new Map();
  const put = (collection, id, data) => changes.set(`${collection}/${id}`, { collection, id, data });
  const remove = (collection, id) => changes.set(`${collection}/${id}`, { collection, id, delete: true });
  for (const group of plan) {
    const keep = state.materials.find(m => m.id === group.keepId);
    if (!keep) throw Error(`Missing canonical material ${group.keepId}`);
    const sources = group.sources.map(source => state.materials.find(m => m.id === source.id)).filter(Boolean);
    if (sources.some(source => !compatible(keep, source) || !materialNamesMatch(name(keep), name(source)))) throw Error('Material identities or units changed; rerun preview.');
    if (!sources.length) continue;
    const allNames = [...new Set([...(keep.aliases || []), ...sources.flatMap(m => [m.name, m.materialName, ...(m.aliases || [])])].filter(Boolean))];
    put('materials', keep.id, { ...keep, name: name(keep), materialName: name(keep), aliases: allNames,
      codes: [...new Set([...(keep.codes || []), ...sources.flatMap(m => [m.code, m.materialCode, ...(m.codes || [])])].filter(Boolean))],
      mergedMaterialIds: [...new Set([...(keep.mergedMaterialIds || []), ...sources.flatMap(m => [m.id, ...(m.mergedMaterialIds || [])])])], updatedAt: now });
    for (const source of sources) {
      mapping.set(source.id.toUpperCase(), keep);
      for (const alias of [source.name, source.materialName, ...(source.aliases || [])].filter(Boolean)) aliases.set(normalizeMaterial(alias), name(keep));
      put('materialMerges', source.id, { originalMaterialId: source.id, originalMaterialName: name(source), mergedIntoMaterialId: keep.id,
        mergedIntoMaterialName: name(keep), mergedAt: now });
      remove('materials', source.id);
    }
  }
  const stockMap = new Map();
  for (const stock of state.stocks) {
    const transformed = rewrite(stock, mapping, aliases);
    if (JSON.stringify(stock) === JSON.stringify(transformed)) continue;
    const delivery = state.deliveryOrders.find(d => d.id === stock.deliveryOrderId);
    if (!delivery) throw Error(`Cannot safely rekey stock ${stock.id}: delivery missing.`);
    const oldRows = stockRows(delivery), newRows = stockRows(rewrite(delivery, mapping, aliases));
    const index = oldRows.findIndex(row => row.id === stock.id);
    if (index < 0 || !newRows[index]) throw Error(`Unknown stock identity ${stock.id}; manual inventory review required.`);
    const nextId = newRows[index].id;
    if (nextId !== stock.id && (state.stocks.some(row => row.id === nextId) || [...stockMap.values()].includes(nextId))) throw Error('Material merge would collide with existing stock; inventory review required.');
    stockMap.set(stock.id, nextId);
    if (nextId !== stock.id) remove('stocks', stock.id);
    put('stocks', nextId, { ...transformed, id: nextId, updatedAt: now });
  }
  for (const collection of BUSINESS.filter(n => n !== 'stocks')) {
    for (const row of state[collection]) {
      const result = rewrite(row, mapping, aliases, stockMap);
      if (JSON.stringify(row) !== JSON.stringify(result)) put(collection, row.id, { ...result, updatedAt: now });
    }
  }
  const current = Number(state.autoIds?.material_counter || 0);
  if (!Number.isSafeInteger(current) || current < 0) throw Error('Invalid material counter.');
  const issued = [...state.materials.map(m => m.id), ...(state.autoIds?.numberingRevision?.materials ? [] : state.materialMerges.map(m => m.originalMaterialId))]
    .map(id => Number(String(id).match(/^(?:MAT|M)(\d+)$/i)?.[1] || 0));
  const max = Math.max(current, 0, ...issued);
  if (max !== current) changes.set('counters/auto_ids', { collection: 'counters', id: 'auto_ids', patch: { material_counter: max } });
  if (changes.size > 450) throw Error(`Material merge needs ${changes.size} writes; exceeds the 450-write transaction limit. Narrow the merge groups.`);
  return [...changes.values()];
}
async function readMaterialState(reader, db) {
  const originals = new Map();
  const entries = await Promise.all(COLLECTIONS.map(async collection => {
    const snapshot = await reader.get(db.collection(collection));
    return [collection, snapshot.docs.map(doc => { originals.set(`${collection}/${doc.id}`, doc.data()); return { ...doc.data(), id: doc.id }; })];
  }));
  const counter = await reader.get(db.collection('counters').doc('auto_ids'));
  if (counter.exists) originals.set('counters/auto_ids', counter.data());
  return { state: { ...Object.fromEntries(entries), autoIds: counter.data() || {} }, originals };
}
async function applyMaterials(db, plan, backup) {
  return db.runTransaction(async tx => {
    const { state, originals } = await readMaterialState(tx, db);
    const changes = buildMaterialChanges(state, plan, new Date().toISOString());
    if (!changes.length) return 0;
    await backup(changes.map(change => ({ path: `${change.collection}/${change.id}`, existed: originals.has(`${change.collection}/${change.id}`),
      before: originals.get(`${change.collection}/${change.id}`) || null, operation: change.delete ? 'delete' : 'set', after: change.data || change.patch || null })));
    for (const change of changes) {
      const ref = db.collection(change.collection).doc(change.id);
      if (change.delete) tx.delete(ref);
      else if (change.patch) tx.set(ref, change.patch, { merge: true });
      else tx.set(ref, change.data);
    }
    return changes.length;
  });
}
module.exports = { COLLECTIONS, planMaterials, buildMaterialChanges, rewrite, readMaterialState, applyMaterials };

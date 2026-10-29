const { buildFleetIndex, normalizeVendorId, tripVendorId } = require('../../src/utils/vendorFleet');
const { matchVendor } = require('../../src/utils/vendorMatching');
const normalize = value => String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
const plate = value => normalize(value).replace(/[\s-]/g, '');
function planNumbering(state) {
  const maps = new Map(), changes = [], issues = [];
  const counter = state.counters?.find(row => row.id === 'auto_ids') || {};
  const counters = { ...counter };
  for (const [collection, prefix, fields] of [
    ['drivers', 'D', ['driver_counter']], ['vehicles', 'T', ['truck_counter', 'vehicle_counter']],
  ]) {
    let max = Math.max(0, ...fields.map(key => Number(counter[key]) || 0),
      ...state[collection].map(row => Number(String(row.id).match(new RegExp('^' + prefix + '(\\d+)$', 'i'))?.[1]) || 0));
    for (const row of [...state[collection]].sort((a,b) => a.id.localeCompare(b.id))) {
      if (row.id.startsWith('AB-')) maps.set(row.id, prefix + String(++max).padStart(3, '0'));
      else if (!new RegExp('^' + prefix + '\\d{3}$').test(row.id)) issues.push({ collection, id: row.id, reason: 'NON_CANONICAL_ID' });
    }
    for (const field of fields) counters[field] = max;
  }
  const fleet = buildFleetIndex(state.vehicles, state.deliveryOrders || [], state.purchaseOrders || []);
  const vendorIds = new Set((state.vendors || []).map(row => normalizeVendorId(row.id)));
  const patches = new Map();
  const evidence = [];
  for (const [collection, rows] of Object.entries(state)) if (collection.endsWith('/snapshots')) {
    for (const doc of rows) {
      let row;
      try { row = JSON.parse(doc.payload); } catch { continue; }
      const result = matchVendor(row.FIRMA_ADI, state.vendors || [], { aliases: state.vendorAliases || [] });
      if (result.match) evidence.push({ row, vendorId: result.match.id });
    }
  }
  for (const collection of ['drivers','vehicles']) for (const row of state[collection]) {
    let ids = collection === 'vehicles' ? [...fleet.get(row.id)] : [...new Set([
      normalizeVendorId(row.vendorId),
      ...(state.deliveryOrders || []).filter(trip => trip.driverId === row.id).map(trip => tripVendorId(trip, state.purchaseOrders || [])),
    ].filter(Boolean))];
    ids = [...new Set([...ids, ...evidence.filter(({ row: source }) => collection === 'vehicles'
      ? plate(source.PLAKA) && plate(source.PLAKA) === plate(row.registrationNumber || row.plateNumber)
      : normalize(source.DIGER3_ISIM) && [row.name,row.fullName].some(name => normalize(name) === normalize(source.DIGER3_ISIM))
    ).map(item => item.vendorId)])];
    if (ids.some(id => !vendorIds.has(id))) throw Error('Unknown vendor on ' + collection + '/' + row.id);
    const patch = {};
    if (collection === 'vehicles' && ids.length) patch.vendorIds = ids.sort();
    if (!row.vendorId && ids.length === 1) patch.vendorId = ids[0];
    if (!ids.length || (collection === 'drivers' && !row.vendorId && ids.length > 1)) issues.push({ collection, id: row.id, name: row.name || row.fullName || row.plateNumber || '', reason: ids.length ? 'MULTIPLE_VENDORS' : 'NO_VENDOR_EVIDENCE' });
    patches.set(collection + '/' + row.id, patch);
  }
  for (const trip of state.deliveryOrders || []) {
    const jobParts = String(trip.jobKey || '').split('/');
    const idParts = String(trip.jobId || '').split('/');
    // Warehouse jobs deliberately omit driver and truck placeholders.
    // WH####/V###/J#### is a complete and valid reference.
    if (jobParts.length === 3 && idParts.length === 3
      && jobParts.join('/') === idParts.join('/')
      && /^WH\d{3,4}$/.test(jobParts[0]) && /^V\d{3}$/.test(jobParts[1])
      && /^J\d{4}$/.test(jobParts[2])) continue;
    const hasConsistentReference = jobParts.length === 4 && idParts.length === 5
      && idParts.slice(0, 4).join('/') === trip.jobKey
      && idParts[2] === trip.driverId && idParts[3] === trip.vehicleId;
    // Reconcile every job, not only the old AB imports. jobKey is the
    // pre-J reference selected by dispatch and is the authoritative source
    // when jobId, vehicleId, or receipt references disagree.
    if (hasConsistentReference && !String(trip.jobId).includes('AB')) continue;
    if (jobParts.length !== 4 || idParts.length !== 5 || !trip.driverId || !trip.vehicleId) {
      issues.push({ collection: 'deliveryOrders', id: trip.id, reason: 'INCONSISTENT_JOB_REFERENCE' });
      continue;
    }
    const driverFromKey = jobParts[2];
    const truckFromKey = jobParts[3];
    // Legacy AB jobs have no canonical jobKey; retain the original migration
    // path and rebuild them from their mapped master-record IDs.
    if (String(trip.jobId).includes('AB') && (!/^D\d{3}$/.test(driverFromKey) || !/^T\d{3}$/.test(truckFromKey))) {
      const driver = maps.get(trip.driverId) || trip.driverId;
      const truck = maps.get(trip.vehicleId) || trip.vehicleId;
      const job = [idParts[0], idParts[1], driver, truck, idParts[4]].join('/');
      maps.set(trip.jobId, job);
      maps.set(trip.id, job.replace(/\//g, '-'));
      if (trip.jobKey) maps.set(trip.jobKey, job.split('/').slice(0,4).join('/'));
      continue;
    }
    if (!/^D\d{3}$/.test(driverFromKey) || !/^T\d{3}$/.test(truckFromKey)) {
      issues.push({ collection: 'deliveryOrders', id: trip.id, reason: 'NON_CANONICAL_JOB_REFERENCE' });
      continue;
    }
    if (trip.driverId !== driverFromKey) maps.set(trip.driverId, driverFromKey);
    if (trip.vehicleId !== truckFromKey) maps.set(trip.vehicleId, truckFromKey);
    const parts = idParts;
    const driver = maps.get(trip.driverId) || driverFromKey;
    const truck = maps.get(trip.vehicleId) || truckFromKey;
    if (!/^D\d+$/.test(driver) || !/^T\d+$/.test(truck)) throw Error('Unresolved fleet reference on ' + trip.id);
    const job = [parts[0], parts[1], driver, truck, parts[4]].join('/');
    maps.set(trip.jobId, job);
    maps.set(trip.id, job.replace(/\//g, '-'));
    if (trip.jobKey) maps.set(trip.jobKey, job.split('/').slice(0,4).join('/'));
  }
  const replace = value => {
    if (typeof value === 'string') {
      if (maps.has(value)) return maps.get(value);
      for (const [from,to] of maps) if (from.includes('/') && value.startsWith(from + '/')) return to + value.slice(from.length);
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,replace(item)]));
    return value;
  };
  for (const [collection, rows] of Object.entries(state)) for (const before of rows) {
    const id = maps.get(before.id) || before.id;
    let after = replace({ ...before, ...patches.get(collection + '/' + before.id) });
    if (collection === 'counters' && before.id === 'auto_ids') after = counters;
    if (JSON.stringify(before) !== JSON.stringify(after) || id !== before.id) {
      if (id !== before.id && rows.some(row => row.id === id)) throw Error('Target already exists: ' + collection + '/' + id);
      changes.push({ collection, from: before.id, id, before, after: { ...after, id } });
    }
  }
  for (const collection of Object.keys(state)) {
    const targets = changes.filter(row => row.collection === collection).map(row => row.id);
    if (new Set(targets).size !== targets.length) throw Error('Duplicate target in ' + collection);
  }
  if (!state.counters?.some(row => row.id === 'auto_ids')) changes.push({ collection: 'counters', from: 'auto_ids', id: 'auto_ids', before: null, after: { ...counters, id: 'auto_ids' } });
  return { changes, mappings: Object.fromEntries(maps), issues };
}
module.exports = { planNumbering };

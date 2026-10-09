const { createHash } = require('node:crypto');
const { captureTime } = require('./processor');
const text = value => String(value ?? '').trim();
const normalize = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
const plate = value => normalize(value).replace(/[\s-]/g, '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const closed = new Set(['COMPLETED', 'COMPLETE', 'DELIVERED', 'FULFILLED', 'CLOSED', 'CANCELLED', 'CANCELED', 'ARCHIVED', 'EXCESS', 'OVERDELIVERED', 'OVER_DELIVERED']);
const collections = ['vehicles', 'drivers', 'vendors', 'materials', 'sites', 'purchaseOrders'];

function parseCapture(event, config) {
  const row = JSON.parse(event.payload);
  if (!['KAYITLAR', 'ICERIDEKI_ARACLAR'].includes(event.table_name)) fail('INVALID_CAPTURE_TABLE');
  const registration = plate(row.PLAKA);
  if (!registration || !/^[\p{L}\p{N}]+$/u.test(registration)) fail('PLATE_REQUIRED');
  const firstAt = captureTime(row, 1, config.utcOffset);
  if (firstAt.startsWith('1899-12-30')) fail('INVALID_CAPTURE_TIME');
  const complete = event.table_name === 'KAYITLAR';
  const tareKg = Number(row.TARTIM1);
  const grossKg = complete ? Number(row.TARTIM2) : null;
  if (!Number.isFinite(tareKg) || tareKg <= 0 || (complete && (!Number.isFinite(grossKg) || grossKg < tareKg))) fail('INVALID_LOADING_WEIGHT');
  const secondAt = complete ? captureTime(row, 2, config.utcOffset) : null;
  if (secondAt && (secondAt.startsWith('1899-12-30') || secondAt < firstAt)) fail('INVALID_CAPTURE_CHRONOLOGY');
  const computed = complete ? Math.round((grossKg - tareKg) * 1000) / 1000 : null;
  const supplied = row.NET == null || row.NET === '' ? computed : Number(row.NET);
  if (complete && (!Number.isFinite(supplied) || supplied < 0 || Math.abs(supplied - computed) > 0.001)) fail('NET_WEIGHT_MISMATCH');
  return { row, registration, firstAt, secondAt, tareKg, grossKg, netKg: complete ? supplied : null,
    complete, date: text(row.TARIH1).slice(0, 10), key: hash([config.sourceId, registration, firstAt]) };
}

// Stable IDs make provisioning safe across retries and process restarts.
// Existing names are matched before creating anything; IDs break ties consistently.
function resolveEntities(data, row, config) {
  const planned = [];
  const select = (collection, value, fields, defaults, scope = '') => {
    const normalized = normalize(value);
    const matches = data[collection].filter(item => fields.some(field =>
      (collection === 'vehicles' ? plate(item[field]) === plate(value) : normalize(item[field]) === normalized)));
    matches.sort((a, b) => {
      const vendorPreference = Number(b.vendorId === scope && !!scope) - Number(a.vendorId === scope && !!scope);
      return vendorPreference || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
    });
    if (matches.length) return matches[0];
    const id = collection === 'vehicles' ? `AB-${plate(value)}` : `AB-${hash([collection, normalized, scope]).slice(0, 24)}`;
    const record = { ...defaults, id, bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId };
    planned.push({ collection, record });
    return record;
  };
  const vendorName = text(row.FIRMA_ADI) || `Unspecified vendor (${config.sourceId})`;
  const vendor = select('vendors', vendorName, ['name', 'companyName', 'vendorName'], { name: vendorName, companyName: vendorName, status: 'active' });
  const vehicle = select('vehicles', plate(row.PLAKA), ['registrationNumber', 'plateNumber'],
    { plateNumber: plate(row.PLAKA), registrationNumber: plate(row.PLAKA), vendorId: vendor.id, status: 'active' });
  const driverName = text(row[config.driverField || 'DIGER3_ISIM']);
  if (!driverName) fail('DRIVER_NAME_REQUIRED');
  const driver = select('drivers', driverName, ['id', 'nationalId', 'licenseNumber', 'name', 'fullName'],
    { name: driverName, fullName: driverName, vendorId: vendor.id, status: 'active', registrationIncomplete: true }, vendor.id);
  const materialName = text(row.MALZEME_ADI || row.MALZEME_KODU) || 'Unspecified material';
  const materialMatch = data.materials.filter(item =>
    (text(row.MALZEME_KODU) && [item.id, item.code, item.materialCode].some(v => normalize(v) === normalize(row.MALZEME_KODU)))
    || [item.name, item.materialName].some(v => normalize(v) === normalize(materialName)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  const material = materialMatch || select('materials', materialName, ['name', 'materialName'],
    { name: materialName, materialName, code: text(row.MALZEME_KODU), unit: 'kg' });
  const siteName = text(row.DIGER2_ISIM) || `Unspecified site (${config.sourceId})`;
  const site = select('sites', siteName, ['id', 'name', 'siteName'], { name: siteName, siteName, weighbridgeWeightUnit: 'kg' });
  const reference = normalize(row[config.poField || 'DIGER5_ISIM']);
  const orders = data.purchaseOrders.filter(order => !closed.has(normalize(order.status)) && !order.isWarehouseDelivery
    && (reference ? [order.id, order.poNumber].some(v => normalize(v) === reference)
      : (order.vendorId === vendor.id || [order.vendorName, order.companyName].some(v => normalize(v) === normalize(vendorName)))
        && (order.siteId === site.id || normalize(order.siteName) === normalize(siteName))
        && (order.materialId === material.id || normalize(order.materialName) === normalize(materialName))));
  orders.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Only associate an existing, unambiguous open PO. Never create orders.
  const order = orders.length === 1 ? orders[0] : null;
  return { planned, truckId: vehicle.id, driverId: driver.id, vendorId: vendor.id,
    materialId: material.id, siteId: site.id, purchaseOrderId: order?.id || null,
    poResolution: order ? 'matched' : orders.length > 1 ? 'ambiguous' : 'unmatched' };
}

function createLoadingProcessor({ db, config, logger = console }) {
  let registry;
  const tickets = db.collection('accessBridgeTickets');
  async function loadRegistry() {
    if (!registry) registry = Promise.all(collections.map(async name => {
      const snapshot = await db.collection(name).get();
      return [name, snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }))];
    })).then(entries => Object.fromEntries(entries));
    return registry;
  }
  const process = async event => {
    if (['LEFT_WAITING', 'NO_LONGER_PRESENT'].includes(event.event_type)) return { status: 'ignored', reason: event.event_type };
    const capture = parseCapture(event, config);
    const { row, key, registration, date, firstAt, secondAt, tareKg, grossKg, netKg, complete } = capture;
    const data = await loadRegistry();
    const entities = resolveEntities(data, row, config);
    const ticketNumber = complete ? String(Number(row.KAYIT_NO)) : null;
    if (complete && (!Number.isSafeInteger(Number(ticketNumber)) || Number(ticketNumber) < 1)) fail('INVALID_RECORD_NUMBER');
    const ticketIndex = db.collection('accessBridgeTicketNumbers').doc(hash([config.sourceId, ticketNumber || key]));
    const result = await db.runTransaction(async tx => {
      const index = complete ? await tx.get(ticketIndex) : null;
      let ref = tickets.doc(index?.data()?.ticketId || key);
      let existing = await tx.get(ref);
      // A completed row may correct the first time. Only one yard candidate may match.
      if (!existing.exists && complete) {
        const candidates = await tx.get(tickets.where('sourceId', '==', config.sourceId).where('plateDate', '==', `${registration}|${date}`).where('status', '==', 'in_yard'));
        if (candidates.docs.length > 1) fail('AMBIGUOUS_YARD_CAPTURE');
        if (candidates.docs.length === 1) { existing = candidates.docs[0]; ref = tickets.doc(existing.id); }
      }
      const previous = existing.data();
      if (previous && (previous.plateNumber !== registration || previous.sourceId !== config.sourceId || previous.plateDate !== `${registration}|${date}`)) fail('CAPTURE_PLATE_MISMATCH');
      if (previous?.status === 'completed' && !complete) return { ...previous, ticketId: ref.id, duplicate: true };
      if (previous && previous.tareKg !== tareKg) fail('FIRST_WEIGHT_CHANGED');
      if (previous?.status === 'completed' && (previous.grossKg !== grossKg || previous.netKg !== netKg || previous.ticketNumber !== ticketNumber)) fail('COMPLETED_TICKET_CONFLICT');
      const contentHash = hash([registration, firstAt, secondAt, tareKg, grossKg, netKg, ticketNumber,
        row.FIRMA_ADI, row.DIGER3_ISIM, row.DIGER1_ISIM, row.DIGER2_ISIM, row.DIGER4_ISIM, row.MALZEME_ADI, row.MALZEME_KODU, row.OPERATOR_ADI]);
      if (previous?.contentHash === contentHash) return { ...previous, ticketId: ref.id, duplicate: true };
      const reservationRef = db.collection('vehicleRegistrations').doc(registration);
      const reservation = await tx.get(reservationRef);
      const truckId = reservation.data()?.vehicleId || entities.truckId;
      if (truckId !== entities.truckId) {
        const registered = await tx.get(db.collection('vehicles').doc(truckId));
        if (!registered.exists || plate(registered.data().registrationNumber || registered.data().plateNumber) !== registration) fail('VEHICLE_REGISTRATION_CONFLICT');
      }
      const toCreate = entities.planned.filter(item => item.collection !== 'vehicles' || item.record.id === truckId);
      const refs = toCreate.map(item => db.collection(item.collection).doc(item.record.id));
      const docs = refs.length ? (tx.getAll ? await tx.getAll(...refs) : await Promise.all(refs.map(r => tx.get(r)))) : [];
      const now = new Date().toISOString();
      for (let i = 0; i < refs.length; i++) if (!docs[i].exists) tx.set(refs[i], { ...toCreate[i].record, createdAt: now });
      if (!reservation.exists) tx.set(reservationRef, { vehicleId: truckId, registrationNumber: registration, createdAt: now });
      const { planned, ...links } = entities;
      const record = { ...links, truckId, sourceId: config.sourceId, plateNumber: registration, plateDate: `${registration}|${date}`,
        firstAt: previous?.firstAt || firstAt, secondAt, tareKg, grossKg, netKg, weightUnit: 'kg',
        ticketNumber, status: complete ? 'completed' : 'in_yard', contentHash,
        vendorName: text(row.FIRMA_ADI), driverName: text(row[config.driverField || 'DIGER3_ISIM']),
        loadingPoint: text(row.DIGER1_ISIM), siteName: text(row.DIGER2_ISIM),
        deliveryNote: text(row.DIGER4_ISIM), materialName: text(row.MALZEME_ADI), materialCode: text(row.MALZEME_KODU),
        operatorName: text(row.OPERATOR_ADI), createdAt: previous?.createdAt || now, updatedAt: now };
      tx.set(ref, record);
      if (complete && !index.exists) tx.set(ticketIndex, { ticketId: ref.id, sourceId: config.sourceId, ticketNumber });
      return { ...record, ticketId: ref.id, duplicate: false };
    });
    // Keep subsequent records in this worker batch aware of newly created entities.
    for (const item of entities.planned) if ((item.collection !== 'vehicles' || item.record.id === result.truckId)
      && !data[item.collection].some(v => v.id === item.record.id)) data[item.collection].push(item.record);
    const outcome = { status: 'processed', ticketId: result.ticketId, ticketStatus: result.status,
      truckId: result.truckId, driverId: result.driverId, purchaseOrderId: result.purchaseOrderId, poResolution: result.poResolution, duplicate: result.duplicate };
    logger.log('[Access bridge] resolution:', JSON.stringify({ sourceId: config.sourceId, eventId: event.id || null, plate: registration, ...outcome }));
    return outcome;
  };
  process.resetBatch = () => { registry = null; };
  return process;
}
module.exports = { createLoadingProcessor, parseCapture, resolveEntities };

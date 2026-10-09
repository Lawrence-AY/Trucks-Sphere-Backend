const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoadingProcessor, parseCapture, resolveEntities } = require('../src/integrations/access-bridge/loading');
const { createStore, recordKey } = require('../src/integrations/access-bridge/store');
const { readConfig } = require('../src/integrations/access-bridge/config');
const config = { sourceId: 'Tunaylar-WinScale', utcOffset: '+03:00' };
const yard = { PLAKA: 'KCB292D', TARTIM1: 150, TARIH1: '2026-10-09T00:00:00', SAAT1: '1899-12-30T14:32:07',
  FIRMA_ADI: 'WALACE WASONGA OWILI', MALZEME_ADI: 'MURRAM', DIGER1_ISIM: 'HINDI', DIGER2_ISIM: 'MANDA BAY',
  DIGER3_ISIM: 'FRANK OCEAN', DIGER4_ISIM: 'TEST 1', OPERATOR_ADI: 'RELYANT' };
const completed = { ...yard, KAYIT_NO: 42, TARTIM2: 1150, NET: 1000, TARIH2: '2026-10-09T00:00:00', SAAT2: '1899-12-30T15:00:00' };
const event = row => ({ payload: JSON.stringify(row), table_name: row.KAYIT_NO ? 'KAYITLAR' : 'ICERIDEKI_ARACLAR', event_type: 'BASELINE' });

function fixture() {
  const data = new Map(), scans = {}, logs = [];
  let reads = 0, writes = 0, serial = Promise.resolve();
  const snapshot = path => ({ id: path.split('/').at(-1), exists: data.has(path), data: () => structuredClone(data.get(path)) });
  const ref = path => ({ path, id: path.split('/').at(-1), collection: name => collection(`${path}/${name}`), get: async () => { reads++; return snapshot(path); } });
  function collection(name, filters = []) {
    return { doc: id => ref(`${name}/${id}`), where: (field, op, value) => { assert.equal(op, '=='); return collection(name, [...filters, [field, value]]); },
      async get() {
        reads++; scans[name] = (scans[name] || 0) + 1;
        return { docs: [...data.keys()].filter(key => key.startsWith(`${name}/`) && key.split('/').length === name.split('/').length + 1
          && filters.every(([field, value]) => data.get(key)[field] === value)).map(snapshot) };
      } };
  }
  const db = { collection, runTransaction(fn) {
    const work = serial.then(async () => {
      const pending = [];
      const tx = { get: async ref => { assert.equal(pending.length, 0, 'All reads precede writes'); return ref.get(); },
        getAll: (...refs) => Promise.all(refs.map(ref => tx.get(ref))),
        set: (ref, value) => pending.push([ref.path, structuredClone(value)]) };
      const result = await fn(tx);
      for (const [key, value] of pending) { data.set(key, value); writes++; }
      return result;
    });
    serial = work.catch(() => {});
    return work;
  } };
  const make = () => createLoadingProcessor({ db, config, logger: { log: (...args) => logs.push(args) } });
  return { db, data, scans, logs, process: make(), make, get reads() { return reads; }, get writes() { return writes; } };
}

test('sample yard capture provisions mapped entities and promotes the same kg ticket', async () => {
  const f = fixture();
  const first = await f.process(event(yard));
  assert.equal(first.status, 'processed');
  assert.equal(first.truckId, 'AB-KCB292D');
  const ticket = f.data.get(`accessBridgeTickets/${first.ticketId}`);
  assert.equal(ticket.status, 'in_yard');
  assert.equal(ticket.tareKg, 150);
  assert.equal(ticket.firstAt, '2026-10-09T11:32:07.000Z');
  assert.equal(ticket.driverName, 'FRANK OCEAN');
  assert.equal(ticket.vendorName, yard.FIRMA_ADI);
  assert.equal(ticket.loadingPoint, 'HINDI');
  assert.equal(ticket.siteName, 'MANDA BAY');
  assert.equal(ticket.deliveryNote, 'TEST 1');
  assert.equal(f.data.get(`drivers/${first.driverId}`).name, 'FRANK OCEAN');
  assert.equal(first.purchaseOrderId, null);
  assert.equal(first.poResolution, 'unmatched');
  assert.equal([...f.data.keys()].some(key => key.startsWith('purchaseOrders/')), false);
  const final = await f.process(event(completed));
  assert.equal(final.ticketId, first.ticketId);
  const full = f.data.get(`accessBridgeTickets/${final.ticketId}`);
  assert.equal(full.status, 'completed');
  assert.equal(full.netKg, 1000);
  assert.equal(full.grossKg, 1150);
  assert.equal(full.ticketNumber, '42');
  assert.equal(full.secondAt, '2026-10-09T12:00:00.000Z');
  assert.equal(full.weightUnit, 'kg');
  assert.equal(f.data.get('vehicleRegistrations/KCB292D').vehicleId, first.truckId);
  assert.equal(f.logs.length, 2);
});

test('replay, restart and concurrent workers never duplicate tickets or writes', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.process(event(completed)), f.make()(event(completed))]);
  assert.equal(a.ticketId, b.ticketId);
  const writes = f.writes;
  const again = await f.make()(event(completed));
  assert.equal(again.duplicate, true);
  assert.equal(f.writes, writes);
  await f.make()(event(yard));
  assert.equal(f.writes, writes);
  assert.equal([...f.data.keys()].filter(k => k.startsWith('accessBridgeTickets/')).length, 1);
});

test('one registry scan per collection per processing batch, with reset between batches', async () => {
  const f = fixture();
  await f.process(event(yard));
  await f.process(event({ ...yard, PLAKA: 'KCB293D' }));
  for (const name of ['vehicles', 'drivers', 'vendors', 'materials', 'sites', 'purchaseOrders']) assert.equal(f.scans[name], 1);
  f.process.resetBatch();
  await f.process(event(yard));
  assert.equal(f.scans.drivers, 2);
});

test('same plate/date promotes a unique yard ticket when completed first time was corrected', async () => {
  const f = fixture();
  const a = await f.process(event(yard));
  const b = await f.process(event({ ...completed, SAAT1: '1899-12-30T14:32:10' }));
  assert.equal(a.ticketId, b.ticketId);
  const writes = f.writes;
  await f.make()(event({ ...completed, SAAT1: '1899-12-30T14:32:10' }));
  assert.equal(f.writes, writes);
});

test('multiple trips on one day remain separate and ambiguous date-only matching is held', async () => {
  const f = fixture();
  await f.process(event(yard));
  const later = { ...yard, SAAT1: '1899-12-30T14:35:00' };
  await f.process(event(later));
  const writes = f.writes;
  await assert.rejects(f.process(event({ ...completed, SAAT1: '1899-12-30T14:34:00' })), { code: 'AMBIGUOUS_YARD_CAPTURE' });
  assert.equal(f.writes, writes);
  const done = await f.process(event(completed));
  assert.equal(done.ticketStatus, 'completed');
  assert.equal([...f.data.keys()].filter(k => k.startsWith('accessBridgeTickets/')).length, 2);
});

test('driver name matching is case-insensitive with stable vendor then ID tie breaking', () => {
  const data = { vehicles: [], drivers: [{ id: 'D2', name: 'frank ocean', vendorId: 'V1' }, { id: 'D1', name: 'FRANK OCEAN', vendorId: 'V1' }, { id: 'D0', name: 'Frank Ocean', vendorId: 'V2' }],
    vendors: [{ id: 'V1', name: yard.FIRMA_ADI }], materials: [], sites: [], purchaseOrders: [] };
  assert.equal(resolveEntities(data, yard, config).driverId, 'D1');
  data.drivers.reverse();
  assert.equal(resolveEntities(data, { ...yard, DIGER3_ISIM: '  frank   ocean ' }, config).driverId, 'D1');
});

test('existing open PO and material code are resolved; closed PO stays unlinked', () => {
  const data = { vehicles: [], drivers: [], vendors: [], sites: [], materials: [{ id: 'M1', code: 'MU', name: 'Murram' }],
    purchaseOrders: [{ id: 'P1', poNumber: 'PO-ONE', status: 'open' }] };
  const result = resolveEntities(data, { ...yard, MALZEME_KODU: 'mu', DIGER5_ISIM: 'po-one' }, config);
  assert.equal(result.materialId, 'M1');
  assert.equal(result.purchaseOrderId, 'P1');
  data.purchaseOrders[0].status = 'closed';
  const unmatched = resolveEntities(data, { ...yard, DIGER5_ISIM: 'PO-ONE' }, config);
  assert.equal(unmatched.purchaseOrderId, null);
  assert.equal(unmatched.planned.some(item => item.collection === 'purchaseOrders'), false);
});

test('invalid dates, empty drivers, inverted loading weights and inconsistent NET write nothing', async () => {
  for (const patch of [{ TARIH1: '1899-12-30' }, { TARIH1: '2026-02-30' }, { SAAT1: '25:00:00' }, { DIGER3_ISIM: '' }, { TARTIM2: 100 }, { NET: 500 }]) {
    const f = fixture();
    await assert.rejects(f.process(event({ ...completed, ...patch })));
    assert.equal(f.writes, 0);
  }
  assert.equal(parseCapture(event({ ...completed, NET: undefined }), config).netKg, 1000);
});

test('ambiguous existing POs are left unlinked and neither PO nor site orders are written', async () => {
  const f = fixture();
  for (const id of ['P1', 'P2']) f.data.set(`purchaseOrders/${id}`, {
    id, status: 'open', vendorName: yard.FIRMA_ADI, siteName: yard.DIGER2_ISIM, materialName: yard.MALZEME_ADI });
  const before = JSON.stringify([...f.data]);
  const outcome = await f.process(event(yard));
  assert.equal(outcome.purchaseOrderId, null);
  assert.equal(outcome.poResolution, 'ambiguous');
  assert.equal(JSON.stringify([...f.data].filter(([key]) => key.startsWith('purchaseOrders/'))), before);
  assert.equal([...f.data.keys()].some(key => key.startsWith('deliveryOrders/')), false);
});

test('a unique open PO matches captured names even if registry IDs have not been populated', async () => {
  const f = fixture();
  f.data.set('purchaseOrders/P1', { status: 'open', vendorName: yard.FIRMA_ADI, siteName: yard.DIGER2_ISIM, materialName: 'murram' });
  assert.equal((await f.process(event(yard))).purchaseOrderId, 'P1');
});

test('completed ticket numbers cannot move to another plate/date or change saved weights', async () => {
  const f = fixture();
  await f.process(event(completed));
  const before = f.writes;
  await assert.rejects(f.process(event({ ...completed, PLAKA: 'OTHER' })), { code: 'CAPTURE_PLATE_MISMATCH' });
  await assert.rejects(f.process(event({ ...completed, TARTIM2: 1250, NET: 1100 })), { code: 'COMPLETED_TICKET_CONFLICT' });
  assert.equal(f.writes, before);
});

test('both empty heartbeat variants perform zero Firestore operations', async () => {
  const f = fixture();
  const store = createStore(f.db, config.sourceId);
  for (let i = 0; i < 20; i++) await store.observe([], true);
  await store.observe([], false);
  assert.equal(f.reads, 0);
  assert.equal(f.writes, 0);
});

test('yard idempotency normalizes Access time formats, plate spacing and date-only forms', () => {
  assert.equal(recordKey('ICERIDEKI_ARACLAR', yard), recordKey('ICERIDEKI_ARACLAR', {
    ...yard, PLAKA: 'kcb 292-d', TARIH1: '2026-10-09', SAAT1: '14:32:07' }));
  assert.equal(recordKey('KAYITLAR', { KAYIT_NO: '0042' }), '42');
  assert.equal(readConfig({}).weighingMode, 'loading');
});

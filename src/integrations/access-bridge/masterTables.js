const { createHash } = require('node:crypto');
const { matchVendor } = require('../../utils/vendorMatching');
const vendorsService = require('../../modules/vendors/service');

const MASTER_TABLES = new Set(['FIRMALAR', 'DIGER3', 'TANIMLI_ARACLAR']);
const text = value => String(value ?? '').trim();
const normalize = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
const plate = value => normalize(value).replace(/[\s-]/g, '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createMasterTableProcessor({ db, config }) {
  const all = async collection => {
    const snapshot = await db.collection(collection).get();
    return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  };
  const merge = (collection, id, data) => db.collection(collection).doc(id).set(data, { merge: true });
  const stamp = { bridgeSourceId: config.sourceId, bridgeSyncedAt: new Date().toISOString() };

  async function vendor(row) {
    const name = text(row.FIRMA_ADI);
    if (!name) return { status: 'ignored', reason: 'EMPTY_VENDOR_NAME' };
    const result = matchVendor(name, await all('vendors'), { ...(config.vendorMatching || {}), aliases: await all('vendorAliases') });
    if (result.match) {
      await merge('vendors', result.match.id, { ...stamp, ...(!result.match.address && text(row.ADRES) ? { address: text(row.ADRES) } : {}), ...(!result.match.phone && text(row.TEL) ? { phone: text(row.TEL) } : {}) });
      return { status: 'processed', vendorId: result.match.id, method: result.method, vendorName: name };
    }
    try {
      const created = await vendorsService.create({ companyName: name, name, address: text(row.ADRES), phone: text(row.TEL), fax: text(row.FAX), bridgeCreated: true, sourceId: config.sourceId });
      return { status: 'processed', vendorId: created.id, method: 'created', vendorName: name };
    } catch (error) { return { status: 'blocked', reason: error.code || error.message, vendorName: name }; }
  }

  async function driver(row) {
    const name = normalize(row.DIGER3_ISIM);
    if (!name) return { status: 'ignored', reason: 'EMPTY_DRIVER_NAME' };
    const existing = (await all('drivers')).find(item => [item.name, item.fullName].some(value => normalize(value) === name));
    if (existing) { await merge('drivers', existing.id, stamp); return { status: 'processed', driverId: existing.id }; }
    const id = `AB-${hash([config.sourceId, 'driver', name]).slice(0, 24)}`;
    await db.collection('drivers').doc(id).set({ id, name: text(row.DIGER3_ISIM), fullName: text(row.DIGER3_ISIM), status: 'active', registrationIncomplete: true, bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId, createdAt: new Date().toISOString() });
    return { status: 'processed', driverId: id };
  }

  async function vehicle(row) {
    const registration = plate(row.PLAKA);
    if (!registration) return { status: 'ignored', reason: 'EMPTY_PLATE' };
    const existing = (await all('vehicles')).find(item => plate(item.registrationNumber || item.plateNumber) === registration);
    if (existing) { await merge('vehicles', existing.id, stamp); return { status: 'processed', vehicleId: existing.id, plate: registration }; }
    const id = `AB-${registration}`;
    await db.collection('vehicles').doc(id).set({ id, plateNumber: registration, registrationNumber: registration, status: 'active', bridgeCreated: true, createdBy: 'access_bridge', sourceId: config.sourceId, createdAt: new Date().toISOString() });
    return { status: 'processed', vehicleId: id, plate: registration };
  }

  return async event => {
    if (event.table_name === 'FIRMALAR') return vendor(JSON.parse(event.payload));
    if (event.table_name === 'DIGER3') return driver(JSON.parse(event.payload));
    if (event.table_name === 'TANIMLI_ARACLAR') return vehicle(JSON.parse(event.payload));
    return { status: 'ignored', reason: 'UNKNOWN_MASTER_TABLE' };
  };
}

module.exports = { MASTER_TABLES, createMasterTableProcessor };

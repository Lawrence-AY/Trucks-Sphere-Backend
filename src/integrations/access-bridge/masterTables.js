const { getNextId } = require('../../utils/counterService');
const { matchVendor } = require('../../utils/vendorMatching');
const { similarity } = require('../../utils/vendorMatching');
const vendorsService = require('../../modules/vendors/service');

const MASTER_TABLES = new Set(['FIRMALAR', 'DIGER3', 'TANIMLI_ARACLAR']);
const text = value => String(value ?? '').trim();
const normalize = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').toUpperCase();
const plate = value => normalize(value).replace(/[\s-]/g, '');

function createMasterTableProcessor({ db, config, nextId = getNextId }) {
  const all = async collection => {
    const snapshot = await db.collection(collection).get();
    return snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  };
  const merge = (collection, id, data) => db.collection(collection).doc(id).set(data, { merge: true });
  const stamp = { bridgeSourceId: config.sourceId, bridgeSyncedAt: new Date().toISOString() };
  async function inferVendorId(driverId, driverName) {
    const orders = await all('deliveryOrders');
    const matches = orders.filter(order =>
      (driverId && order.driverId === driverId) ||
      (driverName && [order.driverName, order.driverFullName].some(value => normalize(value) === normalize(driverName))),
    );
    const ids = [...new Set(matches.map(order => order.vendorId).filter(Boolean))];
    return ids.length === 1 ? ids[0] : '';
  }

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
    const originalName = text(row.DIGER3_ISIM);
    const vendorName = text(row.FIRMA_ADI || row.VENDOR || row.vendorName);
    const vendorResult = vendorName
      ? matchVendor(vendorName, await all('vendors'), { ...(config.vendorMatching || {}), aliases: await all('vendorAliases') })
      : null;
    const drivers = await all('drivers');
    const aliases = await all('driverAliases');
    const alias = aliases.find(item => normalize(item.alias || item.aliasNormalized) === normalize(originalName));
    const exact = alias ? drivers.find(item => item.id === alias.driverId) : drivers.find(item => [item.name, item.fullName].some(value => normalize(value) === name));
    const ranked = drivers.map(item => ({ item, score: Math.max(similarity(item.name, originalName), similarity(item.fullName, originalName)) })).sort((a, b) => b.score - a.score);
    const threshold = Number(config.driverMatching?.autoMatchThreshold || 0.92);
    const result = exact ? { match: exact, method: alias ? 'alias' : 'normalized', score: 1 } : ranked[0]?.score >= threshold && (!ranked[1] || ranked[0].score - ranked[1].score >= Number(config.driverMatching?.ambiguityMargin || 0.05)) ? { match: ranked[0].item, method: 'fuzzy', score: ranked[0].score } : { match: null, candidates: ranked.slice(0, 5).map(item => ({ driverId: item.item.id, name: item.item.name, score: item.score })) };
    // DIGER3 is the authoritative Access master table. A new driver listed
    // there may be provisioned; transactional captures themselves never use
    // this fallback and remain reviewable when unmatched.
    if (!result.match) {
      const id = await nextId('driver');
      const vendorId = vendorResult?.match?.id || await inferVendorId('', originalName);
      await db.collection('drivers').doc(id).set({ id, name: originalName, fullName: originalName, driverCode: id, driverNumber: id, vendorId, vendorIds: vendorId ? [vendorId] : [], status: 'active', registrationIncomplete: true, bridgeCreated: true, createdBy: 'access_bridge_master', sourceId: config.sourceId, createdAt: new Date().toISOString() });
      return { status: 'processed', driverId: id, method: 'master_created' };
    }
    const updates = { ...stamp, bridgeDriverResolution: { method: result.method, score: result.score, originalName: text(row.DIGER3_ISIM) } };
    const inferredVendorId = vendorResult?.match?.id || await inferVendorId(result.match.id, originalName);
    if (inferredVendorId && (!result.match.vendorId || !Array.isArray(result.match.vendorIds) || !result.match.vendorIds.includes(inferredVendorId))) {
      updates.vendorId = inferredVendorId;
      updates.vendorIds = Array.from(new Set([...(result.match.vendorIds || []), inferredVendorId]));
    }
    if (!result.match.driverCode) updates.driverCode = result.match.driverNumber || result.match.id;
    if (!result.match.driverNumber) updates.driverNumber = result.match.driverCode || result.match.id;
    await merge('drivers', result.match.id, updates);
    return { status: 'processed', driverId: result.match.id, method: result.method };
  }

  async function vehicle(row) {
    const registration = plate(row.PLAKA);
    if (!registration) return { status: 'ignored', reason: 'EMPTY_PLATE' };
    const existing = (await all('vehicles')).find(item => plate(item.registrationNumber || item.plateNumber) === registration);
    if (existing) { await merge('vehicles', existing.id, stamp); return { status: 'processed', vehicleId: existing.id, plate: registration }; }
    const id = await nextId('truck');
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

async function repairBridgeDrivers({ db, nextId = getNextId, logger = console } = {}) {
  const [driversSnap, ordersSnap] = await Promise.all([
    db.collection('drivers').get(),
    db.collection('deliveryOrders').get(),
  ]);
  const orders = ordersSnap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  let repaired = 0;
  for (const doc of driversSnap.docs) {
    const driver = { ...doc.data(), id: doc.id };
    if (!driver.bridgeCreated && driver.createdBy !== 'access_bridge') continue;
    const matches = orders.filter(order =>
      (order.driverId && order.driverId === driver.id) ||
      [order.driverName, order.driverFullName].some(value => normalize(value) === normalize(driver.name || driver.fullName)),
    );
    const vendorIds = [...new Set(matches.map(order => order.vendorId).filter(Boolean))];
    const patch = {};
    if (!driver.driverCode && !driver.driverNumber) {
      const code = await nextId('driver');
      patch.driverCode = code;
      patch.driverNumber = code;
    } else if (!driver.driverCode) patch.driverCode = driver.driverNumber;
    else if (!driver.driverNumber) patch.driverNumber = driver.driverCode;
    if (!driver.vendorId && vendorIds.length === 1) {
      patch.vendorId = vendorIds[0];
      patch.vendorIds = Array.from(new Set([...(driver.vendorIds || []), vendorIds[0]]));
    }
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date().toISOString();
      // Bridge-created AB IDs were provisional. Migrate them to the assigned
      // D### ID and rewrite every persisted reference before deleting the old
      // document, so existing jobs and fuel history remain connected.
      if (doc.id.startsWith('AB-') && patch.driverCode && patch.driverCode.startsWith('D')) {
        const newId = patch.driverCode;
        const newRef = db.collection('drivers').doc(newId);
        const existingNew = await newRef.get();
        if (!existingNew.exists) await newRef.set({ ...driver, ...patch, id: newId });
        for (const collection of ['deliveryOrders', 'fuelRecords', 'fuelAuthorizations', 'driverAliases']) {
          const refs = await db.collection(collection).where('driverId', '==', doc.id).get();
          let batch = db.batch();
          let count = 0;
          for (const ref of refs.docs) {
            batch.update(ref.ref, { driverId: newId, updatedAt: new Date().toISOString() });
            count += 1;
            if (count === 450) { await batch.commit(); batch = db.batch(); count = 0; }
          }
          if (count) await batch.commit();
        }
        await doc.ref.delete();
      } else {
        await doc.ref.set(patch, { merge: true });
      }
      repaired += 1;
    }
  }
  logger.info(`[Access Bridge] repaired ${repaired} bridge driver record(s)`);
  return { repaired };
}

module.exports = { MASTER_TABLES, createMasterTableProcessor, repairBridgeDrivers };

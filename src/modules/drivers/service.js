const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const vendorsService = require('../vendors/service');
const { fetchOdooDrivers, odooDriverToDriver } = require('../../integrations/odooDriverService');
const collectionRef = db.collection('drivers');
const nationalIdRef = db.collection('driverNationalIds');

const COLLECTION_NAME = 'drivers';
let odooSyncJob = { status: 'idle', result: null, startedAt: null, completedAt: null };

function normalizeNationalId(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function omitUndefinedFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function duplicateNationalIdError() {
  return Object.assign(new Error('A driver with this National ID already exists.'), {
    statusCode: 409,
    code: 'DRIVER_NATIONAL_ID_EXISTS',
  });
}

function addUniqueIndex(index, key, value) {
  if (!key) return;
  index.set(key, index.has(key) ? null : value);
}

async function importOdooDrivers() {
  const odooDrivers = await fetchOdooDrivers();
  const driverVendorPartnerIds = [...new Set(odooDrivers
    .map((driver) => odooDriverToDriver(driver).odooVendorPartnerId)
    .filter(Number.isInteger))];
  // Refresh precisely the vendor Contacts referenced by drivers. Some Odoo
  // Vendor relations are not marked with supplier_rank, so a generic supplier
  // import alone would leave those drivers unassigned.
  const vendorSync = await vendorsService.importFromOdoo({ partnerIds: driverVendorPartnerIds });
  const [driverSnapshot, vendorSnapshot] = await Promise.all([
    collectionRef.get(),
    db.collection('vendors').get(),
  ]);
  const result = {
    total: odooDrivers.length,
    imported: 0,
    updatedFromOdoo: 0,
    skippedWithoutVendor: 0,
    skippedWithoutNationalId: 0,
    failed: 0,
    errors: [],
    vendorSync,
  };

  const vendorByOdooPartnerId = new Map();
  vendorSnapshot.docs.forEach((doc) => {
    const vendor = doc.data();
    if (Number.isInteger(vendor.odooPartnerId)) vendorByOdooPartnerId.set(vendor.odooPartnerId, doc);
  });

  const byOdooDriverId = new Map();
  const byNationalId = new Map();
  driverSnapshot.docs.forEach((doc) => {
    const driver = doc.data();
    if (Number.isInteger(driver.odooDriverId)) byOdooDriverId.set(driver.odooDriverId, doc);
    addUniqueIndex(byNationalId, normalizeNationalId(driver.nationalId), doc);
  });

  for (const odooDriver of odooDrivers) {
    const mapped = odooDriverToDriver(odooDriver);
    const vendorDoc = vendorByOdooPartnerId.get(mapped.odooVendorPartnerId);
    const normalizedNationalId = normalizeNationalId(mapped.nationalId);
    if (!vendorDoc) {
      result.skippedWithoutVendor += 1;
      continue;
    }
    if (!normalizedNationalId) {
      result.skippedWithoutNationalId += 1;
      continue;
    }

    try {
      const vendor = vendorDoc.data();
      const driverData = {
        ...mapped,
        nationalId: normalizedNationalId,
        vendorId: vendor.id || vendorDoc.id,
        vendorName: vendor.companyName || vendor.name || vendorDoc.id,
      };
      const existing = byOdooDriverId.get(mapped.odooDriverId) || byNationalId.get(normalizedNationalId);

      if (existing) {
        await driversService.update(existing.id, driverData);
        byOdooDriverId.set(mapped.odooDriverId, existing);
        addUniqueIndex(byNationalId, normalizedNationalId, existing);
        result.updatedFromOdoo += 1;
      } else {
        const created = await driversService.create(driverData);
        const ref = collectionRef.doc(created.id);
        const newDoc = { id: created.id, ref, data: () => created };
        byOdooDriverId.set(mapped.odooDriverId, newDoc);
        addUniqueIndex(byNationalId, normalizedNationalId, newDoc);
        result.imported += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.errors.push({ odooDriverId: mapped.odooDriverId || null, code: error.code || 'ODOO_DRIVER_SYNC_FAILED' });
      console.error(`[Odoo] Failed to synchronize driver ${mapped.odooDriverId || 'unknown'}: ${error.message}`);
    }
  }

  return result;
}

const driversService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   * This avoids composite index requirements and eliminates Firestore reads.
   */
  findAll(query = {}) {
    const { search, status, vendorId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (status) results = results.filter(item => item.status === status);
    if (vendorId) {
      results = results.filter(item => item.vendorId === vendorId);
    }
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(item =>
        (item.name || '').toLowerCase().includes(s) ||
        (item.phone || '').includes(s) ||
        (item.licenseNumber || '').toLowerCase().includes(s) ||
        (item.nationalId || '').includes(s) ||
        (item.insuranceNumber || '').toLowerCase().includes(s) ||
        (item.wibaProvider || '').toLowerCase().includes(s)
      );
    }

    const start = (page - 1) * parseInt(limit);
    return {
      data: results.slice(start, start + parseInt(limit)),
      total: results.length,
      page: parseInt(page),
      totalPages: Math.ceil(results.length / parseInt(limit)),
    };
  },

  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
  },

  async isNationalIdAvailable(nationalId, excludeId) {
    const normalized = normalizeNationalId(nationalId);
    if (!normalized) return false;

    const reservation = await nationalIdRef.doc(normalized).get();
    if (reservation.exists && reservation.data().driverId !== excludeId) return false;

    // Supports records created before the reservation collection was introduced.
    const existing = await collectionRef.where('nationalId', '==', normalized).limit(2).get();
    return existing.docs.every((doc) => doc.id === excludeId);
  },

  async create(data) {
    try {
      const normalizedNationalId = normalizeNationalId(data.nationalId);
      if (!normalizedNationalId) {
        throw Object.assign(new Error('National ID is required'), {
          statusCode: 400,
          code: 'NATIONAL_ID_REQUIRED',
        });
      }
      const driverId = await getNextId('driver');
      const docRef = collectionRef.doc(driverId);
      const item = omitUndefinedFields({
        ...data,
        id: driverId,
        status: data.status || 'active',
        nationalId: normalizedNationalId,
        nationalIdNormalized: normalizedNationalId,
        photoURL: data.photoURL || '',
        // WIBA (Worker Injury Benefit Act)
        wibaProvider: data.wibaProvider || '',
        wibaStartDate: data.wibaStartDate || '',
        wibaEndDate: data.wibaEndDate || '',
        // Insurance
        insuranceSupplier: data.insuranceSupplier || '',
        insuranceStartDate: data.insuranceStartDate || '',
        insuranceCompany: data.insuranceCompany || '',
        insuranceCommencingDate: data.insuranceCommencingDate || '',
        insuranceExpiryDate: data.insuranceExpiryDate || '',
        insuranceNumber: data.insuranceNumber || '',
        // NTSA
        ntsaInspectionExpiry: data.ntsaInspectionExpiry || '',
        totalTrips: data.totalTrips || 0,
        rating: data.rating || 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await db.runTransaction(async (transaction) => {
        const reservation = await transaction.get(nationalIdRef.doc(normalizedNationalId));
        if (reservation.exists) throw duplicateNationalIdError();

        // Check legacy driver records as well as the atomic reservation.
        const legacyMatch = await transaction.get(
          collectionRef.where('nationalId', '==', normalizedNationalId).limit(1),
        );
        if (!legacyMatch.empty) throw duplicateNationalIdError();

        transaction.set(docRef, item);
        transaction.set(nationalIdRef.doc(normalizedNationalId), {
          driverId,
          nationalId: normalizedNationalId,
          createdAt: item.createdAt,
        });
      });
      return { id: driverId, ...item };
    } catch (error) {
      console.error('driversService.create error:', error);
      throw error;
    }
  },

  async update(id, data) {
    try {
      const docRef = collectionRef.doc(id);
      let result = null;
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const current = doc.data();
        const currentNationalId = normalizeNationalId(current.nationalId);
        const hasNationalIdUpdate = Object.prototype.hasOwnProperty.call(data, 'nationalId');
        const nextNationalId = hasNationalIdUpdate
          ? normalizeNationalId(data.nationalId)
          : currentNationalId;
        if (!nextNationalId) {
          throw Object.assign(new Error('National ID is required'), {
            statusCode: 400,
            code: 'NATIONAL_ID_REQUIRED',
          });
        }

        if (nextNationalId !== currentNationalId) {
          const nextReservation = await transaction.get(nationalIdRef.doc(nextNationalId));
          if (nextReservation.exists && nextReservation.data().driverId !== id) throw duplicateNationalIdError();
          const legacyMatch = await transaction.get(collectionRef.where('nationalId', '==', nextNationalId).limit(1));
          if (!legacyMatch.empty && legacyMatch.docs[0].id !== id) throw duplicateNationalIdError();
          transaction.set(nationalIdRef.doc(nextNationalId), { driverId: id, nationalId: nextNationalId, createdAt: current.createdAt || new Date().toISOString() });
          if (currentNationalId) transaction.delete(nationalIdRef.doc(currentNationalId));
        } else if (nextNationalId) {
          // Backfill a reservation for older records when they are edited.
          transaction.set(nationalIdRef.doc(nextNationalId), { driverId: id, nationalId: nextNationalId, createdAt: current.createdAt || new Date().toISOString() }, { merge: true });
        }

        const updates = omitUndefinedFields({
          ...data,
          nationalId: nextNationalId,
          nationalIdNormalized: nextNationalId,
          updatedAt: new Date().toISOString(),
        });
        transaction.update(docRef, updates);
        result = { id, ...current, ...updates };
      });
      return result;
    } catch (error) {
      console.error('driversService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      const docRef = collectionRef.doc(id);
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const nationalId = normalizeNationalId(doc.data().nationalId);
        transaction.delete(docRef);
        if (nationalId) transaction.delete(nationalIdRef.doc(nationalId));
      });
    } catch (error) {
      console.error('driversService.delete error:', error);
      throw error;
    }
  },

  async importFromOdoo() {
    return importOdooDrivers();
  },

  startOdooSync() {
    if (odooSyncJob.status === 'running') return odooSyncJob;

    odooSyncJob = { status: 'running', result: null, startedAt: new Date().toISOString(), completedAt: null };
    void driversService.importFromOdoo()
      .then((result) => {
        odooSyncJob = { status: 'completed', result, startedAt: odooSyncJob.startedAt, completedAt: new Date().toISOString() };
      })
      .catch((error) => {
        console.error(`[Odoo] Driver sync failed: ${error.message}`);
        odooSyncJob = {
          status: 'failed',
          result: { code: error.code || 'ODOO_DRIVER_SYNC_FAILED' },
          startedAt: odooSyncJob.startedAt,
          completedAt: new Date().toISOString(),
        };
      });
    return odooSyncJob;
  },

  getOdooSyncStatus() {
    return odooSyncJob;
  },
};

module.exports = driversService;

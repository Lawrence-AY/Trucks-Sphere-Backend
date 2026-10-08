const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('vehicles');
const registrationRef = db.collection('vehicleRegistrations');
const girService = require('../../integrations/girService');

const COLLECTION_NAME = 'vehicles';

function normalizeRegistration(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function omitUndefinedFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function duplicateRegistrationError() {
  return Object.assign(new Error('Vehicle registration already exists'), {
    statusCode: 409,
    code: 'VEHICLE_REGISTRATION_EXISTS',
  });
}

const vehiclesService = {
  findAll(query = {}) {
    const { search, status, vendorId, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

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
        (item.plateNumber || '').toLowerCase().includes(s) ||
        (item.model || '').toLowerCase().includes(s) ||
        (item.make || '').toLowerCase().includes(s)
      );
    }

    const start = (page - 1) * limit;
    return {
      data: results.slice(start, start + parseInt(limit)),
      total: results.length,
      page: parseInt(page),
      totalPages: Math.ceil(results.length / limit),
    };
  },

  findById(id) {
    const doc = snapshotStore.getById(COLLECTION_NAME, id);
    return doc || null;
  },

  async create(data) {
    try {
      const registrationNumber = normalizeRegistration(data.registrationNumber || data.plateNumber);
      if (!registrationNumber) {
        throw Object.assign(new Error('Vehicle registration is required'), {
          statusCode: 400,
          code: 'VEHICLE_REGISTRATION_REQUIRED',
        });
      }
      const truckId = await getNextId('truck');
      const docRef = collectionRef.doc(truckId);
      const item = omitUndefinedFields({
        ...data,
        id: truckId,
        registrationNumber,
        plateNumber: registrationNumber,
        status: data.status || 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await db.runTransaction(async (transaction) => {
        const reservation = await transaction.get(registrationRef.doc(registrationNumber));
        if (reservation.exists) throw duplicateRegistrationError();

        // Older records may predate the reservation collection.  The import
        // preview also checks the live snapshot cache case-insensitively.
        const existing = await transaction.get(
          collectionRef.where('registrationNumber', '==', registrationNumber).limit(1),
        );
        if (!existing.empty) throw duplicateRegistrationError();

        transaction.set(docRef, item);
        transaction.set(registrationRef.doc(registrationNumber), {
          vehicleId: truckId,
          registrationNumber,
          createdAt: item.createdAt,
        });
      });
      const result = { id: truckId, ...item };
      await girService.syncVehicle(result);
      return result;
    } catch (error) {
      console.error('vehiclesService.create error:', error);
      throw error;
    }
  },

  async update(id, data) {
    try {
      if (Object.hasOwn(data, 'capacity') && (data.capacity === '' || data.capacity == null || !Number.isFinite(Number(data.capacity)) || Number(data.capacity) <= 0)) {
        throw Object.assign(new Error('Capacity must be a positive number.'), { statusCode: 400 });
      }
      if (Object.hasOwn(data, 'status') && !['active', 'inactive', 'on_trip', 'in_maintenance', 'out_of_service'].includes(data.status)) {
        throw Object.assign(new Error('Choose a valid vehicle status.'), { statusCode: 400 });
      }
      const docRef = collectionRef.doc(id);
      let result = null;
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const current = doc.data();
        const suppliedRegistration = Object.prototype.hasOwnProperty.call(data, 'registrationNumber')
          ? data.registrationNumber
          : Object.prototype.hasOwnProperty.call(data, 'plateNumber')
            ? data.plateNumber
            : current.registrationNumber || current.plateNumber;
        const registrationNumber = normalizeRegistration(suppliedRegistration);
        if (!registrationNumber) {
          throw Object.assign(new Error('Vehicle registration is required'), {
            statusCode: 400,
            code: 'VEHICLE_REGISTRATION_REQUIRED',
          });
        }
        const currentRegistration = normalizeRegistration(current.registrationNumber || current.plateNumber);
        if (registrationNumber !== currentRegistration) {
          const reservation = await transaction.get(registrationRef.doc(registrationNumber));
          if (reservation.exists && reservation.data().vehicleId !== id) throw duplicateRegistrationError();
          const matches = await transaction.get(collectionRef.where('registrationNumber', '==', registrationNumber));
          const legacyMatches = await transaction.get(collectionRef.where('plateNumber', '==', registrationNumber));
          if ([...matches.docs, ...legacyMatches.docs].some(doc => doc.id !== id)) throw duplicateRegistrationError();
          transaction.set(registrationRef.doc(registrationNumber), {
            vehicleId: id,
            registrationNumber,
            createdAt: current.createdAt || new Date().toISOString(),
          });
          if (currentRegistration) transaction.delete(registrationRef.doc(currentRegistration));
        } else {
          transaction.set(registrationRef.doc(registrationNumber), {
            vehicleId: id,
            registrationNumber,
            createdAt: current.createdAt || new Date().toISOString(),
          }, { merge: true });
        }
        const updates = omitUndefinedFields({ ...data, registrationNumber, plateNumber: registrationNumber, updatedAt: new Date().toISOString() });
        transaction.update(docRef, updates);
        result = { id, ...current, ...updates };
      });
      if (result) {
        snapshotStore.applyCommittedUpdate(COLLECTION_NAME, id, result);
        await girService.syncVehicle(result);
      }
      return result;
    } catch (error) {
      console.error('vehiclesService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      const docRef = collectionRef.doc(id);
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const registrationNumber = normalizeRegistration(doc.data().registrationNumber || doc.data().plateNumber);
        transaction.delete(docRef);
        if (registrationNumber) transaction.delete(registrationRef.doc(registrationNumber));
      });
    } catch (error) {
      console.error('vehiclesService.delete error:', error);
      throw error;
    }
  },
};

module.exports = vehiclesService;

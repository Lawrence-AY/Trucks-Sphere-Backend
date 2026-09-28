const { receiptReference } = require('../../utils/receiptReference');
const { isSupersededForFuel } = require('../../utils/fuelEligibility');
const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const girService = require('../../integrations/girService');
const collectionRef = db.collection('fuelRecords');

const COLLECTION_NAME = 'fuelRecords';

/**
 * Normalize vendor ID to consistent format e.g. "v1" → "V001", "1" → "V001"
 */
function normalizeVendorId(raw) {
  if (!raw) return '';
  let str = String(raw).trim();
  // Match pattern: optional V/v prefix followed by digits
  const match = str.match(/^([Vv]?)(\d+)$/);
  if (match) {
    const num = parseInt(match[2], 10);
    return `v${String(num).padStart(3, '0')}`;
  }
  return str;
}

const fuelService = {
  /**
   * findAll now reads from the in-memory snapshot cache.
   * The cache is kept up-to-date via Firestore onSnapshot — no need to
   * query Firestore on every request.
   */
  findAll(query = {}) {
    const { search, vendorId, jobId, plateNumber, dateFrom, dateTo, dispensedByEmail, page = 1, limit = 50 } = query;
    const normalizedVendorId = normalizeVendorId(vendorId);

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending (same order as before)
    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (normalizedVendorId) {
      results = results.filter(item => normalizeVendorId(item.vendorId) === normalizedVendorId);
    }
    if (jobId) results = results.filter(item => item.jobId === jobId);
    if (plateNumber) results = results.filter(item => item.plateNumber === plateNumber);
    if (dateFrom) results = results.filter(item => new Date(item.createdAt) >= new Date(dateFrom));
    if (dateTo) results = results.filter(item => new Date(item.createdAt) <= new Date(dateTo));
    if (dispensedByEmail) {
      results = results.filter(item => (item.dispensedByEmail || item.dispensedBy || '') === dispensedByEmail);
    }
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(item =>
        (item.jobId || '').toLowerCase().includes(s) ||
        (item.driverName || '').toLowerCase().includes(s) ||
        (item.plateNumber || '').toLowerCase().includes(s) ||
        (item.vendorName || '').toLowerCase().includes(s)
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

  async confirm(authorizationId, actorEmail, references = {}) {
    if (!authorizationId || typeof authorizationId !== 'string' || authorizationId.includes('/')) throw Object.assign(new Error('Authorization is required.'), {statusCode: 400});
    const document = await db.collection('fuelAuthorizations').doc(authorizationId).get();
    const authorization = document.exists && document.data();
    if (!authorization || authorization.requestedByEmail !== actorEmail) throw Object.assign(new Error('Authorization not found for this operator.'), {statusCode: 403});
    if (authorization.status !== 'authorized') throw Object.assign(new Error('Vendor authorization is required.'), {statusCode: 409});
    for (const key of ['jobId', 'driverId', 'vehicleId', 'vendorId']) {
      if (references[key] && references[key] !== authorization[key]) throw Object.assign(new Error('Fuel references do not match the authorization.'), { statusCode: 409, code: 'FMS_REFERENCE_MISMATCH' });
    }
    if (authorization.finalizedFuelRecordId) {
      const saved = await collectionRef.doc(authorization.finalizedFuelRecordId).get();
      if (saved.exists) return { transaction: { id: saved.data().fmsTransactionId, volume: saved.data().fuelAmount }, receiptNoteId: saved.data().receiptNoteId, authorization };
    }
    const job = snapshotStore.getAll('deliveryOrders').find(j => j.jobId === authorization.jobId || j.id === authorization.jobId);
    const receiptNoteId = receiptReference(job);
    const transaction = await girService.findFuelTransaction({ receiptNoteId, jobId: authorization.jobId, fmsTransactionId: references.fmsTransactionId, activeDriverCode: authorization.girDriverCode,
      driverId: authorization.driverId, vehicleId: authorization.vehicleId, vendorId: authorization.vendorId, authorizedAt: authorization.authorizedAt });
    return { transaction, receiptNoteId, authorization };
  },

  async create(data) {
    try {
      const jobs = snapshotStore.getAll('deliveryOrders');
      const job = jobs.find((item) => item.jobId === data.jobId || item.id === data.jobId);
      if (job && isSupersededForFuel(job, jobs)) throw Object.assign(new Error('This driver or truck has a newer job. Refresh the fuel queue.'), { statusCode: 409, code: 'FUEL_JOB_SUPERSEDED' });
      const confirmed = await fuelService.confirm(data.authorizationId, data.dispensedByEmail, data);
      if (confirmed.authorization.jobId !== data.jobId) throw Object.assign(new Error('Authorization does not belong to this job.'), {statusCode: 409});
      if (String(data.fmsTransactionId || '') !== confirmed.transaction.id) throw Object.assign(new Error('Confirm the FMS transaction before finalizing.'), {statusCode: 409});
      const fuelId = 'FMS-' + require('crypto').createHash('sha256').update(confirmed.transaction.id).digest('hex');
      const docRef = collectionRef.doc(fuelId);
      // Normalize vendorId to consistent V### format
      const normalizedVendorId = normalizeVendorId(confirmed.authorization.vendorId);
      const girVolume = confirmed.transaction.volume;
      const item = {
        ...data,
        receiptNoteId: confirmed.receiptNoteId,
        driverId: confirmed.authorization.driverId,
        driverCode: confirmed.authorization.driverCode || confirmed.authorization.driverId,
        girDriverCode: confirmed.authorization.girDriverCode || '',
        vehicleId: confirmed.authorization.vehicleId,
        fmsTransactionId: confirmed.transaction.id,
        fuelAmount: girVolume,
        id: fuelId,
        vendorId: normalizedVendorId || confirmed.authorization.vendorId,
        companyName: data.companyName || data.vendorName || '',
        totalCost: (Number(data.pricePerLiter) || 0) * confirmed.transaction.volume,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const saved = await db.runTransaction(async transaction => {
        const existing = await transaction.get(docRef);
        const authRef = db.collection('fuelAuthorizations').doc(data.authorizationId);
        const authDoc = await transaction.get(authRef);
        if (existing.exists) {
          if (existing.data().authorizationId !== data.authorizationId) throw Object.assign(new Error('FMS transaction is already recorded.'), {statusCode: 409});
          return existing.data();
        }
        if (!authDoc.exists || authDoc.data().finalizedFuelRecordId) throw Object.assign(new Error('Authorization is already finalized.'), {statusCode: 409});
        transaction.set(docRef, item);
        transaction.update(authRef, { finalizedFuelRecordId: fuelId });
        return item;
      });
      await girService.clearFuelSession({ driverId: saved.driverId, vehicleId: saved.vehicleId, jobId: saved.receiptNoteId });
      // Cache is updated via onSnapshot — no need to manually update
      return { id: fuelId, ...saved };
    } catch (error) {
      console.error('fuelService.create error:', error);
      throw error;
    }
  },

  async update(id, data) {
    try {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return null;
      const updates = { ...data, updatedAt: new Date().toISOString() };
      await docRef.update(updates);
      return { id, ...doc.data(), ...updates };
    } catch (error) {
      console.error('fuelService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('fuelService.delete error:', error);
      throw error;
    }
  },
};

module.exports = fuelService;

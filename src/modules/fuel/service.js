const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
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
    return `V${String(num).padStart(3, '0')}`;
  }
  return str.toUpperCase();
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

  async create(data) {
    try {
      const fuelId = await getNextId('fuel');
      const docRef = collectionRef.doc(fuelId);
      // Normalize vendorId to consistent V### format
      const normalizedVendorId = normalizeVendorId(data.vendorId);
      const item = {
        ...data,
        id: fuelId,
        vendorId: normalizedVendorId || data.vendorId,
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      // Cache is updated via onSnapshot — no need to manually update
      return { id: fuelId, ...item };
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

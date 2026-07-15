const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('drivers');

const COLLECTION_NAME = 'drivers';

const driversService = {
  /**
   * findAll reads from the in-memory snapshot cache.
   * This avoids composite index requirements and eliminates Firestore reads.
   */
  findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return db - da;
    });

    if (status) results = results.filter(item => item.status === status);
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

  async create(data) {
    try {
      const driverId = await getNextId('driver');
      const docRef = collectionRef.doc(driverId);
      const item = {
        ...data,
        id: driverId,
        status: data.status || 'active',
        nationalId: data.nationalId || '',
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
      };
      await docRef.set(item);
      return { id: driverId, ...item };
    } catch (error) {
      console.error('driversService.create error:', error);
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
      console.error('driversService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('driversService.delete error:', error);
      throw error;
    }
  },
};

module.exports = driversService;
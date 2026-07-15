const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('vendors');

const COLLECTION_NAME = 'vendors';

const vendorsService = {
  /**
   * findAll reads from the in-memory snapshot cache.
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
        (item.companyName || '').toLowerCase().includes(s) ||
        (item.id || '').toLowerCase().includes(s) ||
        (item.kraPin || '').toLowerCase().includes(s) ||
        (item.companyActCR12 || '').toLowerCase().includes(s)
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
      const vendorId = await getNextId('vendor');
      const docRef = collectionRef.doc(vendorId);
      const item = {
        ...data,
        id: vendorId,
        status: data.status || 'active',
        fleetSize: data.fleetSize || 0,
        // Regulatory / Compliance
        companyActCR12: data.companyActCR12 || '',
        kraPin: data.kraPin || '',
        businessPermit: data.businessPermit || '',
        taxCompliance: data.taxCompliance || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: vendorId, ...item };
    } catch (error) {
      console.error('vendorsService.create error:', error);
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
      console.error('vendorsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('vendorsService.delete error:', error);
      throw error;
    }
  },
};

module.exports = vendorsService;
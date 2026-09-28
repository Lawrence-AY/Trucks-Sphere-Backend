const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('materials');

const COLLECTION_NAME = 'materials';

const materialsService = {
  findAll(query = {}) {
    const { search, status, category, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    // Sort by name ascending
    results = [...results].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );

    if (category) results = results.filter(item => item.category === category);
    if (status === 'active') results = results.filter(item => item.active === true);
    if (status === 'inactive') results = results.filter(item => item.active === false);
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(item =>
        (item.name || '').toLowerCase().includes(s) ||
        (item.description || '').toLowerCase().includes(s)
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
      const docRef = collectionRef.doc(data.id || undefined);
      const item = {
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await docRef.set(item);
      return { id: docRef.id, ...item };
    } catch (error) {
      console.error('materialsService.create error:', error);
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
      console.error('materialsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('materialsService.delete error:', error);
      throw error;
    }
  },
};

module.exports = materialsService;
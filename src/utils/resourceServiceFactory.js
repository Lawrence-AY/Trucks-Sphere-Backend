const { db } = require('../../config/firebase');
const snapshotStore = require('./snapshotStore');

function normalizeLimit(limit) {
  const parsed = parseInt(limit, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 200);
}

function createResourceService({
  collectionName,
  cacheName = collectionName,
  searchableFields = ['name'],
  defaultStatusField = 'status',
  defaultSortField = 'createdAt',
  defaultSortDirection = 'desc',
}) {
  const collectionRef = db.collection(collectionName);

  return {
    findAll(query = {}) {
      const { search, status, page = 1 } = query;
      const limit = normalizeLimit(query.limit);
      const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

      let results = snapshotStore.getAll(cacheName);

      results = [...results].sort((a, b) => {
        const aValue = a[defaultSortField] || '';
        const bValue = b[defaultSortField] || '';
        const compare = String(aValue).localeCompare(String(bValue));
        return defaultSortDirection === 'asc' ? compare : -compare;
      });

      if (status) {
        results = results.filter((item) => item[defaultStatusField] === status);
      }

      if (search) {
        const queryText = String(search).toLowerCase();
        results = results.filter((item) =>
          searchableFields.some((field) =>
            String(item[field] || '').toLowerCase().includes(queryText)
          )
        );
      }

      const start = (pageNumber - 1) * limit;
      return {
        data: results.slice(start, start + limit),
        total: results.length,
        page: pageNumber,
        totalPages: Math.ceil(results.length / limit),
      };
    },

    findById(id) {
      return snapshotStore.getById(cacheName, id) || null;
    },

    async create(data, user = {}) {
      const docRef = data.id ? collectionRef.doc(data.id) : collectionRef.doc();
      const now = new Date().toISOString();
      const item = {
        ...data,
        id: docRef.id,
        status: data.status || 'active',
        createdAt: data.createdAt || now,
        updatedAt: now,
        createdBy: data.createdBy || user.uid || user.email || null,
        updatedBy: data.updatedBy || user.uid || user.email || null,
      };

      await docRef.set(item);
      return item;
    },

    async update(id, data, user = {}) {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return null;

      const updates = {
        ...data,
        updatedAt: new Date().toISOString(),
        updatedBy: data.updatedBy || user.uid || user.email || null,
      };

      await docRef.update(updates);
      return { id, ...doc.data(), ...updates };
    },

    async delete(id) {
      await collectionRef.doc(id).delete();
    },
  };
}

module.exports = createResourceService;

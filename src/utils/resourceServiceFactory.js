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

  /**
   * Role access decides what a user can do; ownership decides which individual
   * records they can see. Entity-wide filters alone would expose one operator's
   * records to every operator assigned to the same quarry/site/vendor.
   */
  function applyRoleFilter(results, user) {
    if (!user?.uid) return [];
    if (user.role === 'super_admin' || user.role === 'admin') return results;
    return results.filter((item) => isOwnedBy(item, user.uid));
  }

  return {
    findAll(query = {}, user = {}) {
      const { search, status, page = 1 } = query;
      const limit = normalizeLimit(query.limit);
      const pageNumber = Math.max(parseInt(page, 10) || 1, 1);

      let results = snapshotStore.getAll(cacheName);

      // Apply role-based filtering first
      results = applyRoleFilter(results, user);

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

    findById(id, user = {}) {
      const item = snapshotStore.getById(cacheName, id) || null;
      return item && applyRoleFilter([item], user).length ? item : null;
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
        createdBy: data.createdBy || buildActorReference(user),
        updatedBy: data.updatedBy || buildActorReference(user),
      };

      await docRef.set(item);
      return item;
    },

    async update(id, data, user = {}) {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists || !applyRoleFilter([{ id, ...doc.data() }], user).length) return null;

      const updates = {
        ...data,
        updatedAt: new Date().toISOString(),
        updatedBy: data.updatedBy || buildActorReference(user),
      };

      await docRef.update(updates);
      return { id, ...doc.data(), ...updates };
    },

    async delete(id, user = {}) {
      const docRef = collectionRef.doc(id);
      const doc = await docRef.get();
      if (!doc.exists || !applyRoleFilter([{ id, ...doc.data() }], user).length) return false;
      await docRef.delete();
      return true;
    },
  };
}

function isOwnedBy(item, uid) {
  return item?.createdBy?.uid === uid ||
    item?.updatedBy?.uid === uid ||
    item?.createdByUid === uid ||
    item?.ownerUid === uid ||
    item?.userId === uid ||
    item?.uid === uid;
}

function buildActorReference(user = {}) {
  const email = user.email || '';
  return {
    uid: user.uid || '',
    username: user.username || email.split('@')[0] || '',
    displayName: user.displayName || user.name || email || 'system',
    email,
    role: user.role || '',
    ...(user.entityId ? { entityId: user.entityId, entityType: user.entityType } : {}),
  };
}

module.exports = createResourceService;

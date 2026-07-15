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
  /** Field names used for role-based filtering. Set per-collection when configuring. */
  roleFilterFieldMap = {
    vendor: 'vendorId',
    operator_quarry: 'quarryId',
    operator_site: 'siteId',
    operator_fuel: 'fuelStationId',
  },
}) {
  const collectionRef = db.collection(collectionName);

  /**
   * Apply role-based filtering so users only see their own data.
   * - management / admin: see everything (no filter)
   * - vendor: filter by vendorId
   * - operator_quarry: filter by quarryId
   * - operator_site: filter by siteId
   * - operator_fuel: filter by fuelStationId
   */
  function applyRoleFilter(results, user) {
    if (!user || !user.role) return results;
    const role = user.role;

    // Management sees everything
    if (role === 'management' || role === 'admin') return results;

    const filterField = roleFilterFieldMap[role];
    if (!filterField) return results;

    // Determine the filter value from the user object
    const filterValue = user[filterField] || user.uid;
    if (!filterValue) return results;

    return results.filter((item) => item[filterField] === filterValue);
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

    findById(id) {
      return snapshotStore.getById(cacheName, id) || null;
    },

    async create(data, user = {}) {
      const docRef = data.id ? collectionRef.doc(data.id) : collectionRef.doc();
      const now = new Date().toISOString();

      // Resolve user display info for tracking
      let createdByUsername = data.createdByUsername || null;
      let createdByDisplayName = data.createdByDisplayName || null;
      if (!createdByUsername || !createdByDisplayName) {
        try {
          const userProfile = snapshotStore.getById('users', user.uid);
          if (userProfile) {
            createdByUsername = createdByUsername || userProfile.username || null;
            createdByDisplayName = createdByDisplayName || userProfile.displayName || userProfile.name || null;
          }
        } catch {
          // Non-blocking
        }
      }

      const item = {
        ...data,
        id: docRef.id,
        status: data.status || 'active',
        createdAt: data.createdAt || now,
        updatedAt: now,
        createdBy: data.createdBy || user.uid || user.email || null,
        createdByUsername: createdByUsername || user.email || null,
        createdByDisplayName: createdByDisplayName || user.email || null,
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

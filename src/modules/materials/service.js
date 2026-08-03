const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const { getNextId } = require('../../utils/counterService');
const {
  syncMaterial,
  fetchOdooPurchaseProducts,
  odooProductToMaterial,
} = require('../../integrations/odooMaterialService');
const collectionRef = db.collection('materials');

const COLLECTION_NAME = 'materials';
let odooSyncJob = { status: 'idle', result: null, startedAt: null, completedAt: null };

function withoutUndefined(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

async function importOdooMaterials() {
  const result = { imported: 0, updatedFromOdoo: 0 };
  const odooProducts = await fetchOdooPurchaseProducts();
  const materialSnapshot = await collectionRef.get();
  const byOdooId = new Map();
  const byReference = new Map();
  materialSnapshot.docs.forEach((doc) => {
    const material = doc.data();
    if (Number.isInteger(material.odooProductTemplateId)) byOdooId.set(material.odooProductTemplateId, doc);
    [material.id, material.materialId, material.odooInternalReference]
      .filter(Boolean)
      .forEach((reference) => byReference.set(String(reference), doc));
  });

  for (const product of odooProducts) {
    const existing = byOdooId.get(product.id) || byReference.get(String(product.default_code || ''));
    const mapped = withoutUndefined(odooProductToMaterial(product, null));
    if (existing) {
      await existing.ref.update({ ...mapped, updatedAt: new Date().toISOString() });
      result.updatedFromOdoo += 1;
      continue;
    }

    const materialId = await getNextId('material');
    const item = {
      ...mapped,
      id: materialId,
      materialId,
      name: mapped.name || `Odoo Product ${product.id}`,
      category: mapped.category || 'Other',
      measurementType: mapped.measurementType || 'Pieces',
      defaultUnit: mapped.defaultUnit || 'Pieces',
      status: mapped.status || 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await collectionRef.doc(materialId).set(item);
    byOdooId.set(product.id, { ref: collectionRef.doc(materialId) });
    result.imported += 1;
  }
  return result;
}

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
      const materialId = await getNextId('material');
      const docRef = collectionRef.doc(materialId);
      const item = {
        ...data,
        id: materialId,
        materialId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // A material created in TruckSphere is also a purchase product in Odoo.
      // The Odoo product is synchronized first, so a successful local create
      // always has a corresponding Odoo product record.
      Object.assign(item, await syncMaterial(item));
      await docRef.set(item);
      return { id: materialId, ...item };
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
      const material = { id, ...doc.data(), ...data };
      const updates = {
        ...data,
        ...await syncMaterial(material),
        updatedAt: new Date().toISOString(),
      };
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

  /** Synchronize the existing TruckSphere catalogue to Odoo sequentially. */
  async syncAllToOdoo() {
    const snapshot = await collectionRef.get();
    const result = { total: snapshot.size, synced: 0, skipped: 0, imported: 0, updatedFromOdoo: 0, failed: 0, errors: [] };

    for (const doc of snapshot.docs) {
      try {
        const material = { id: doc.id, ...doc.data() };
        const updatedAt = Date.parse(material.updatedAt || '');
        const syncedAt = Date.parse(material.odooSyncedAt || '');
        // The normal create/update flow synchronizes immediately. Avoid
        // replaying an unchanged catalogue during a manual Odoo refresh.
        if (Number.isFinite(updatedAt) && Number.isFinite(syncedAt) && updatedAt <= syncedAt + 1_000) {
          result.skipped += 1;
          continue;
        }
        const odooFields = await syncMaterial(material);
        await doc.ref.update(withoutUndefined({ ...odooFields, updatedAt: new Date().toISOString() }));
        result.synced += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ id: doc.id, code: error.code || 'ODOO_MATERIAL_SYNC_FAILED' });
        console.error(`[Odoo] Failed to synchronize material ${doc.id}: ${error.message}`);
      }
    }

    const imported = await importOdooMaterials();
    result.imported = imported.imported;
    result.updatedFromOdoo = imported.updatedFromOdoo;

    return result;
  },

  async importFromOdoo() {
    return importOdooMaterials();
  },

  startOdooSync() {
    if (odooSyncJob.status === 'running') return odooSyncJob;

    odooSyncJob = { status: 'running', result: null, startedAt: new Date().toISOString(), completedAt: null };
    void materialsService.syncAllToOdoo()
      .then((result) => {
        odooSyncJob = { status: 'completed', result, startedAt: odooSyncJob.startedAt, completedAt: new Date().toISOString() };
      })
      .catch((error) => {
        console.error(`[Odoo] Material sync job failed: ${error.message}`);
        odooSyncJob = {
          status: 'failed',
          result: { code: error.code || 'ODOO_MATERIAL_SYNC_FAILED' },
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

module.exports = materialsService;

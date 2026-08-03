const { db } = require('../../../config/firebase');
const { getAuth } = require('firebase-admin/auth');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const { assertStrongPassword } = require('../../utils/passwordPolicy');
const { fetchOdooVendors, odooPartnerToVendor } = require('../../integrations/odooVendorService');
const collectionRef = db.collection('vendors');

const COLLECTION_NAME = 'vendors';
let odooSyncJob = { status: 'idle', result: null, startedAt: null, completedAt: null };

function withoutUndefined(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function normalizedMatchKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addUniqueIndex(index, key, value) {
  if (!key) return;
  index.set(key, index.has(key) ? null : value);
}

async function importOdooVendors(options = {}) {
  const result = { total: 0, imported: 0, updatedFromOdoo: 0 };
  const [odooPartners, vendorSnapshot] = await Promise.all([
    fetchOdooVendors(options),
    collectionRef.get(),
  ]);
  result.total = odooPartners.length;

  const byOdooId = new Map();
  const byKraPin = new Map();
  const byCompanyName = new Map();
  vendorSnapshot.docs.forEach((doc) => {
    const vendor = doc.data();
    if (Number.isInteger(vendor.odooPartnerId)) byOdooId.set(vendor.odooPartnerId, doc);
    addUniqueIndex(byKraPin, normalizedMatchKey(vendor.kraPin), doc);
    addUniqueIndex(byCompanyName, normalizedMatchKey(vendor.companyName || vendor.name), doc);
  });

  for (const partner of odooPartners) {
    const mapped = withoutUndefined(odooPartnerToVendor(partner));
    const matchingKraPin = normalizedMatchKey(mapped.kraPin);
    const matchingCompanyName = normalizedMatchKey(mapped.companyName);
    const existing = byOdooId.get(partner.id)
      || (matchingKraPin && byKraPin.get(matchingKraPin))
      || (matchingCompanyName && byCompanyName.get(matchingCompanyName));
    const now = new Date().toISOString();

    if (existing) {
      await existing.ref.update({ ...mapped, updatedAt: now });
      byOdooId.set(partner.id, existing);
      result.updatedFromOdoo += 1;
      continue;
    }

    const vendorId = await getNextId('vendor');
    const item = {
      ...mapped,
      id: vendorId,
      vendorId,
      companyName: mapped.companyName || `Odoo Vendor ${partner.id}`,
      contactPerson: mapped.contactPerson || mapped.companyName || `Odoo Vendor ${partner.id}`,
      phone: mapped.phone || '',
      status: mapped.status || 'active',
      fleetSize: 0,
      companyActCR12: '',
      kraPin: mapped.kraPin || '',
      businessPermit: '',
      taxCompliance: '',
      createdAt: now,
      updatedAt: now,
    };
    const ref = collectionRef.doc(vendorId);
    await ref.set(item);
    const newDoc = { ref, data: () => item };
    byOdooId.set(partner.id, newDoc);
    addUniqueIndex(byKraPin, normalizedMatchKey(item.kraPin), newDoc);
    addUniqueIndex(byCompanyName, normalizedMatchKey(item.companyName), newDoc);
    result.imported += 1;
  }

  return result;
}

function splitName(value = '') {
  const parts = String(value).trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' };
}

async function generateUniqueUsername(name) {
  const { firstName, lastName } = splitName(name);
  const sanitize = (value) => value.replace(/[^a-zA-Z]/g, '').toLowerCase();
  const first = sanitize(firstName);
  const last = sanitize(lastName);
  if (!first) throw Object.assign(new Error('A contact person is required to generate a username'), { statusCode: 400 });

  const base = `${first}${last.slice(0, 3)}`;
  let username = base;
  let suffix = 1;
  while (true) {
    const existing = await db.collection('users').where('generatedUsername', '==', username).limit(1).get();
    if (existing.empty) return username;
    username = `${base}${suffix++}`;
  }
}

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

  async previewUsername(contactPerson) {
    return generateUniqueUsername(contactPerson);
  },

  /**
   * Creates the vendor profile and its login account as one operation. Firestore
   * writes are committed in one batch; a Firebase Auth account is removed if
   * the batch cannot be committed, so no orphan account is left behind.
   */
  async createWithAccount({ vendor = {}, account = {} }) {
    const email = String(account.email || vendor.email || '').trim().toLowerCase();
    const password = account.password;
    if (!email) throw Object.assign(new Error('Account email is required'), { statusCode: 400 });
    assertStrongPassword(password);
    if (!vendor.companyName || !vendor.contactPerson || !vendor.phone) {
      throw Object.assign(new Error('Company name, contact person, and phone number are required'), { statusCode: 400 });
    }

    const username = await generateUniqueUsername(vendor.contactPerson);
    const vendorId = await getNextId('vendor');
    const now = new Date().toISOString();
    let authUser;

    try {
      authUser = await getAuth().createUser({
        email,
        password,
        displayName: vendor.contactPerson.trim(),
        disabled: account.isActive === false,
      });
      await getAuth().setCustomUserClaims(authUser.uid, { role: 'vendor' });

      const vendorItem = {
        ...vendor,
        id: vendorId,
        email,
        status: vendor.status || 'active',
        fleetSize: vendor.fleetSize || 0,
        companyActCR12: vendor.companyActCR12 || '',
        kraPin: vendor.kraPin || '',
        businessPermit: vendor.businessPermit || '',
        taxCompliance: vendor.taxCompliance || '',
        userId: authUser.uid,
        createdAt: now,
        updatedAt: now,
      };
      const { firstName, lastName } = splitName(vendor.contactPerson);
      const userItem = {
        id: authUser.uid,
        uid: authUser.uid,
        authUid: authUser.uid,
        email,
        displayName: vendor.contactPerson.trim(),
        generatedUsername: username,
        username,
        firstName,
        lastName,
        phone: vendor.phone.trim(),
        role: 'vendor',
        vendorId,
        isActive: account.isActive !== false,
        createdAt: now,
        updatedAt: now,
      };

      const batch = db.batch();
      batch.set(collectionRef.doc(vendorId), vendorItem);
      batch.set(db.collection('users').doc(authUser.uid), userItem);
      await batch.commit();

      return { vendor: vendorItem, user: userItem, username };
    } catch (error) {
      if (authUser) {
        try { await getAuth().deleteUser(authUser.uid); } catch (cleanupError) {
          console.error('Unable to roll back Firebase Auth vendor account:', cleanupError);
        }
      }
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

  async importFromOdoo(options) {
    return importOdooVendors(options);
  },

  startOdooSync() {
    if (odooSyncJob.status === 'running') return odooSyncJob;

    odooSyncJob = { status: 'running', result: null, startedAt: new Date().toISOString(), completedAt: null };
    void vendorsService.importFromOdoo()
      .then((result) => {
        odooSyncJob = { status: 'completed', result, startedAt: odooSyncJob.startedAt, completedAt: new Date().toISOString() };
      })
      .catch((error) => {
        console.error(`[Odoo] Vendor sync failed: ${error.message}`);
        odooSyncJob = {
          status: 'failed',
          result: { code: error.code || 'ODOO_VENDOR_SYNC_FAILED' },
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

module.exports = vendorsService;

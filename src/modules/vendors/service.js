const { db } = require('../../../config/firebase');
const { getAuth } = require('firebase-admin/auth');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const { assertStrongPassword } = require('../../utils/passwordPolicy');
const { fetchOdooVendors, odooPartnerToVendor, syncVendor } = require('../../integrations/odooVendorService');
const { isOdooEnabled } = require('../../integrations/odooConfig');
const collectionRef = db.collection('vendors');
const uniqueKeysRef = db.collection('vendorUniqueKeys');

const COLLECTION_NAME = 'vendors';
let odooSyncJob = { status: 'idle', result: null, startedAt: null, completedAt: null };

function withoutUndefined(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function normalizedMatchKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizedPhoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  // Telephone formats differ between systems (for example +254 7… vs 07…).
  // The last nine digits are stable for Kenyan mobile numbers, while shorter
  // local numbers remain unchanged.
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function vendorUniqueKeys(data = {}, { allowMissingCompany = false } = {}) {
  const companyName = normalizedMatchKey(data.companyName || data.name);
  if (!companyName) {
    if (allowMissingCompany) return [];
    throw Object.assign(new Error('Company name is required'), { statusCode: 400, code: 'VENDOR_NAME_REQUIRED' });
  }

  const keys = [`company:${companyName}`];
  const kraPin = normalizedMatchKey(data.kraPin);
  const phone = normalizedPhoneKey(data.phone);
  if (kraPin) keys.push(`kra:${kraPin}`);
  if (phone) keys.push(`phone:${phone}`);
  return [...new Set(keys)];
}

function duplicateVendorError() {
  return Object.assign(new Error('A matching vendor already exists.'), {
    statusCode: 409,
    code: 'VENDOR_ALREADY_EXISTS',
  });
}

async function createVendorWithUniqueKeys(docRef, item, uniqueKeys) {
  await db.runTransaction(async (transaction) => {
    const [reservations, existingVendors] = await Promise.all([
      Promise.all(uniqueKeys.map((key) => transaction.get(uniqueKeysRef.doc(key)))),
      transaction.get(collectionRef),
    ]);
    if (reservations.some((reservation) => reservation.exists)) throw duplicateVendorError();
    const hasLegacyDuplicate = existingVendors.docs.some((existing) =>
      vendorUniqueKeys(existing.data(), { allowMissingCompany: true }).some((key) => uniqueKeys.includes(key)),
    );
    if (hasLegacyDuplicate) throw duplicateVendorError();

    transaction.set(docRef, item);
    uniqueKeys.forEach((key) => transaction.set(uniqueKeysRef.doc(key), {
      vendorId: item.id,
      key,
      createdAt: item.createdAt,
    }));
  });
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
  const byPhone = new Map();
  const byCompanyName = new Map();
  vendorSnapshot.docs.forEach((doc) => {
    const vendor = doc.data();
    if (Number.isInteger(vendor.odooPartnerId)) byOdooId.set(vendor.odooPartnerId, doc);
    addUniqueIndex(byKraPin, normalizedMatchKey(vendor.kraPin), doc);
    addUniqueIndex(byPhone, normalizedPhoneKey(vendor.phone), doc);
    addUniqueIndex(byCompanyName, normalizedMatchKey(vendor.companyName || vendor.name), doc);
  });

  for (const partner of odooPartners) {
    const mapped = withoutUndefined(odooPartnerToVendor(partner));
    const matchingKraPin = normalizedMatchKey(mapped.kraPin);
    const matchingPhone = normalizedPhoneKey(mapped.phone);
    const matchingCompanyName = normalizedMatchKey(mapped.companyName);
    const existing = byOdooId.get(partner.id)
      || (matchingKraPin && byKraPin.get(matchingKraPin))
      || (matchingPhone && byPhone.get(matchingPhone))
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
    addUniqueIndex(byPhone, normalizedPhoneKey(item.phone), newDoc);
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
      const uniqueKeys = vendorUniqueKeys(data);
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
        companyNameNormalized: normalizedMatchKey(data.companyName || data.name),
        kraPinNormalized: normalizedMatchKey(data.kraPin),
        phoneNormalized: normalizedPhoneKey(data.phone),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (isOdooEnabled()) Object.assign(item, await syncVendor(item));
      await createVendorWithUniqueKeys(docRef, item, uniqueKeys);
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

    const uniqueKeys = vendorUniqueKeys(vendor);
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
        companyNameNormalized: normalizedMatchKey(vendor.companyName || vendor.name),
        kraPinNormalized: normalizedMatchKey(vendor.kraPin),
        phoneNormalized: normalizedPhoneKey(vendor.phone),
        userId: authUser.uid,
        createdAt: now,
        updatedAt: now,
      };
      if (isOdooEnabled()) Object.assign(vendorItem, await syncVendor(vendorItem));
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

      await db.runTransaction(async (transaction) => {
        const [reservations, existingVendors] = await Promise.all([
          Promise.all(uniqueKeys.map((key) => transaction.get(uniqueKeysRef.doc(key)))),
          transaction.get(collectionRef),
        ]);
        if (reservations.some((reservation) => reservation.exists)) throw duplicateVendorError();
        const hasLegacyDuplicate = existingVendors.docs.some((existing) =>
          vendorUniqueKeys(existing.data(), { allowMissingCompany: true }).some((key) => uniqueKeys.includes(key)),
        );
        if (hasLegacyDuplicate) throw duplicateVendorError();

        transaction.set(collectionRef.doc(vendorId), vendorItem);
        transaction.set(db.collection('users').doc(authUser.uid), userItem);
        uniqueKeys.forEach((key) => transaction.set(uniqueKeysRef.doc(key), {
          vendorId,
          key,
          createdAt: now,
        }));
      });

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
      const current = doc.data();
      const vendor = { id, ...current, ...data };
      const previousKeys = vendorUniqueKeys(current, { allowMissingCompany: true });
      const nextKeys = vendorUniqueKeys(vendor);
      const updates = {
        ...data,
        companyNameNormalized: normalizedMatchKey(vendor.companyName || vendor.name),
        kraPinNormalized: normalizedMatchKey(vendor.kraPin),
        phoneNormalized: normalizedPhoneKey(vendor.phone),
        ...(isOdooEnabled() ? await syncVendor(vendor) : {}),
        updatedAt: new Date().toISOString(),
      };
      let result = null;
      await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(docRef);
        if (!latest.exists) return;
        const reservations = await Promise.all(nextKeys.map((key) => transaction.get(uniqueKeysRef.doc(key))));
        if (reservations.some((reservation) => reservation.exists && reservation.data().vendorId !== id)) {
          throw duplicateVendorError();
        }

        transaction.update(docRef, updates);
        nextKeys.forEach((key) => transaction.set(uniqueKeysRef.doc(key), {
          vendorId: id,
          key,
          createdAt: latest.data().createdAt || updates.updatedAt,
        }));
        previousKeys.filter((key) => !nextKeys.includes(key)).forEach((key) => transaction.delete(uniqueKeysRef.doc(key)));
        result = { id, ...latest.data(), ...updates };
      });
      return result;
    } catch (error) {
      console.error('vendorsService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      const docRef = collectionRef.doc(id);
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const vendor = doc.data();
        transaction.delete(docRef);
        vendorUniqueKeys(vendor, { allowMissingCompany: true }).forEach((key) => transaction.delete(uniqueKeysRef.doc(key)));
      });
    } catch (error) {
      console.error('vendorsService.delete error:', error);
      throw error;
    }
  },

  async importFromOdoo(options) {
    return importOdooVendors(options);
  },

  /** Synchronize local vendors to Odoo Fleet/Purchase Contacts, then import
   * Odoo-side changes. It also repairs vendors created before outbound sync. */
  async syncAllWithOdoo() {
    if (!isOdooEnabled()) {
      return { total: 0, synced: 0, failed: 0, errors: [], imported: 0, updatedFromOdoo: 0, disabled: true };
    }

    const snapshot = await collectionRef.get();
    const result = { total: snapshot.size, synced: 0, failed: 0, errors: [], imported: 0, updatedFromOdoo: 0 };
    for (const doc of snapshot.docs) {
      try {
        const vendor = { id: doc.id, ...doc.data() };
        const odooFields = await syncVendor(vendor);
        await doc.ref.update({ ...odooFields, updatedAt: new Date().toISOString() });
        result.synced += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ id: doc.id, code: error.code || 'ODOO_VENDOR_SYNC_FAILED' });
        console.error(`[Odoo] Failed to synchronize vendor ${doc.id}: ${error.message}`);
      }
    }

    const imported = await importOdooVendors();
    result.imported = imported.imported;
    result.updatedFromOdoo = imported.updatedFromOdoo;
    return result;
  },

  startOdooSync() {
    if (!isOdooEnabled()) return { status: 'disabled', result: { code: 'ODOO_DISABLED' }, startedAt: null, completedAt: null };
    if (odooSyncJob.status === 'running') return odooSyncJob;

    odooSyncJob = { status: 'running', result: null, startedAt: new Date().toISOString(), completedAt: null };
    void vendorsService.syncAllWithOdoo()
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

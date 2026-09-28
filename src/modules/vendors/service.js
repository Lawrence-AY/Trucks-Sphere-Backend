const { db } = require('../../../config/firebase');
const { getAuth } = require('firebase-admin/auth');
const { getNextId } = require('../../utils/counterService');
const snapshotStore = require('../../utils/snapshotStore');
const { assertStrongPassword } = require('../../utils/passwordPolicy');
const kraService = require('../../integrations/kraService');
const collectionRef = db.collection('vendors');
const uniqueKeysRef = db.collection('vendorUniqueKeys');

const COLLECTION_NAME = 'vendors';

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
    const [, existingVendors] = await Promise.all([
      Promise.all(uniqueKeys.map((key) => transaction.get(uniqueKeysRef.doc(key)))),
      transaction.get(collectionRef),
    ]);
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

    // Stable vendor-number ordering also keeps paginated filter options fixed.
    results = [...results].sort((a, b) => {
      return String(a.vendorId || a.id).localeCompare(String(b.vendorId || b.id), 'en', { numeric: true, sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id));
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
      const kra = data.kraPin ? await kraService.validatePin(data.kraPin) : null;
      if (kra?.companyName && !data.companyName) data = { ...data, companyName: kra.companyName };
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
  async createWithAccount({ vendor = {}, account = {} }, existingVendorId = null) {
    const email = String(account.email || vendor.email || '').trim().toLowerCase();
    const password = account.password;
    assertStrongPassword(password);
    if (!vendor.companyName || !vendor.contactPerson || !vendor.phone) {
      throw Object.assign(new Error('Company name, contact person, and phone number are required'), { statusCode: 400 });
    }
    const kra = vendor.kraPin ? await kraService.validatePin(vendor.kraPin) : null;
    if (kra?.companyName && !vendor.companyName) vendor = { ...vendor, companyName: kra.companyName };

    const uniqueKeys = vendorUniqueKeys(vendor);
    const username = await generateUniqueUsername(vendor.contactPerson);
    const authEmail = email || `${username}@users.trucksphere.local`;
    const vendorId = existingVendorId || await getNextId('vendor');
    const now = new Date().toISOString();
    let authUser;

    try {
      authUser = await getAuth().createUser({
        email: authEmail,
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
        createdAt: vendor.createdAt || now,
        updatedAt: now,
      };
      const { firstName, lastName } = splitName(vendor.contactPerson);
      const userItem = {
        id: authUser.uid,
        uid: authUser.uid,
        authUid: authUser.uid,
        email,
        authEmail,
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
        if (existingVendorId) {
          const current = await transaction.get(collectionRef.doc(existingVendorId));
          const linkedUsers = await transaction.get(db.collection('users').where('vendorId', '==', existingVendorId));
          if (!current.exists || current.data().userId || !linkedUsers.empty) {
            throw Object.assign(new Error('Vendor not found or already has a login account.'), { statusCode: 409, code: 'VENDOR_ACCOUNT_ALREADY_EXISTS' });
          }
        }
        const [, existingVendors] = await Promise.all([
          Promise.all(uniqueKeys.map((key) => transaction.get(uniqueKeysRef.doc(key)))),
          transaction.get(collectionRef),
        ]);
            const hasLegacyDuplicate = existingVendors.docs.filter((existing) => existing.id !== existingVendorId).some((existing) =>
          vendorUniqueKeys(existing.data(), { allowMissingCompany: true }).some((key) => uniqueKeys.includes(key)),
        );
        if (hasLegacyDuplicate) throw duplicateVendorError();

        if (existingVendorId) transaction.set(collectionRef.doc(vendorId), { userId: authUser.uid, email, updatedAt: now }, { merge: true });
        else transaction.set(collectionRef.doc(vendorId), vendorItem);
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

  async createAccount(id, account) {
    const current = await collectionRef.doc(id).get();
    if (!current.exists) throw Object.assign(new Error('Vendor not found'), { statusCode: 404 });
    return vendorsService.createWithAccount({ vendor: current.data(), account }, id);
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
};

module.exports = vendorsService;

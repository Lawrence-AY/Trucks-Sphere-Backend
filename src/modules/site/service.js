const { db } = require('../../../config/firebase');
const snapshotStore = require('../../utils/snapshotStore');
const collectionRef = db.collection('sites');
const geolocationCollectionRef = db.collection('siteGeolocations');

const COLLECTION_NAME = 'sites';

const siteService = {
  findAll(query = {}) {
    const { search, status, page = 1, limit = 50 } = query;

    let results = snapshotStore.getAll(COLLECTION_NAME);

    results = [...results].sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );

    if (status) results = results.filter(item => item.status === status);
    if (search) {
      const s = search.toLowerCase();
      results = results.filter(item =>
        (item.name || '').toLowerCase().includes(s) ||
        (item.location?.address || '').toLowerCase().includes(s)
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
      console.error('siteService.create error:', error);
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
      console.error('siteService.update error:', error);
      throw error;
    }
  },

  async delete(id) {
    try {
      await collectionRef.doc(id).delete();
    } catch (error) {
      console.error('siteService.delete error:', error);
      throw error;
    }
  },

  // ─── Geolocation ──────────────────────────────────────────────

  /**
   * Record a site operator's GPS position.
   * Stored in the `siteGeolocations` Firestore collection.
   *
   * @param {object} params
   * @param {string} params.siteId       - Site ID (e.g., "s1")
   * @param {number} params.latitude      - GPS latitude
   * @param {number} params.longitude     - GPS longitude
   * @param {number|null} params.accuracy - GPS accuracy in meters
   * @param {string} params.operatorEmail - Email of the operator
   * @param {string} params.operatorName  - Display name of the operator
   * @param {string} params.notes         - Optional notes
   * @param {string} params.recordedBy    - Email of who recorded it
   * @returns {Promise<object>} The saved geolocation record
   */
  async recordGeolocation({ siteId, latitude, longitude, accuracy, operatorEmail, operatorName, notes, recordedBy }) {
    try {
      const now = new Date().toISOString();
      const docRef = geolocationCollectionRef.doc(); // Auto-generated ID

      const record = {
        id: docRef.id,
        siteId,
        latitude,
        longitude,
        accuracy: accuracy || null,
        operatorEmail,
        operatorName,
        notes: notes || '',
        recordedBy,
        timestamp: now,
        createdAt: now,
        updatedAt: now,
      };

      await docRef.set(record);

      // Also update the site document with the latest position (optional, for convenience)
      try {
        await collectionRef.doc(siteId).update({
          'lastGeolocation': {
            latitude,
            longitude,
            accuracy: accuracy || null,
            recordedAt: now,
            recordedBy: operatorEmail,
          },
          updatedAt: now,
        });
      } catch (updateErr) {
        // Non-fatal — the geolocation record is still saved
        console.warn('siteService: Could not update site lastGeolocation:', updateErr.message);
      }

      return record;
    } catch (error) {
      console.error('siteService.recordGeolocation error:', error);
      throw error;
    }
  },

  /**
   * Get paginated geolocation history for a site.
   *
   * @param {string} siteId  - Site ID
   * @param {object} options - { page, limit, from, to }
   * @returns {Promise<object>} Paginated results
   */
  async getGeolocations(siteId, { page = 1, limit = 50, from, to } = {}) {
    try {
      let query = geolocationCollectionRef
        .where('siteId', '==', siteId)
        .orderBy('timestamp', 'desc');

      if (from) {
        query = query.where('timestamp', '>=', from);
      }
      if (to) {
        query = query.where('timestamp', '<=', to);
      }

      const snapshot = await query.limit(parseInt(limit)).offset((page - 1) * parseInt(limit)).get();

      // Get total count (simplified — for exact count use a separate aggregate query)
      const countSnapshot = await geolocationCollectionRef
        .where('siteId', '==', siteId)
        .count()
        .get();

      const total = countSnapshot.data()?.count || 0;

      const data = [];
      snapshot.forEach((doc) => data.push({ id: doc.id, ...doc.data() }));

      return {
        data,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
      };
    } catch (error) {
      console.error('siteService.getGeolocations error:', error);
      throw error;
    }
  },
};

module.exports = siteService;
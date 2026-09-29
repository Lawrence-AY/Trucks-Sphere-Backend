/**
 * Public Tracking Controller
 *
 * Handles public (unauthenticated) tracking page requests.
 * These endpoints DO NOT require authentication — they are public URLs.
 */

const trackingService = require('./service');
const { isValidTrackingId } = require('../../utils/trackingUtils');
const { db } = require('../../../config/firebase');
const crypto = require('crypto');
const { sendSMS, isSmsConfigured } = require('../sms/service');
const { siteFlagReason } = require('./siteFlags');

const securityCode = () => crypto.randomInt(36 ** 5).toString(36).toUpperCase().padStart(5, '0');

const now = () => new Date().toISOString();
const SECURITY_LOCATIONS = new Set(['gate', 'checkpoint 1', 'checkpoint 2', 'checkpoint 3']);

const SESSION_ABSOLUTE_TTL_MS = 20 * 60 * 1000; // 20-minute absolute expiry
const SESSION_IDLE_TTL_MS = 5 * 60 * 1000; // 5-minute idle timeout

function isSessionUsable(sessionData = {}) {
  const nowMs = Date.now();
  const expiresAt = sessionData.expiresAt ? new Date(sessionData.expiresAt).getTime() : 0;
  const lastActivityAt = sessionData.lastActivityAt
    ? new Date(sessionData.lastActivityAt).getTime()
    : sessionData.startedAt ? new Date(sessionData.startedAt).getTime() : nowMs;
  return expiresAt > nowMs && (nowMs - lastActivityAt) <= SESSION_IDLE_TTL_MS;
}

async function notifyFlagStakeholders(order, flag, resolved = false, denied = false) {
  const siteFlag = flag.source === 'operator_site';
  const users = await db.collection('users').get();
  const userIds = users.docs.filter((doc) => {
    const user = doc.data();
    return (Boolean(order.vendorId) && (user.vendorId === order.vendorId || user.entityId === order.vendorId)) || ['admin', 'admin_edit', 'management', 'management_edit', 'management_lite', 'superadmin', 'super_admin'].includes(String(user.role || '').toLowerCase());
  }).map((doc) => doc.id);
  const action = resolved ? 'cleared' : 'flagged';
  const reason = resolved ? flag.resolutionReason : flag.reason;
  const notificationResults = await Promise.allSettled([...new Set(userIds)].map((userId) => db.collection('notifications').add({
    userId, read: false, createdAt: now(),
    title: siteFlag ? 'Site delivery flagged' : denied ? 'Warehouse delivery denied' : resolved ? 'Driver and truck unsuspended' : 'Security flag raised',
    message: siteFlag ? `Site operator ${flag.flaggedBy || 'Site operator'} flagged job ${order.jobId || order.id}: ${reason}` : denied ? `Warehouse delivery ${order.jobId || order.id} was denied: ${reason}` : resolved
      ? `${order.driverName || 'Driver'} and ${order.plateNumber || 'truck'} have been unsuspended${reason ? `: ${reason}` : '.'}`
      : `${order.driverName || 'Driver'} and ${order.plateNumber || 'truck'} were ${action}${reason ? `: ${reason}` : '.'}`,
    type: siteFlag ? 'site_delivery_flagged' : denied ? 'warehouse_delivery_denied' : resolved ? 'security_flag_cleared' : 'security_flagged', jobId: order.id,
    vendorId: order.vendorId || '', driverId: order.driverId || '', vehicleId: order.vehicleId || '', flag,
  })));
  if (notificationResults.some((result) => result.status === 'rejected')) console.error('[Tracking] Some stakeholder notifications could not be saved.');

  // Site weight variance notifications are in-app only.
  if (!siteFlag && isSmsConfigured()) {
    const vendor = order.vendorId ? await db.collection('vendors').doc(order.vendorId).get() : null;
    const phones = users.docs
      .filter((doc) => {
        const user = doc.data();
        return (Boolean(order.vendorId) && (user.vendorId === order.vendorId || user.entityId === order.vendorId)) || ['admin', 'admin_edit',  'management', 'management_edit', 'management_lite', 'superadmin', 'super_admin'].includes(String(user.role || '').toLowerCase());
      })
      .map((doc) => {
        const user = doc.data();
        return user.phone || user.phoneNumber || user.mobile || '';
      });
    if (vendor?.exists) phones.push(vendor.data().phone || vendor.data().mobile || '');
    const message = siteFlag ? `TruckSphere ALERT: Site operator ${flag.flaggedBy || 'Site operator'} flagged job ${order.jobId || order.id}. Reason: ${reason}` : denied ? `TruckSphere ALERT: Warehouse delivery ${order.jobId || order.id} was denied. Reason: ${reason}` : resolved
      ? `TruckSphere UPDATE: Driver ${order.driverName || 'Unknown'}, Truck ${order.plateNumber || 'Unknown'} have been unsuspended. Reason: ${flag.resolutionReason || 'Security flag cleared.'}`
      : `TruckSphere ALERT: Driver ${order.driverName || 'Unknown'}, Truck ${order.plateNumber || 'Unknown'} has been flagged. Reason: ${flag.reason || 'Security review required.'}`;
    // SMS delivery must never delay or undo the security flag transaction.
    await Promise.all([...new Set(phones.filter(Boolean))].map(async (phone) => {
      const result = await sendSMS(phone, message);
      if (!result.success) console.error('[Tracking] Stakeholder SMS delivery failed.');
    })).catch((error) => {
      console.error(`[Tracking] ${resolved ? 'Unsuspension' : 'Flag'} SMS dispatch failed:`, error.message);
    });
  }
}

exports.listSecurityPersonnel = async (_req, res, next) => {
  try { const snap = await db.collection('securityCodes').orderBy('name').get(); res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))); } catch (err) { next(err); }
};
exports.createSecurityPersonnel = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const location = String(req.body?.location || '').trim();
    if (!name || !location) return res.status(400).json({ code: 'SECURITY_PERSONNEL_DETAILS_REQUIRED', error: 'Personnel name and location are required.' });
    if (!SECURITY_LOCATIONS.has(location.toLowerCase())) return res.status(400).json({ code: 'INVALID_SECURITY_LOCATION', error: 'Choose gate, checkpoint 1, checkpoint 2, or checkpoint 3.' });
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = securityCode();
      const matches = await Promise.all(['securityCodes', 'securityPersonnel'].map((collection) => db.collection(collection).where('securityCode', '==', code).limit(1).get()));
      if (matches.some((snapshot) => !snapshot.empty)) continue;
      const record = { name, location, phone: String(req.body?.phone || '').trim(), securityCode: code, isActive: true, createdAt: new Date().toISOString(), createdBy: req.user?.uid || '' };
      const doc = db.collection('securityCodes').doc(code);
      try { await doc.create(record); return res.status(201).json({ id: doc.id, ...record }); }
      catch (error) { if (error.code !== 6 && error.code !== 'already-exists') throw error; }
    }
    throw new Error('Unable to allocate a unique security code.');
  } catch (err) { next(err); }
};
exports.startSecuritySession = async (req, res, next) => {
  try {
    const code = String(req.body?.securityCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return res.status(400).json({ error: 'A valid security code is required.' });
    let personnel = await db.collection('securityCodes').where('securityCode', '==', code).limit(1).get();
    if (!personnel.empty && personnel.docs[0].data().isActive !== true) personnel = { empty: true };
    // Existing deployed records remain valid while the new collection rolls out.
    if (personnel.empty) {
      personnel = await db.collection('securityPersonnel').where('securityCode', '==', code).limit(1).get();
      if (!personnel.empty && personnel.docs[0].data().isActive !== true) personnel = { empty: true };
    }
    if (personnel.empty) return res.status(403).json({ error: 'Invalid security code.' });
    const person = personnel.docs[0]; const token = crypto.randomBytes(24).toString('hex');
    const started = now();
    const record = { token, plateNumber: '', personnelId: person.id, personnelName: person.data().name, securityLocation: person.data().location || '', orderId: '', startedAt: started, startLocation: req.body?.location || null, status: 'active', expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS).toISOString(), lastActivityAt: started };
    const doc = await db.collection('trackingSecuritySessions').add(record); res.status(201).json({ id: doc.id, token, personnelName: record.personnelName, securityLocation: record.securityLocation, expiresAt: record.expiresAt });
  } catch (err) { next(err); }
};
exports.attachSecuritySessionVehicle = async (req, res, next) => {
  try {
    const session = await db.collection('trackingSecuritySessions').doc(req.params.sessionId).get();
    const token = String(req.body?.token || '');
    const plateNumber = String(req.body?.plateNumber || '').trim().toUpperCase();
    const sessionData = session.data() || {};
    if (!session.exists || sessionData.token !== token) {
      return res.status(403).json({ error: 'Invalid security session.' });
    }
    if (!isSessionUsable(sessionData)) {
      return res.status(403).json({ error: 'Security session expired. Please start a new session.' });
    }
    if (plateNumber.length < 3) return res.status(400).json({ error: 'Enter a valid vehicle registration number.' });
    const order = trackingService.findByPlate(plateNumber);
    if (req.file && !req.file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'The driver photo must be an image.' });
    let driverPhotoURL = '';
    if (req.file) {
      const { uploadFile } = require('../../utils/cloudStorage');
      const result = await uploadFile(req.file.buffer, req.file.originalname, 'SecurityDriverPhotos', session.id, req.file.mimetype);
      driverPhotoURL = result.url;
    }
    const photosCaptured = Boolean(driverPhotoURL);
    await session.ref.update({ plateNumber, orderId: order?.id || '', vehicleSelectedAt: now(), driverPhotoURL, photosCaptured, photosCapturedAt: photosCaptured ? now() : null, status: 'active', decidedAt: null, reason: '', lastActivityAt: now() });
    return res.json({ id: session.id, plateNumber, orderId: order?.id || '' });
  } catch (err) { next(err); }
};
exports.recordSecurityDecision = async (req, res, next) => {
  try {
    const session = await db.collection('trackingSecuritySessions').doc(req.params.sessionId).get();
    const body = req.body || {};
    const sessionData = session.data() || {};
    if (!session.exists || sessionData.token !== body.token) return res.status(403).json({ error: 'Invalid security session.' });
    if (!isSessionUsable(sessionData)) return res.status(403).json({ error: 'Security session expired. Please start a new session.' });
    const outcome = body.outcome === 'flagged' ? 'flagged' : body.outcome === 'verified' ? 'verified' : '';
    if (!outcome || (outcome === 'flagged' && !String(body.reason || '').trim())) return res.status(400).json({ error: 'A flagged trip requires a reason.' });
    if (String(sessionData.securityLocation || '').trim().toLowerCase() === 'gate' && !sessionData.driverPhotoURL) return res.status(400).json({ error: 'Capture the driver photo at the gate before continuing.' });
    const update = { status: outcome, reason: outcome === 'flagged' ? String(body.reason).trim() : '', decidedAt: now(), decisionLocation: body.location || null, decidedBy: sessionData.personnelName, lastActivityAt: now() };
    await session.ref.update(update);
    if (outcome === 'flagged') {
      const order = trackingService.findByPlate(sessionData.plateNumber);
      if (order) {
        const flag = { status: 'flagged', source: 'security_tracking', reason: update.reason, flaggedAt: update.decidedAt, flaggedBy: update.decidedBy, flagLocation: update.decisionLocation || sessionData.startLocation || null, securityLocation: sessionData.securityLocation || '', sessionId: session.id, driverId: order.driverId || '', vehicleId: order.vehicleId || '' };
        const batch = db.batch();
        batch.set(db.collection('deliveryOrders').doc(order.id), { securityFlag: flag, isFlagged: true, updatedAt: now() }, { merge: true });
        if (order.driverId) batch.set(db.collection('drivers').doc(order.driverId), { status: 'suspended', securityFlag: flag, updatedAt: now() }, { merge: true });
        if (order.vehicleId) batch.set(db.collection('vehicles').doc(order.vehicleId), { status: 'suspended', securityFlag: flag, updatedAt: now() }, { merge: true });
        await batch.commit();
        await notifyFlagStakeholders(order, flag);
      }
    }
    res.json({ id: session.id, ...sessionData, ...update });
  } catch (err) { next(err); }
};

exports.listFlags = async (_req, res, next) => {
  try {
    // `isFlagged` is the current indexed field. Include the nested flag
    // status as well so records flagged before that field was introduced are
    // still visible to operators and administrators.
    const [indexedFlags, legacyFlags, clearedSecurityFlags, arrivalVarianceFlags, receiptVarianceFlags, arrivalStatusFlags] = await Promise.all([
      db.collection('deliveryOrders').where('isFlagged', '==', true).get(),
      db.collection('deliveryOrders').where('securityFlag.status', '==', 'flagged').get(),
      db.collection('deliveryOrders').where('securityFlag.status', '==', 'cleared').get(),
      db.collection('deliveryOrders').where('siteArrivalWeightVarianceFlagged', '==', true).get(),
      db.collection('deliveryOrders').where('hasWeightDiscrepancy', '==', true).get(),
      db.collection('deliveryOrders').where('siteArrivalWeightVarianceStatus', '==', 'flagged').get(),
    ]);
    const flagsById = new Map();
    [...indexedFlags.docs, ...legacyFlags.docs, ...clearedSecurityFlags.docs, ...arrivalVarianceFlags.docs, ...receiptVarianceFlags.docs, ...arrivalStatusFlags.docs].forEach((doc) => {
      const item = { id: doc.id, ...doc.data() };
      if (
        item.securityFlag?.status === 'flagged' ||
        item.securityFlag?.status === 'cleared' ||
        item.isFlagged === true ||
        item.siteArrivalWeightVarianceFlagged === true ||
        item.hasWeightDiscrepancy === true || item.siteArrivalWeightVarianceStatus === 'flagged'
      ) {
        flagsById.set(doc.id, { ...item, siteFlagReason: siteFlagReason(item) });
      }
    });
    res.json([...flagsById.values()].sort((a, b) => String(
      b.securityFlag?.clearedAt || b.securityFlag?.flaggedAt || b.siteArrivalWeightCapturedAt || b.updatedAt || ''
    ).localeCompare(String(
      a.securityFlag?.clearedAt || a.securityFlag?.flaggedAt || a.siteArrivalWeightCapturedAt || a.updatedAt || ''
    ))));
  } catch (err) { next(err); }
};

exports.clearFlag = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to clear a flag.' });
    const ref = db.collection('deliveryOrders').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || !doc.data().securityFlag) return res.status(404).json({ error: 'Flagged delivery not found.' });
    const order = { id: doc.id, ...doc.data() };
    const flag = { ...order.securityFlag, status: 'cleared', clearedAt: now(), clearedBy: req.user?.displayName || req.user?.email || req.user?.uid || 'Administrator', clearedByUid: req.user?.uid || '', resolutionReason: reason };
    const batch = db.batch();
    batch.set(ref, { isFlagged: false, securityFlag: flag, updatedAt: now() }, { merge: true });
    if (order.driverId) batch.set(db.collection('drivers').doc(order.driverId), { status: 'active', securityFlag: flag, updatedAt: now() }, { merge: true });
    if (order.vehicleId) batch.set(db.collection('vehicles').doc(order.vehicleId), { status: 'active', securityFlag: flag, updatedAt: now() }, { merge: true });
    await batch.commit();
    const snapshots = require('../../utils/snapshotStore');
    const updated = snapshots.applyCommittedUpdate('deliveryOrders', order.id, { ...order, isFlagged: false, securityFlag: flag, updatedAt: flag.clearedAt });
    if (order.driverId) snapshots.applyCommittedUpdate('drivers', order.driverId, { status: 'active', securityFlag: flag, updatedAt: flag.clearedAt });
    if (order.vehicleId) snapshots.applyCommittedUpdate('vehicles', order.vehicleId, { status: 'active', securityFlag: flag, updatedAt: flag.clearedAt });
    void notifyFlagStakeholders(order, flag, true).catch((error) => console.error('[Tracking] Clearance notification failed:', error.message));
    res.json(updated);
  } catch (err) { next(err); }
};

/**
 * GET /track/:trackingId
 *
 * Public endpoint to fetch tracking data for a delivery job.
 * Returns 404 if:
 *   - The tracking ID format is invalid
 *   - No delivery order matches the tracking ID
 *   - The delivery is no longer in an active (in-transit) state
 *
 * No authentication required — this is a public URL.
 */
exports.getTrackingPage = async (req, res, next) => {
  try {
    const { trackingId } = req.params;

    // Validate tracking ID format
    if (!trackingId || !isValidTrackingId(trackingId)) {
      return res.status(404).json({
        error: 'This tracking link is invalid or has expired.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    // Look up the delivery order
    const order = trackingService.findByTrackingId(trackingId);

    if (!order) {
      return res.status(404).json({
        error: 'This tracking link has expired or is no longer active.',
        code: 'TRACKING_EXPIRED',
      });
    }

    // Return sanitized public data
    const publicData = trackingService.sanitizeForPublic(order);
    return res.json(publicData);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /track/by-plate/:plateNumber
 *
 * Public endpoint to fetch tracking data by vehicle plate number.
 */
exports.getTrackingByPlate = async (req, res, next) => {
  try {
    const { plateNumber } = req.params;

    if (!plateNumber || plateNumber.length < 3) {
      return res.status(404).json({
        error: 'No active delivery found for this vehicle plate.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    const order = trackingService.findByPlate(plateNumber);

    if (!order) {
      return res.status(404).json({
        error: 'No active delivery found for this vehicle plate.',
        code: 'TRACKING_NOT_FOUND',
      });
    }

    const publicData = trackingService.sanitizeForPublic(order);
    return res.json(publicData);
  } catch (err) {
    next(err);
  }
};

exports.notifyWarehouseDenial = (order) => notifyFlagStakeholders(order, { reason: order.warehouseDenialReason }, false, true);

exports.notifySiteFlag = (order, flag) => notifyFlagStakeholders(order, flag);

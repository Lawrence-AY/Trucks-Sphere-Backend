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

const securityCode = () => crypto.randomBytes(4).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5);

const now = () => new Date().toISOString();

async function notifyFlagStakeholders(order, flag, resolved = false) {
  const users = await db.collection('users').get();
  const userIds = users.docs.filter((doc) => {
    const user = doc.data();
    return user.vendorId === order.vendorId || user.entityId === order.vendorId || ['admin', 'admin_edit', 'superadmin', 'super_admin'].includes(String(user.role || '').toLowerCase());
  }).map((doc) => doc.id);
  const action = resolved ? 'cleared' : 'flagged';
  const reason = resolved ? flag.resolutionReason : flag.reason;
  await Promise.all([...new Set(userIds)].map((userId) => db.collection('notifications').add({
    userId, read: false, createdAt: now(),
    title: resolved ? 'Driver and truck unsuspended' : 'Security flag raised',
    message: resolved
      ? `${order.driverName || 'Driver'} and ${order.plateNumber || 'truck'} have been unsuspended${reason ? `: ${reason}` : '.'}`
      : `${order.driverName || 'Driver'} and ${order.plateNumber || 'truck'} were ${action}${reason ? `: ${reason}` : '.'}`,
    type: resolved ? 'security_flag_cleared' : 'security_flagged', jobId: order.id,
    vendorId: order.vendorId || '', driverId: order.driverId || '', vehicleId: order.vehicleId || '', flag,
  })));

  if (isSmsConfigured()) {
    const vendor = order.vendorId ? await db.collection('vendors').doc(order.vendorId).get() : null;
    const phones = users.docs
      .filter((doc) => {
        const user = doc.data();
        return user.vendorId === order.vendorId || user.entityId === order.vendorId || ['admin', 'admin_edit', 'superadmin', 'super_admin'].includes(String(user.role || '').toLowerCase());
      })
      .map((doc) => {
        const user = doc.data();
        return user.phone || user.phoneNumber || user.mobile || '';
      });
    if (vendor?.exists) phones.push(vendor.data().phone || vendor.data().mobile || '');
    const message = resolved
      ? `TruckSphere UPDATE: Driver ${order.driverName || 'Unknown'} / truck ${order.plateNumber || 'Unknown'} have been unsuspended. Reason: ${flag.resolutionReason || 'Security flag cleared.'}`
      : `TruckSphere ALERT: Driver ${order.driverName || 'Unknown'} / truck ${order.plateNumber || 'Unknown'} has been flagged. Reason: ${flag.reason || 'Security review required.'}`;
    // SMS delivery must never delay or undo the security flag transaction.
    void Promise.all([...new Set(phones.filter(Boolean))].map((phone) => sendSMS(phone, message))).catch((error) => {
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
    if (!name) return res.status(400).json({ error: 'Personnel name is required.' });
    let code = securityCode();
    while ((await db.collection('securityCodes').where('securityCode', '==', code).limit(1).get()).size) code = securityCode();
    const record = { name, location: String(req.body?.location || ''), phone: String(req.body?.phone || ''), securityCode: code, isActive: true, createdAt: new Date().toISOString(), createdBy: req.user?.uid || '' };
    const doc = await db.collection('securityCodes').add(record); res.status(201).json({ id: doc.id, ...record });
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
    const record = { token, plateNumber: '', personnelId: person.id, personnelName: person.data().name, securityLocation: person.data().location || '', orderId: '', startedAt: now(), startLocation: req.body?.location || null, status: 'active' };
    const doc = await db.collection('trackingSecuritySessions').add(record); res.status(201).json({ id: doc.id, token, personnelName: record.personnelName });
  } catch (err) { next(err); }
};
exports.attachSecuritySessionVehicle = async (req, res, next) => {
  try {
    const session = await db.collection('trackingSecuritySessions').doc(req.params.sessionId).get();
    const token = String(req.body?.token || '');
    const plateNumber = String(req.body?.plateNumber || '').trim().toUpperCase();
    if (!session.exists || session.data().token !== token || session.data().status !== 'active') {
      return res.status(403).json({ error: 'Invalid security session.' });
    }
    if (plateNumber.length < 3) return res.status(400).json({ error: 'Enter a valid vehicle registration number.' });
    const order = trackingService.findByPlate(plateNumber);
    await session.ref.update({ plateNumber, orderId: order?.id || '', vehicleSelectedAt: now() });
    return res.json({ id: session.id, plateNumber, orderId: order?.id || '' });
  } catch (err) { next(err); }
};
exports.recordSecurityDecision = async (req, res, next) => {
  try {
    const session = await db.collection('trackingSecuritySessions').doc(req.params.sessionId).get();
    const body = req.body || {}; if (!session.exists || session.data().token !== body.token) return res.status(403).json({ error: 'Invalid security session.' });
    const outcome = body.outcome === 'flagged' ? 'flagged' : body.outcome === 'verified' ? 'verified' : '';
    if (!outcome || (outcome === 'flagged' && !String(body.reason || '').trim())) return res.status(400).json({ error: 'A flagged trip requires a reason.' });
    const sessionData = session.data();
    const update = { status: outcome, reason: outcome === 'flagged' ? String(body.reason).trim() : '', decidedAt: now(), decisionLocation: body.location || null, decidedBy: sessionData.personnelName };
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
    const [indexedFlags, legacyFlags, clearedSecurityFlags, arrivalVarianceFlags, receiptVarianceFlags] = await Promise.all([
      db.collection('deliveryOrders').where('isFlagged', '==', true).get(),
      db.collection('deliveryOrders').where('securityFlag.status', '==', 'flagged').get(),
      db.collection('deliveryOrders').where('securityFlag.status', '==', 'cleared').get(),
      db.collection('deliveryOrders').where('siteArrivalWeightVarianceFlagged', '==', true).get(),
      db.collection('deliveryOrders').where('hasWeightDiscrepancy', '==', true).get(),
    ]);
    const flagsById = new Map();
    [...indexedFlags.docs, ...legacyFlags.docs, ...clearedSecurityFlags.docs, ...arrivalVarianceFlags.docs, ...receiptVarianceFlags.docs].forEach((doc) => {
      const item = { id: doc.id, ...doc.data() };
      if (
        item.securityFlag?.status === 'flagged' ||
        item.securityFlag?.status === 'cleared' ||
        item.isFlagged === true ||
        item.siteArrivalWeightVarianceFlagged === true ||
        item.hasWeightDiscrepancy === true
      ) {
        flagsById.set(doc.id, item);
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
    await notifyFlagStakeholders(order, flag, true);
    res.json({ id: order.id, isFlagged: false, securityFlag: flag });
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

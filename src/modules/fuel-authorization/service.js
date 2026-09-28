const { receiptReference } = require('../../utils/receiptReference');
const snapshotStore = require('../../utils/snapshotStore');
const { isSupersededForFuel } = require('../../utils/fuelEligibility');
/**
 * Fuel Authorization Service
 * Handles the fuel authorization workflow:
 * 1. Operator initiates fuel dispense → OTP sent to vendor
 * 2. Vendor verifies OTP → Authorizes or denies
 * 3. Operator proceeds with fuel dispense if authorized
 */
const { db } = require('../../../config/firebase');
const { getNextId } = require('../../utils/counterService');
const { sendSMS, generateOTP } = require('../sms/service');
const girService = require('../../integrations/girService');

const authCollectionRef = db.collection('fuelAuthorizations');
const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function temporaryFuelCode() {
  let code = '';
  for (let i = 0; i < 3; i += 1) code += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
  return code;
}

/**
 * Create a new fuel authorization request.
 * Generates an OTP, sends it via SMS to the vendor contact,
 * stores the authorization record in Firestore.
 *
 * @param {Object} params
 * @param {string} params.vendorId - Vendor ID
 * @param {string} params.vendorName - Vendor name / company name
 * @param {string} params.vendorPhone - Vendor phone number for SMS OTP
 * @param {string} params.driverId - Driver ID
 * @param {string} params.driverName - Driver name
 * @param {string} params.driverPhone - Driver phone number (optional, for reference)
 * @param {string} params.vehicleId - Truck/Vehicle ID
 * @param {string} params.plateNumber - Truck plate number
 * @param {string} params.requestedBy - Operator email/name who initiated
 * @param {string} params.requestedByEmail - Operator email
 * @param {number} params.fuelAmount - Requested fuel amount in litres
 * @param {string} params.jobId - Optional: linked Job ID
 * @returns {Promise<{ id: string; expiresAt: string }>}
 */
async function createAuthorization(params) {
  const {
    vendorId, vendorName, vendorPhone,
    driverId, driverCode, driverName, driverPhone,
    vehicleId, plateNumber,
    requestedBy, requestedByEmail,
    fuelAmount = 0,
    jobId = null,
  } = params;

  if (!vendorId) throw new Error('vendorId is required');
  if (!driverId) throw new Error('driverId is required');
  if (!vehicleId) throw new Error('vehicleId is required');

  const jobs = snapshotStore.getAll('deliveryOrders');
  const job = jobs.find((item) => item.jobId === jobId || item.id === jobId);
  if (job && isSupersededForFuel(job, jobs)) throw Object.assign(new Error('This driver or truck has a newer job. Refresh the fuel queue.'), { statusCode: 409, code: 'FUEL_JOB_SUPERSEDED' });

  // Generate 6-digit OTP
  const otp = generateOTP();

  // OTP expires in 10 minutes
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const authId = `FAUTH-${Date.now().toString(36).toUpperCase()}`;

  const doc = {
    id: authId,
    vendorId,
    vendorName: vendorName || '',
    vendorPhone: vendorPhone || '',
    driverId,
    driverCode: driverCode || '',
    driverName: driverName || '',
    driverPhone: driverPhone || '',
    vehicleId,
    plateNumber: plateNumber || '',
    requestedBy: requestedBy || '',
    requestedByEmail: requestedByEmail || '',
    fuelAmount: fuelAmount || 0,
    jobId: jobId || null,
    otp, // stored temporarily for verification
    status: 'pending', // pending | authorized | denied | expired
    createdAt,
    expiresAt,
    authorizedAt: null,
    deniedAt: null,
    updatedAt: createdAt,
  };

  await authCollectionRef.doc(authId).set(doc);

  // Send OTP via SMS to vendor
  if (vendorPhone) {
    const message = `TruckSphere: Fuel Authorization PIN is ${otp}. Driver: ${driverName || driverId}, Truck: ${plateNumber || vehicleId}. Valid for 10 min.`;
    const smsResult = await sendSMS(vendorPhone, message);
    console.log('[FuelAuth] SMS send result:', smsResult);
  } else {
    console.warn('[FuelAuth] No vendor phone provided, OTP not sent via SMS. OTP:', otp);
  }

  return {
    id: authId,
    expiresAt,
  };
}

/**
 * Verify OTP and authorize or deny the fuel request.
 * Called by the vendor side.
 *
 * @param {string} authId - The authorization request ID
 * @param {string} otp - The OTP entered by vendor
 * @param {boolean} authorize - true = authorize, false = deny
 * @returns {Promise<{ status: string; authorized: boolean; message: string }>}
 */
async function verifyOTP(authId, otp, authorize) {
  const docRef = authCollectionRef.doc(authId);
  const doc = await docRef.get();

  if (!doc.exists) {
    throw new Error('Authorization request not found');
  }

  const data = doc.data();

  // A duplicate tap/retry can arrive after the first verification completed.
  // Treat an already-authorized request as idempotent and do not activate the
  // GIR/FMS session a second time.
  if (data.status === 'authorized') {
    return {
      status: 'authorized',
      authorized: true,
      message: 'Fuel dispensing authorized successfully.',
      ...data,
      fuelCode: data.fuelCode || null,
      girDriverCode: data.girDriverCode || null,
    };
  }

  if (data.status !== 'pending') {
    throw new Error(`Authorization request is already ${data.status}`);
  }

  // Check expiry
  if (new Date(data.expiresAt) < new Date()) {
    await docRef.update({ status: 'expired', updatedAt: new Date().toISOString() });
    throw new Error('Authorization PIN has expired. Please request a new authorization.');
  }

  // Verify OTP
  if (String(data.otp) !== String(otp)) {
    throw new Error('Invalid Authorization PIN. Please check and try again.');
  }

  const now = new Date().toISOString();
  const fuelCode = temporaryFuelCode();
  const updates = {
    status: authorize ? 'authorized' : 'denied',
    updatedAt: now,
    ...(authorize ? { authorizedAt: now } : { deniedAt: now }),
    ...(authorize ? { fuelCode } : {}),
  };

  if (authorize) {
    const girSession = await girService.activateFuelSession({
      driverId: data.driverId,
      baseDriverCode: data.driverCode || data.driverId || '',
      vehicleId: data.vehicleId,
      vendorId: data.vendorId,
      jobId: receiptReference(snapshotStore.getAll('deliveryOrders').find(job => job.id === data.deliveryOrderId || job.jobId === data.jobId || job.id === data.jobId)),
      fuelCode,
    });
    updates.girDriverCode = girSession.activeCode || null;

  }

  await docRef.update(updates);

  return {
    status: updates.status,
    authorized: authorize,
    message: authorize
      ? 'Fuel dispensing authorized successfully.'
      : 'Fuel dispensing has been denied.',
    ...data,
    ...updates,
    fuelCode: updates.fuelCode || data.fuelCode || null,
    girDriverCode: updates.girDriverCode || data.girDriverCode || null,
  };
}

/**
 * Get authorization status by ID.
 * Polled by the operator fuel screen to check if vendor has responded.
 *
 * @param {string} authId
 * @returns {Promise<{ status: string; authorized: boolean }>}
 */
async function getAuthorizationStatus(authId) {
  const doc = await authCollectionRef.doc(authId).get();
  if (!doc.exists) {
    throw new Error('Authorization request not found');
  }

  const data = doc.data();

  // Auto-expire if past expiry
  if (data.status === 'pending' && new Date(data.expiresAt) < new Date()) {
    await authCollectionRef.doc(authId).update({
      status: 'expired',
      updatedAt: new Date().toISOString(),
    });
    data.status = 'expired';
  }

  return {
    id: data.id,
    status: data.status,
    authorized: data.status === 'authorized',
    vendorName: data.vendorName,
    driverName: data.driverName,
    plateNumber: data.plateNumber,
    fuelAmount: data.fuelAmount,
    expiresAt: data.expiresAt,
  };
}

/**
 * Get all pending authorizations for a vendor.
 */
async function getPendingForVendor(vendorId) {
  try {
    const snapshot = await authCollectionRef
      .where('vendorId', '==', vendorId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();

    const results = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // Don't expose OTP in list
      const { otp, ...safe } = data;
      results.push(safe);
    });
    return results;
  } catch (err) {
    // Fallback: if the composite index hasn't been deployed yet,
    // query without orderBy and sort in memory.
    if (err.code === 9 || (err.message && err.message.includes('index'))) {
      console.warn('[FuelAuth] Composite index missing, using fallback sort:', err.message);
      const snapshot = await authCollectionRef
        .where('vendorId', '==', vendorId)
        .where('status', '==', 'pending')
        .get();

      const results = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const { otp, ...safe } = data;
        results.push(safe);
      });

      // Sort in memory by createdAt descending
      results.sort((a, b) => {
        const dateA = a.createdAt || '';
        const dateB = b.createdAt || '';
        return dateB.localeCompare(dateA);
      });
      return results;
    }
    throw err;
  }
}

module.exports = {
  createAuthorization,
  verifyOTP,
  getAuthorizationStatus,
  getPendingForVendor,
};

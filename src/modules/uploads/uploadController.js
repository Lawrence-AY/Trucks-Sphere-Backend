/**
 * Upload Controller
 *
 * Endpoints for uploading files to Firebase Storage and linking them
 * to their parent entities in Firestore via the photoURL field.
 *
 * Storage folders:
 *   - driver/           → driver profile photos   → Firestore: drivers/{id}.photoURL
 *   - Deliverynotes/    → delivery note images    → Firestore: deliveryOrders/{id}.photoURL
 *   - Receipt note/     → receipt note images     → Firestore: weighRecords/{id}.photoURL
 */
const { db } = require('../../../config/firebase');
const { uploadFile, deleteFile } = require('../../utils/cloudStorage');
const upload = require('./uploadMiddleware');

/**
 * POST /api/uploads/driver-photo/:driverId
 * Upload a driver's profile photo.
 * Body: multipart/form-data with field "file"
 */
exports.uploadDriverPhoto = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { driverId } = req.params;

      // Verify driver exists
      const driverDoc = await db.collection('drivers').doc(driverId).get();
      if (!driverDoc.exists) {
        return res.status(404).json({ error: `Driver ${driverId} not found` });
      }

      // If driver already has a photoURL, delete the old file
      const existingPhoto = driverDoc.data().photoURL;
      if (existingPhoto) {
        const oldPath = extractStoragePath(existingPhoto);
        if (oldPath) await deleteFile(oldPath);
      }

      // Upload to Firebase Storage in "driver/" folder
      const { url } = await uploadFile(
        req.file.buffer,
        req.file.originalname,
        'driver',
        driverId
      );

      // Update Firestore driver record
      await db.collection('drivers').doc(driverId).update({
        photoURL: url,
        updatedAt: new Date().toISOString(),
      });

      res.json({ success: true, photoURL: url, driverId });
    } catch (err) {
      next(err);
    }
  },
];

/**
 * POST /api/uploads/delivery-note/:deliveryOrderId
 * Upload a delivery note image for a delivery order.
 * Body: multipart/form-data with field "file"
 */
exports.uploadDeliveryNote = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { deliveryOrderId } = req.params;

      // Verify delivery order exists
      const orderDoc = await db.collection('deliveryOrders').doc(deliveryOrderId).get();
      if (!orderDoc.exists) {
        return res.status(404).json({ error: `Delivery order ${deliveryOrderId} not found` });
      }

      // Delete old file if exists
      const existingPhoto = orderDoc.data().photoURL;
      if (existingPhoto) {
        const oldPath = extractStoragePath(existingPhoto);
        if (oldPath) await deleteFile(oldPath);
      }

      // Upload to "Deliverynotes/" folder
      const { url } = await uploadFile(
        req.file.buffer,
        req.file.originalname,
        'Deliverynotes',
        deliveryOrderId
      );

      // Update Firestore delivery order record
      await db.collection('deliveryOrders').doc(deliveryOrderId).update({
        photoURL: url,
        updatedAt: new Date().toISOString(),
      });

      res.json({ success: true, photoURL: url, deliveryOrderId });
    } catch (err) {
      next(err);
    }
  },
];

/**
 * POST /api/uploads/receipt-note/:weighRecordId
 * Upload a receipt note image for a weigh record.
 * Body: multipart/form-data with field "file"
 */
exports.uploadReceiptNote = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }

      const { weighRecordId } = req.params;

      // Verify weigh record exists
      const recordDoc = await db.collection('weighRecords').doc(weighRecordId).get();
      if (!recordDoc.exists) {
        return res.status(404).json({ error: `Weigh record ${weighRecordId} not found` });
      }

      // Delete old file if exists
      const existingPhoto = recordDoc.data().photoURL;
      if (existingPhoto) {
        const oldPath = extractStoragePath(existingPhoto);
        if (oldPath) await deleteFile(oldPath);
      }

      // Upload to "Receipt note/" folder
      const { url } = await uploadFile(
        req.file.buffer,
        req.file.originalname,
        'Receipt note',
        weighRecordId
      );

      // Update Firestore weigh record
      await db.collection('weighRecords').doc(weighRecordId).update({
        photoURL: url,
        updatedAt: new Date().toISOString(),
      });

      res.json({ success: true, photoURL: url, weighRecordId });
    } catch (err) {
      next(err);
    }
  },
];

/**
 * Extract storage path from a public URL.
 * E.g. "https://storage.googleapis.com/trucksphere.appspot.com/Drivers%20PP/d1-abc.jpg"
 *   → "Drivers PP/d1-abc.jpg"
 */
function extractStoragePath(publicUrl) {
  try {
    const url = new URL(publicUrl);
    // Path starts with /bucket-name/...
    const parts = decodeURIComponent(url.pathname).split('/');
    // Remove empty leading segment and bucket name (index 0 and 1)
    return parts.slice(2).join('/');
  } catch {
    return null;
  }
}
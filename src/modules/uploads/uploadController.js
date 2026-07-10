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
 *   - Deliveries/       → driver photos at weigh-out → Firestore: deliveryOrders/{id}.driverPhotoURL
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
      console.error('[uploadDriverPhoto] Error:', err.message);
      console.error('[uploadDriverPhoto] Stack:', err.stack);
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
      console.error('[uploadDeliveryNote] Error:', err.message);
      console.error('[uploadDeliveryNote] Stack:', err.stack);
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
      console.error('[uploadReceiptNote] Error:', err.message);
      console.error('[uploadReceiptNote] Stack:', err.stack);
      next(err);
    }
  },
];

/**
 * POST /api/uploads/driver-photo-weigh-out/(*)
 *
 * The wildcard (*) route is used because jobIds contain forward slashes
 * (e.g., POMAT006/V003/D033/T033/J0001). Express would normally split on /
 * and :jobId would only capture "POMAT006", causing a 404.
 *
 * With the wildcard, the full remaining path is available as req.params[0].
 *
 * Storage folder: "Deliveries/"
 * The uploaded filename is set to the jobId
 * Firestore field: deliveryOrders/{deliveryOrderId}.driverPhotoURL
 */
exports.uploadDriverPhotoWeighOut = [
  upload.single('file'),
  async (req, res, next) => {
    try {
      console.log('[uploadDriverPhotoWeighOut] Request received');
      console.log('[uploadDriverPhotoWeighOut] req.params:', JSON.stringify(req.params));
      console.log('[uploadDriverPhotoWeighOut] req.file:', req.file ? `Present (${req.file.originalname}, ${req.file.size} bytes, ${req.file.mimetype})` : 'MISSING');

      if (!req.file) {
        console.error('[uploadDriverPhotoWeighOut] No file in request');
        return res.status(400).json({ error: 'No file provided' });
      }

      // req.params[0] captures the entire remaining path from the (*) wildcard
      const jobId = req.params[0];
      console.log('[uploadDriverPhotoWeighOut] Extracted jobId:', jobId);

      if (!jobId) {
        console.error('[uploadDriverPhotoWeighOut] Missing jobId in request path');
        return res.status(400).json({ error: 'Missing jobId in request path' });
      }

      // Find the delivery order by jobId
      console.log('[uploadDriverPhotoWeighOut] Querying deliveryOrders by jobId:', jobId);
      const ordersSnap = await db.collection('deliveryOrders')
        .where('jobId', '==', jobId)
        .limit(1)
        .get();

      if (ordersSnap.empty) {
        console.error('[uploadDriverPhotoWeighOut] Delivery order not found for jobId:', jobId);
        return res.status(404).json({ error: `Delivery order with jobId ${jobId} not found` });
      }

      const orderDoc = ordersSnap.docs[0];
      const orderId = orderDoc.id;
      console.log('[uploadDriverPhotoWeighOut] Found delivery order:', orderId);

      // Delete old driver photo if exists
      const existingPhoto = orderDoc.data().driverPhotoURL;
      if (existingPhoto) {
        console.log('[uploadDriverPhotoWeighOut] Deleting old photo:', existingPhoto);
        const oldPath = extractStoragePath(existingPhoto);
        if (oldPath) await deleteFile(oldPath);
      }

      // Determine file extension from original or mimetype
      const ext = getExtension(req.file.originalname, req.file.mimetype);
      // Use jobId as the filename
      const fileName = `${jobId}${ext}`;
      console.log('[uploadDriverPhotoWeighOut] Uploading as:', fileName, 'to Deliveries/');

      // Upload to "Deliveries/" folder using the jobId as filename
      const { url } = await uploadFileWithName(
        req.file.buffer,
        fileName,
        'Deliveries'
      );

      console.log('[uploadDriverPhotoWeighOut] Uploaded to Firebase Storage, URL:', url);

      // Update Firestore delivery order record with driverPhotoURL
      await db.collection('deliveryOrders').doc(orderId).update({
        driverPhotoURL: url,
        updatedAt: new Date().toISOString(),
      });

      console.log('[uploadDriverPhotoWeighOut] Firestore updated for order:', orderId);

      res.json({ success: true, photoURL: url, jobId, deliveryOrderId: orderId });
    } catch (err) {
      console.error('[uploadDriverPhotoWeighOut] ERROR:', err.message);
      console.error('[uploadDriverPhotoWeighOut] Stack:', err.stack);
      next(err);
    }
  },
];

/**
 * Upload a file with a specific filename (no timestamp/random suffix).
 */
async function uploadFileWithName(buffer, fileName, folder) {
  const { admin } = require('../../../config/firebase');
  const bucket = admin.storage().bucket(process.env.STORAGE_BUCKET || 'trucksphere.appspot.com');
  const filePath = `${folder}/${fileName}`;

  console.log('[uploadFileWithName] Uploading to bucket:', bucket.name);
  console.log('[uploadFileWithName] File path:', filePath);

  const file = bucket.file(filePath);

  await file.save(buffer, {
    metadata: { contentType: getContentTypeFromExt(fileName) },
    public: true,
  });

  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(filePath)}`;

  console.log('[uploadFileWithName] Upload complete, public URL:', publicUrl);

  return { url: publicUrl, path: filePath };
}

function getExtension(originalName, mimetype) {
  const path = require('path');
  const ext = path.extname(originalName).toLowerCase();
  if (ext && ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    return ext;
  }
  // Fallback based on mimetype
  const mimeMap = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return mimeMap[mimetype] || '.jpg';
}

function getContentTypeFromExt(fileName) {
  const path = require('path');
  const ext = path.extname(fileName).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
  };
  return types[ext] || 'application/octet-stream';
}

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
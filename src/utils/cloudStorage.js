/**
 * Firebase Cloud Storage Utility
 *
 * Files are stored in organised folders:
 *   - driver/           → driver profile photos
 *   - Deliverynotes/    → delivery note images
 *   - Receipt note/     → receipt note images
 *
 * The download URL is returned and should be saved to Firestore
 * in the relevant `photoURL` field of the driver/delivery/receipt record.
 */
const path = require('path');
const { admin } = require('../../config/firebase');

const bucket = admin.storage().bucket(process.env.STORAGE_BUCKET || 'trucksphere.appspot.com');

/**
 * Upload a buffer to Firebase Storage and return the public download URL.
 *
 * @param {Buffer}  buffer        - File contents
 * @param {string}  originalName  - Original filename (used for extension detection)
 * @param {string}  folder        - Storage folder ('Drivers PP', 'Deliverynotes', 'Receipt note')
 * @param {string}  [entityId]    - Optional entity ID to prefix the filename
 * @returns {Promise<{ url: string; path: string }>}
 */
async function uploadFile(buffer, originalName, folder, entityId, mimetype) {
  const ext = extensionForMimeType(mimetype) || path.extname(originalName).toLowerCase() || '.bin';
  const prefix = entityId ? `${entityId}-` : '';
  const baseName = `${prefix}${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const fileName = `${baseName}${ext}`;
  const filePath = `${folder}/${fileName}`;

  const file = bucket.file(filePath);

  await file.save(buffer, {
    metadata: { contentType: getContentType(ext) },
    public: true,
  });

  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${encodeURIComponent(filePath)}`;

  return { url: publicUrl, path: filePath };
}

/**
 * Delete a file from Firebase Storage by its full path within the bucket.
 *
 * @param {string} filePath - Full path (e.g. 'Drivers PP/d1-abc.jpg')
 */
async function deleteFile(filePath) {
  if (!filePath) return;
  try {
    await bucket.file(filePath).delete();
  } catch (error) {
    if (error.code !== 404) {
      console.error('[CloudStorage] Delete error:', error.message);
    }
  }
}

function getContentType(ext) {
  const types = {
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.bmp':  'image/bmp',
    '.pdf':  'application/pdf',
  };
  return types[ext] || 'application/octet-stream';
}

function extensionForMimeType(mimetype) {
  const extensions = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'application/pdf': '.pdf',
  };
  return extensions[mimetype] || '';
}

module.exports = { uploadFile, deleteFile };

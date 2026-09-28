/**
 * Multer middleware for file uploads.
 *
 * Files are accepted as multipart/form-data with the field name 'file'.
 * Max file size: 10 MB.
 */
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'application/pdf',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${allowed.join(', ')}`));
    }
  },
});

/**
 * Express error-handling middleware that catches Multer errors
 * and returns a proper 400 response instead of falling through
 * to the generic 500 handler.
 *
 * Place this BEFORE your route handlers that use multer.
 */
function multerErrorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors (file too large, too many files, etc.)
    const messages = {
      LIMIT_FILE_SIZE: 'File is too large. Maximum size is 10 MB.',
      LIMIT_FILE_COUNT: 'Too many files. Only one file is allowed per request.',
      LIMIT_UNEXPECTED_FILE: "Unexpected field name. Use 'file' as the form field.",
      LIMIT_FIELD_KEY: 'Field name is too long.',
      LIMIT_FIELD_VALUE: 'Field value is too long.',
      LIMIT_FIELD_COUNT: 'Too many fields in the form.',
      LIMIT_PART_COUNT: 'Too many parts in the multipart form.',
    };
    const message = messages[err.code] || err.message;
    return res.status(400).json({ error: message, code: err.code });
  }

  // Custom errors thrown from fileFilter (e.g. unsupported type)
  if (err && err.message && err.message.startsWith('Unsupported file type')) {
    return res.status(400).json({ error: err.message });
  }

  // Not a multer error — pass to the next error handler
  next(err);
}

module.exports = upload;
module.exports.multerErrorHandler = multerErrorHandler;
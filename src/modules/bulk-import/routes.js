const express = require('express');
const multer = require('multer');
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4, parts: 6 },
  fileFilter: (_req, file, callback) => {
    const validMimeTypes = [
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ];
    const isSupportedName = /\.(csv|xlsx)$/i.test(file.originalname || '');
    if (validMimeTypes.includes(file.mimetype) || isSupportedName) return callback(null, true);
    return callback(Object.assign(new Error('CSV or Excel (.xlsx) file required'), { statusCode: 400, code: 'SPREADSHEET_FILE_REQUIRED' }));
  },
});

router.use(verifyToken);
router.use(requireRoles(
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
));

const canImport = requireManagementAccess({ allowLite: true, write: true, allowLiteWrite: true });

router.post('/preview', canImport, upload.single('file'), controller.preview);
router.post('/commit', canImport, upload.single('file'), controller.commit);

router.use((error, _req, _res, next) => {
  if (error instanceof multer.MulterError) {
    error.statusCode = 400;
    error.code = error.code === 'LIMIT_FILE_SIZE' ? 'CSV_FILE_TOO_LARGE' : 'CSV_UPLOAD_INVALID';
  }
  next(error);
});

module.exports = router;

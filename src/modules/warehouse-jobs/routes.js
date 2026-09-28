const express = require('express');
const multer = require('multer');
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireRoles } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2, parts: 4 },
  fileFilter: (_req, file, callback) => {
    const validMimeTypes = [
      'text/csv',
      'application/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ];
    const isSupportedName = /\.(csv|xlsx)$/i.test(file.originalname || '');
    if (validMimeTypes.includes(file.mimetype) || isSupportedName) return callback(null, true);
    return callback(Object.assign(new Error('CSV or Excel (.xlsx) file required'), { statusCode: 400, code: 'WAREHOUSE_PREVIEW_FILE_INVALID' }));
  },
});

router.use(verifyToken);
// Warehouse personnel submit their own dispatches; management can still view
// and create them for oversight or contingency operations.
router.use(requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_warehouse', 'storeman'));

router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/preview', upload.single('file'), controller.preview);
router.post('/', controller.create);

router.use((error, _req, _res, next) => {
  if (error instanceof multer.MulterError) {
    error.statusCode = 400;
    error.code = error.code === 'LIMIT_FILE_SIZE' ? 'WAREHOUSE_PREVIEW_FILE_TOO_LARGE' : 'WAREHOUSE_PREVIEW_UPLOAD_INVALID';
  }
  next(error);
});

module.exports = router;

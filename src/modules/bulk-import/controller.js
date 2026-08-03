const bulkImportService = require('./service');

function importType(req) {
  return String(req.body?.type || '').trim().toLowerCase();
}

function requireCsv(req) {
  if (!req.file?.buffer?.length) {
    throw Object.assign(new Error('CSV file is required'), { statusCode: 400, code: 'CSV_FILE_REQUIRED' });
  }
}

exports.preview = async (req, res, next) => {
  try {
    requireCsv(req);
    const result = await bulkImportService.preview(importType(req), req.file.buffer, req.file);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

exports.commit = async (req, res, next) => {
  try {
    requireCsv(req);
    const result = await bulkImportService.commit(importType(req), req.file.buffer, req.file);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

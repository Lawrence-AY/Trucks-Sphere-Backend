/**
 * Admin Reports Routes
 *
 * Protected: requires valid auth token + management/admin role.
 */

const express = require('express');
const router = express.Router();
const reportsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

// GET /api/admin/reports/export — download Master Audit .xlsx
router.get('/export', reportsController.exportExcel);

// GET /api/admin/reports/export/csv/:category — download per-category CSV
router.get('/export/csv/:category', reportsController.exportCategoryCSV);

// GET /api/admin/reports/summary — JSON metrics for all categories
router.get('/summary', reportsController.getSummary);

// GET /api/admin/reports/summary/:category — per-category live preview
router.get('/summary/:category', reportsController.getCategorySummary);

module.exports = router;

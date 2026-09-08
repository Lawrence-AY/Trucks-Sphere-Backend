/**
 * Admin Reports Routes
 *
 * Protected: requires valid auth token + management/admin role.
 */

const express = require('express');
const router = express.Router();
const reportsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const snapshotStore = require('../../utils/snapshotStore');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
router.use(requireManagementAccess());

// GET /api/admin/reports — list available report types
router.get('/', (_req, res) => {
  const reports = [
    {
      id: 'operations-summary',
      name: 'Operations Summary',
      category: 'Operations',
      description: 'Job volumes, active movements, and completion counts.',
      recordCount: snapshotStore.getAll('deliveryOrders').length,
    },
    {
      id: 'purchase-order-progress',
      name: 'Purchase Order Progress',
      category: 'Procurement',
      description: 'Purchase orders grouped by status and fulfillment progress.',
      recordCount: snapshotStore.getAll('purchaseOrders').length,
    },
    {
      id: 'fleet-utilization',
      name: 'Fleet Utilization',
      category: 'Fleet',
      description: 'Drivers, vehicles, and vendor availability signals.',
      recordCount: snapshotStore.getAll('vehicles').length,
    },
    {
      id: 'fuel-consumption',
      name: 'Fuel Consumption',
      category: 'Fleet',
      description: 'Fuel records and authorization activity.',
      recordCount: snapshotStore.getAll('fuelRecords').length,
    },
  ];

  res.json({ data: reports, total: reports.length, page: 1, totalPages: 1 });
});

// GET /api/admin/reports/export — download Master Audit .xlsx
router.get('/export', reportsController.exportExcel);

// GET /api/admin/reports/export/csv/:category — download per-category CSV
router.get('/export/csv/:category', reportsController.exportCategoryCSV);

// GET /api/admin/reports/summary — JSON metrics for all categories
router.get('/summary', reportsController.getSummary);

// GET /api/admin/reports/summary/:category — per-category live preview
router.get('/summary/:category', reportsController.getCategorySummary);

module.exports = router;

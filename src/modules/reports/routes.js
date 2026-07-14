const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const snapshotStore = require('../../utils/snapshotStore');

const router = express.Router();
router.use(verifyToken);

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

module.exports = router;

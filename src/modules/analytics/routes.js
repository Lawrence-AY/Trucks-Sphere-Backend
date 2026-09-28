const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const snapshotStore = require('../../utils/snapshotStore');
const { isActiveJob, normalizeJobStatus } = require('../../utils/jobLifecycle');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
router.use(verifyToken);
router.use(requireManagementAccess());

function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

router.get('/summary', (_req, res) => {
  const deliveryOrders = snapshotStore.getAll('deliveryOrders');
  const vendors = snapshotStore.getAll('vendors');
  const drivers = snapshotStore.getAll('drivers');
  const vehicles = snapshotStore.getAll('vehicles');
  const purchaseOrders = snapshotStore.getAll('purchaseOrders');
  const fuelRecords = snapshotStore.getAll('fuelRecords');

  res.json({
    operations: {
      totalJobs: deliveryOrders.length,
      activeJobs: deliveryOrders.filter((item) => isActiveJob(item.status)).length,
      completedJobs: deliveryOrders.filter((item) => ['SITE_WEIGHED_OUT', 'COMPLETED'].includes(normalizeJobStatus(item.status))).length,
      jobsByStatus: countBy(deliveryOrders, 'status'),
    },
    procurement: {
      purchaseOrders: purchaseOrders.length,
      purchaseOrdersByStatus: countBy(purchaseOrders, 'status'),
    },
    fleet: {
      vendors: vendors.length,
      drivers: drivers.length,
      vehicles: vehicles.length,
      vehiclesByStatus: countBy(vehicles, 'status'),
      driversByStatus: countBy(drivers, 'status'),
    },
    fuel: {
      records: fuelRecords.length,
    },
  });
});

module.exports = router;

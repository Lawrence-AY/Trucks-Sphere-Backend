const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const snapshotStore = require('../../utils/snapshotStore');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
router.use(verifyToken);
router.use(requireManagementAccess({ superAdminOnly: true }));

const RESOURCES = [
  { key: 'materials', label: 'Materials', collection: 'materials' },
  { key: 'vendors', label: 'Vendors', collection: 'vendors' },
  { key: 'drivers', label: 'Drivers', collection: 'drivers' },
  { key: 'vehicles', label: 'Vehicles', collection: 'vehicles' },
  { key: 'quarries', label: 'Quarries', collection: 'quarries' },
  { key: 'sites', label: 'Sites', collection: 'sites' },
  { key: 'fuelStations', label: 'Fuel Stations', collection: 'fuelStations' },
  { key: 'customers', label: 'Customers', collection: 'customers' },
  { key: 'users', label: 'Users', collection: 'users' },
  { key: 'roles', label: 'Roles', collection: 'roles' },
];

router.get('/', (_req, res) => {
  const data = RESOURCES.map((resource) => {
    const items = snapshotStore.getAll(resource.collection);
    return {
      ...resource,
      total: items.length,
      active: items.filter((item) => item.status === 'active' || item.active === true).length,
      inactive: items.filter((item) => item.status === 'inactive' || item.active === false).length,
    };
  });

  res.json({ data, total: data.length, page: 1, totalPages: 1 });
});

module.exports = router;

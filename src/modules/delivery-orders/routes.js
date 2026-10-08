const express = require('express');
const router = express.Router();
const delivery_ordersController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { MANAGEMENT_ROLES, requireManagementAccess, requireRoles } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);

// The fuel operator needs the finalized-job queue to begin a fuel issue, but
// must not gain access to the full delivery-order management board.
router.get(
  '/fuel-ready',
  requireRoles(
    MANAGEMENT_ROLES.SUPER_ADMIN,
    MANAGEMENT_ROLES.ADMIN,
    MANAGEMENT_ROLES.ADMIN_LITE,
    'operator_fuel'
  ),
  delivery_ordersController.findFuelReady
);

// Delivery orders have role-specific filtering in the controller.  Do not
// use requireManagementAccess here: it rejects quarry/site operators before
// that filtering can run, which leaves their job-card and weighbridge queues
// empty and rejects their weigh-in/out updates with 403.
const DELIVERY_READ_ROLES = [
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
  'vendor',
  'operator_quarry', 'inspector',
  'operator_site',
  'storeman',
];

const DELIVERY_WRITE_ROLES = [
  MANAGEMENT_ROLES.SUPER_ADMIN,
  MANAGEMENT_ROLES.ADMIN,
  MANAGEMENT_ROLES.ADMIN_LITE,
  'operator_quarry', 'inspector',
  'operator_site',
  'storeman',
];

router.use(requireRoles(...DELIVERY_READ_ROLES));

router.get('/', delivery_ordersController.findAll);
router.get('/job/*', delivery_ordersController.findByJobId);
router.get('/po/*', delivery_ordersController.findByPurchaseOrderId);
router.get('/:id', delivery_ordersController.findById);
router.post('/', requireRoles(...DELIVERY_WRITE_ROLES), delivery_ordersController.create);
router.post('/receive-lot', requireRoles(...DELIVERY_WRITE_ROLES), delivery_ordersController.receiveLot);
router.put('/:id', requireRoles(...DELIVERY_WRITE_ROLES), delivery_ordersController.update);
router.post('/:id/store-receiving', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'storeman'), delivery_ordersController.storeReceive);
router.post('/:id/store-inspection', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'storeman', 'inspector'), delivery_ordersController.storeInspect);
router.post('/:id/accept-warehouse', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_site'), delivery_ordersController.acceptWarehouse);
router.post('/:id/deny-warehouse', requireRoles(MANAGEMENT_ROLES.SUPER_ADMIN, MANAGEMENT_ROLES.ADMIN, 'operator_site'), delivery_ordersController.denyWarehouse);
router.delete('/:id', requireManagementAccess({ write: true }), delivery_ordersController.delete);

module.exports = router;

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

router.use(requireManagementAccess());

router.get('/', delivery_ordersController.findAll);
router.get('/job/*', delivery_ordersController.findByJobId);
router.get('/po/*', delivery_ordersController.findByPurchaseOrderId);
router.get('/:id', delivery_ordersController.findById);
router.post('/', requireManagementAccess({ write: true }), delivery_ordersController.create);
router.post('/receive-lot', requireManagementAccess({ write: true }), delivery_ordersController.receiveLot);
router.put('/:id', requireManagementAccess({ write: true }), delivery_ordersController.update);
router.delete('/:id', requireManagementAccess({ write: true }), delivery_ordersController.delete);

module.exports = router;

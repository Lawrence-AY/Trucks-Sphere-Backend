const express = require('express');
const router = express.Router();
const purchase_ordersController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);

router.get('/', purchase_ordersController.findAll);
router.get('/preview-number', purchase_ordersController.previewNumber);
router.get('/:id', purchase_ordersController.findById);
// Management Lite can create new purchase orders, but cannot alter or delete
// an order after it has been submitted.
router.post('/', requireManagementAccess({ allowLite: true, write: true }), purchase_ordersController.create);
router.put('/:id', requireManagementAccess({ write: true }), purchase_ordersController.update);
router.delete('/:id', requireManagementAccess({ write: true }), purchase_ordersController.delete);

module.exports = router;

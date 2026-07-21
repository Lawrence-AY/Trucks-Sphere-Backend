const express = require('express');
const router = express.Router();
const materialsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);
// Admin Lite needs the material catalogue to create a purchase order, but the
// management Materials screen itself remains unavailable to that role.
router.use(requireManagementAccess({ allowLite: true }));

router.get('/', materialsController.findAll);
router.get('/:id', materialsController.findById);
router.post('/', requireManagementAccess({ write: true }), materialsController.create);
router.put('/:id', requireManagementAccess({ write: true }), materialsController.update);
router.delete('/:id', requireManagementAccess({ write: true }), materialsController.delete);

module.exports = router;

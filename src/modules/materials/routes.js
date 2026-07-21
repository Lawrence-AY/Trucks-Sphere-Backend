const express = require('express');
const router = express.Router();
const materialsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

router.use(verifyToken);

router.get('/', materialsController.findAll);
router.get('/:id', materialsController.findById);
router.post('/', requireManagementAccess({ write: true }), materialsController.create);
router.put('/:id', requireManagementAccess({ write: true }), materialsController.update);
router.delete('/:id', requireManagementAccess({ write: true }), materialsController.delete);

module.exports = router;

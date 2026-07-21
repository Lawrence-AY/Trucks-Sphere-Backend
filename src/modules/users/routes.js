const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const controller = require('./controller');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

const router = express.Router();
router.use(verifyToken);
// Management editors can update an operator's station to transfer personnel;
// management-lite accounts remain read-only for user administration.
router.use(requireManagementAccess({ write: true }));
router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);
router.put('/:id/password', controller.resetPassword);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

module.exports = router;

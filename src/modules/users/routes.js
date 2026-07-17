const express = require('express');
const { verifyToken } = require('../../middleware/authMiddleware');
const controller = require('./controller');

const router = express.Router();
router.use(verifyToken);
router.get('/', controller.findAll);
router.get('/:id', controller.findById);
router.post('/', controller.create);
router.put('/:id/password', controller.resetPassword);
router.put('/:id', controller.update);
router.delete('/:id', controller.delete);

module.exports = router;

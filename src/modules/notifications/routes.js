const express = require('express');
const router = express.Router();
const controller = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', controller.findAll);
router.put('/:id/read', controller.markRead);
router.put('/read-all', controller.markAllRead);

module.exports = router;
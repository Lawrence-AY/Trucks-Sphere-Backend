const express = require('express');
const router = express.Router();
const siteController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', siteController.findAll);
router.get('/:id', siteController.findById);
router.post('/', siteController.create);
router.put('/:id', siteController.update);
router.delete('/:id', siteController.delete);

module.exports = router;

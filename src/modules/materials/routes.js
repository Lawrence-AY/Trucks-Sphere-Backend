const express = require('express');
const router = express.Router();
const materialsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', materialsController.findAll);
router.get('/:id', materialsController.findById);
router.post('/', materialsController.create);
router.put('/:id', materialsController.update);
router.delete('/:id', materialsController.delete);

module.exports = router;

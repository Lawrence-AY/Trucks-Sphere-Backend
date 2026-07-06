const express = require('express');
const router = express.Router();
const quarryController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/', quarryController.findAll);
router.get('/:id', quarryController.findById);
router.post('/', quarryController.create);
router.put('/:id', quarryController.update);
router.delete('/:id', quarryController.delete);

module.exports = router;

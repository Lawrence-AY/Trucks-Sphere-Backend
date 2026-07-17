const express = require('express');
const router = express.Router();
const vendorsController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

router.use(verifyToken);

router.get('/username', vendorsController.previewUsername);
router.post('/with-account', vendorsController.createWithAccount);
router.get('/', vendorsController.findAll);
router.get('/:id', vendorsController.findById);
router.post('/', vendorsController.create);
router.put('/:id', vendorsController.update);
router.delete('/:id', vendorsController.delete);

module.exports = router;

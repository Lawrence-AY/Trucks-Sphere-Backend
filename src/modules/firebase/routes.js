const express = require('express');
const router = express.Router();
const firebaseController = require('./controller');
const { verifyToken } = require('../../middleware/authMiddleware');

// Public: Firebase ID token verification
router.post('/auth/verify', firebaseController.authenticateWithFirebase);

// Protected routes
router.use(verifyToken);

// Custom token for Firebase client SDK
router.get('/auth/custom-token', firebaseController.getCustomToken);

// Firestore CRUD
router.post('/firestore/sync', firebaseController.syncToFirestore);
router.get('/firestore/:collection/:docId', firebaseController.getFromFirestore);
router.post('/firestore/query/:collection', firebaseController.queryFirestore);

// Storage
router.post('/storage/receipt', firebaseController.uploadReceipt);
router.delete('/storage/file', firebaseController.deleteFile);

module.exports = router;

const admin = require('firebase-admin');

exports.authenticateWithFirebase = async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'ID token required' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const userRecord = await admin.auth().getUser(decoded.uid);

    res.json({
      uid: userRecord.uid,
      email: userRecord.email,
      name: userRecord.displayName || userRecord.email?.split('@')[0],
      role: decoded.role || 'management',
      phone: userRecord.phoneNumber || '',
    });
  } catch (err) {
    next(err);
  }
};

exports.getCustomToken = async (req, res, next) => {
  try {
    const { uid } = req.user;
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken });
  } catch (err) {
    next(err);
  }
};

exports.syncToFirestore = async (req, res, next) => {
  try {
    const { collection, data } = req.body;
    const db = admin.firestore();
    const docRef = await db.collection(collection).add(data);
    res.json({ id: docRef.id, message: 'Synced to Firestore' });
  } catch (err) {
    next(err);
  }
};

exports.getFromFirestore = async (req, res, next) => {
  try {
    const { collection, docId } = req.params;
    const db = admin.firestore();
    const doc = await db.collection(collection).doc(docId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    next(err);
  }
};

exports.queryFirestore = async (req, res, next) => {
  try {
    const { collection } = req.params;
    const { field, operator, value, limit = 50 } = req.body;
    const db = admin.firestore();
    let query = db.collection(collection);

    if (field && operator) {
      query = query.where(field, operator, value);
    }
    query = query.limit(parseInt(limit));

    const snapshot = await query.get();
    const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(docs);
  } catch (err) {
    next(err);
  }
};

exports.uploadReceipt = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bucket = admin.storage().bucket();
    const fileName = `receipts/${Date.now()}_${req.file.originalname}`;
    const file = bucket.file(fileName);
    await file.save(req.file.buffer, { contentType: req.file.mimetype });
    const [url] = await file.getSignedUrl({ action: 'read', expires: '01-01-2030' });
    res.json({ url, fileName });
  } catch (err) {
    next(err);
  }
};

exports.deleteFile = async (req, res, next) => {
  try {
    const { path } = req.body;
    const bucket = admin.storage().bucket();
    await bucket.file(path).delete();
    res.json({ message: 'File deleted' });
  } catch (err) {
    next(err);
  }
};

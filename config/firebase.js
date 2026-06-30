// config/firebase.js
const admin = require('firebase-admin');
// Load the service account JSON file – adjust filename if needed
const serviceAccount = require('./truck-d18ad-firebase-adminsdk-fbsvc-2ef616d98d.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
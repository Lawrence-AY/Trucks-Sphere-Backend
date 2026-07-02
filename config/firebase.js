// config/firebase.js
const admin = require('firebase-admin');
// Load the service account JSON file – adjust filename if needed
const serviceAccount = require('./truck2sphere-57b00-firebase-adminsdk-fbsvc-b38391ce11.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
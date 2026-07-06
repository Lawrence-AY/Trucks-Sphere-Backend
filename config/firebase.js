// config/firebase.js
const admin = require('firebase-admin');
// Load the service account JSON file – adjust filename if needed
 const serviceAccount = require('./truck2sphere-57b00-firebase-adminsdk-fbsvc-b38391ce11.json');
//const serviceAccount = require('./truck-d18ad-firebase-adminsdk-fbsvc-2ef616d98d.json');
//const serviceAccount = require('./jobs-app-36698-firebase-adminsdk-eg4oi-2894943154.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
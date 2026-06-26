// Firebase Admin SDK configuration
const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'truck-d18ad-firebase-adminsdk-fbsvc-2ef616d98d.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'truck-d18ad',
  });
}

module.exports = admin;

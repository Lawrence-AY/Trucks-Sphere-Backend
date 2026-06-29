// Firebase Admin SDK configuration
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  || path.join(__dirname, 'truck-d18ad-firebase-adminsdk-fbsvc-2ef616d98d.json');

if (!admin.apps.length && fs.existsSync(serviceAccountPath)) {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || 'truck-d18ad',
  });
} else if (!admin.apps.length) {
  console.warn('Firebase service account not found. Legacy Firebase endpoints are disabled until credentials are provided.');
}

module.exports = admin;

require('dotenv').config();
const admin = require('firebase-admin');

if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (e) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed: ' + e.message);
    }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = admin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
  } else {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT_JSON (Render) or FIREBASE_SERVICE_ACCOUNT_PATH (local)');
  }
  admin.initializeApp({ credential });
}

module.exports = admin;

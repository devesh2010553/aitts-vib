// Secondary MongoDB connection (MONGODB_URI2). Originally chat-only; now also
// holds AdImage and PdfImportJob (see those model files) — all three were
// moved/kept here specifically to keep their base64 payloads (chat has none,
// but ad images and PDF imports do, and PDF imports in particular can run
// several MB each) off the main MONGODB_URI cluster's storage.
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI2 || process.env.MONGODB_URI;
// Traffic here is still much lighter than the main app's (chat + a few
// admin-only actions) — a smaller dedicated pool is plenty and leaves more
// of MongoDB's total connection budget for the main connection above.
// Revisit if PDF import volume grows enough to change that picture.
const chatConnection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 15 });

chatConnection.on('connected', () => console.log('[CHAT-DB] Connected' + (process.env.MONGODB_URI2 ? '' : ' (falling back to MONGODB_URI — set MONGODB_URI2 to use a separate cluster)')));
chatConnection.on('error', err => console.error('[CHAT-DB] Error:', err.message));
chatConnection.on('disconnected', () => console.warn('[CHAT-DB] Disconnected — driver will attempt to reconnect automatically'));

module.exports = chatConnection;

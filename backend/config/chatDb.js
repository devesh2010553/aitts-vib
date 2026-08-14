// Secondary MongoDB connection, used ONLY for chat message storage.
// Keeps chat traffic (and its storage growth) off the main MONGODB_URI cluster.
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI2 || process.env.MONGODB_URI;
// Chat traffic is far lighter than the main app's — a smaller dedicated pool
// is plenty and leaves more of MongoDB's total connection budget for the
// main connection above.
const chatConnection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 15 });

chatConnection.on('connected', () => console.log('[CHAT-DB] Connected' + (process.env.MONGODB_URI2 ? '' : ' (falling back to MONGODB_URI — set MONGODB_URI2 to use a separate cluster)')));
chatConnection.on('error', err => console.error('[CHAT-DB] Error:', err.message));
chatConnection.on('disconnected', () => console.warn('[CHAT-DB] Disconnected — driver will attempt to reconnect automatically'));

module.exports = chatConnection;

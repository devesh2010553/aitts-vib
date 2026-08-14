// Secondary MongoDB connection, used ONLY for chat message storage.
// Keeps chat traffic (and its storage growth) off the main MONGODB_URI cluster.
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI2 || process.env.MONGODB_URI;
const chatConnection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15000 });

chatConnection.on('connected', () => console.log('[CHAT-DB] Connected' + (process.env.MONGODB_URI2 ? '' : ' (falling back to MONGODB_URI — set MONGODB_URI2 to use a separate cluster)')));
chatConnection.on('error', err => console.error('[CHAT-DB] Error:', err.message));

module.exports = chatConnection;

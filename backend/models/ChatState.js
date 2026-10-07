const chatDb = require('../config/chatDb');
const { Schema } = require('mongoose');

// Single-document store for chat moderation state. Previously this lived in
// server.js as `let chatMuted` / `const blockedUids = new Set()` — plain
// process memory, which (a) resets on every restart/deploy and (b) would
// silently diverge between PM2 cluster workers if/when the app runs with
// more than one process, since each worker has its own memory. Moving it
// here means any worker's admin action is immediately visible to every
// other worker (they all read the same document), and state survives
// restarts.
const chatStateSchema = new Schema({
  _id:         { type: String, default: 'singleton' },
  muted:       { type: Boolean, default: false },
  blockedUids: [{ type: String }]
});

module.exports = chatDb.model('ChatState', chatStateSchema);

const chatDb = require('../config/chatDb');
const { Schema } = require('mongoose');

// No TTL index, no expiry — messages persist until an admin explicitly deletes them.
const chatMessageSchema = new Schema({
  name:    { type: String, default: 'Student' },
  uid:     { type: String, default: '' },
  batch:   { type: String, default: '' },
  text:    { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  time:    { type: String, default: '' }, // display string, e.g. "10:32 AM"
}, { timestamps: true });

module.exports = chatDb.model('ChatMessage', chatMessageSchema);

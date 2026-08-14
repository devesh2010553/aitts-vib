const mongoose = require('mongoose');

// Replaces the old `global._forgotAttempts` in-process counter — that reset
// on every restart and, in a multi-process deployment, would give each
// worker its own independent counter (silently turning "3 per day" into
// "3 × number of workers per day"). A TTL index handles the old "clean old
// keys" logic automatically instead of a manual per-request cleanup loop.
const forgotAttemptSchema = new mongoose.Schema({
  _id:       { type: String, required: true }, // `${email}:${YYYY-MM-DD}`
  count:     { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 172800 } // 2 days
});

module.exports = mongoose.model('ForgotAttempt', forgotAttemptSchema);

const mongoose = require('mongoose');

// Generic cache-aside store for leaderboard reads. Previously this model was
// defined (as a per-test rank archive) but never actually written to or read
// from anywhere in the codebase — this replaces that with something that's
// actually wired up: leaderboard.js/rankings.js write a computed payload here
// keyed by cacheKey, and serve subsequent reads from it until it expires
// (see backend/utils/leaderboardCache.js). No student-specific data (myRank,
// myResult) is ever stored here — only the shared/public parts of a response.
const snapshotSchema = new mongoose.Schema({
  cacheKey:   { type: String, required: true, unique: true },
  scope:      { type: String, enum: ['class-cumulative', 'per-test', 'overall', 'normalised'], required: true },
  testId:     { type: String }, // DynamoDB Test.testId string (e.g. "test_<uuid>") — was an ObjectId ref, which CastErrors against the new id format; getCached()/invalidate() swallow the error so this silently never cached/invalidated per-test entries
  batch:      { type: String, enum: ['11', '12', 'dropper', ''], default: '' }, // '' = all batches
  payload:    { type: mongoose.Schema.Types.Mixed, required: true },
  computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('LeaderboardSnapshot', snapshotSchema);

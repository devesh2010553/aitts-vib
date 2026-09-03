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
  // DynamoDB test IDs are plain strings (e.g. "test_<uuid>", see
  // Test.genId in backend/dynamo/testModel.js) — not Mongo ObjectIds. This
  // field used to be typed as Schema.Types.ObjectId (a leftover from when
  // Test lived in MongoDB too), which meant Mongoose tried to cast every
  // per-test cache write's testId to an ObjectId and threw a CastError on
  // every single one — silently swallowed by getCached()'s
  // `.catch(() => {})` on the write, so the per-test leaderboard cache
  // never actually persisted; every request fell through to a full
  // recompute regardless of TTL. Plain String fixes both the cast error
  // and (as a result) makes the cache actually cache.
  testId:     { type: String }, // set only for scope:'per-test'
  batch:      { type: String, enum: ['11', '12', 'dropper', ''], default: '' }, // '' = all batches
  payload:    { type: mongoose.Schema.Types.Mixed, required: true },
  computedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('LeaderboardSnapshot', snapshotSchema);

/**
 * The leaderboard cache (LeaderboardSnapshot) has a 30-second TTL, so stale
 * entries computed under the OLD (buggy, global-denominator) formula would
 * self-correct within 30 seconds of deploying this fix on their own — this
 * script just makes that immediate instead of waiting out the TTL.
 *
 * Run once, right after deploying:
 *   node backend/scripts/clear-leaderboard-cache.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LeaderboardSnapshot = require('../models/LeaderboardSnapshot');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const result = await LeaderboardSnapshot.deleteMany({});
  console.log(`[CACHE-CLEAR] Removed ${result.deletedCount} cached leaderboard snapshot(s). Next request to each leaderboard endpoint will recompute fresh.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('[CACHE-CLEAR] Failed:', err); process.exit(1); });

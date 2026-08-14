const LeaderboardSnapshot = require('../models/LeaderboardSnapshot');

const VALID_BATCHES = ['11', '12', 'dropper'];
// req.query values can be arrays/objects (e.g. ?batch[$ne]=) via Express's
// default query parser — never pass a query-string value into a Mongo filter
// without confirming it's one of the expected plain strings first.
function safeBatch(raw) {
  return (typeof raw === 'string' && VALID_BATCHES.includes(raw)) ? raw : '';
}

// How stale a cached leaderboard is allowed to be before the next request
// recomputes it. This is what replaces "run the full aggregation on every
// request" with "run it at most once every TTL_MS, across ALL concurrent
// viewers" — the read volume that actually spikes (many students opening the
// leaderboard right after a test) is exactly what this collapses down to a
// single recompute. Kept short enough that admin actions (bonus marks,
// deleting results) feel like they take effect quickly even without explicit
// invalidation, and explicit invalidation (below) makes the common cases
// near-instant anyway.
const TTL_MS = 30 * 1000;

/**
 * Cache-aside read: serve a cached payload if it's fresh enough, otherwise
 * recompute via computeFn, store it, and return it. Never cache anything
 * viewer-specific (myRank/myResult) — only the shared/public part of a
 * response should ever be passed through this.
 */
async function getCached(cacheKey, scope, meta, computeFn) {
  try {
    const existing = await LeaderboardSnapshot.findOne({ cacheKey }).lean();
    if (existing && (Date.now() - new Date(existing.computedAt).getTime()) < TTL_MS) {
      return existing.payload;
    }
  } catch (e) { /* cache read failure should never break the request — fall through to compute */ }

  const payload = await computeFn();

  // Best-effort write — a failed cache write just means the next request
  // recomputes too; it must never fail the response itself.
  LeaderboardSnapshot.findOneAndUpdate(
    { cacheKey },
    { cacheKey, scope, ...meta, payload, computedAt: new Date() },
    { upsert: true }
  ).catch(() => {});

  return payload;
}

/**
 * Fire-and-forget invalidation. Call after anything that changes results
 * (submit, bonus-marks edits, result deletion) so the cache doesn't wait out
 * the full TTL before reflecting the change. Intentionally not awaited by
 * callers on hot paths (e.g. submit) — invalidation racing a concurrent
 * recompute is harmless (worst case: one extra recompute), so there's no
 * correctness reason to block the response on it.
 */
function invalidate({ testId, batch } = {}) {
  const or = [];

  // A result change in one batch affects that batch's cumulative leaderboard
  // and the cross-batch "All" view. If no batch is supplied, treat the change
  // as global (e.g. a test's totalMarks/targetBatches/isPublished changed)
  // and invalidate every cumulative snapshot.
  if (batch) {
    or.push({ scope: { $in: ['class-cumulative','overall','normalised'] }, batch });
    or.push({ scope: { $in: ['class-cumulative','overall','normalised'] }, batch: '' });
  } else {
    or.push({ scope: { $in: ['class-cumulative','overall','normalised'] } });
  }

  // Per-test leaderboards only change for the specific test.
  if (testId) { or.push({ scope: 'per-test', testId }); }

  if (!or.length) return Promise.resolve();
  return LeaderboardSnapshot.deleteMany({ $or: or }).catch(() => {});
}

module.exports = { getCached, invalidate, safeBatch, TTL_MS };

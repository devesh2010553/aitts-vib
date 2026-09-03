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

// Cache-invalidation race guard: a global generation counter, bumped by
// every invalidate() call. Without this, a slow in-flight recompute that
// started BEFORE a submission (or bonus-marks edit, or result deletion)
// could finish and write its now-stale payload back into the cache AFTER
// invalidate()'s deleteMany already ran for that exact change — silently
// resurrecting stale data for a full TTL_MS instead of the change being
// visible immediately. Each getCached() call snapshots the generation
// before starting computeFn(); if the generation has moved by the time
// computeFn() resolves, some invalidation happened somewhere while we were
// computing, so this payload might not reflect it and is only returned to
// whoever's waiting on it right now, not persisted as "the cache" for
// later readers. Deliberately global rather than per-cacheKey: a global
// counter can occasionally skip persisting a payload that was actually
// unaffected by the invalidation that bumped it (e.g. an unrelated test's
// leaderboard), but that only costs one extra recompute next request —
// the same "worst case" this file already accepted for invalidate() races
// before this fix — and it can never let a stale payload survive an
// invalidation, which is the actual requirement.
let globalGeneration = 0;

// Cache-stampede guard: recomputes currently in flight, keyed by cacheKey.
// Without this, a cache miss/expiry hit by many concurrent viewers at once
// (e.g. a class opening the same test's leaderboard right after it ends,
// exactly when the cache was just invalidated) would have every one of them
// independently trigger the same expensive recompute. With it, only the
// first caller for a given key actually runs computeFn; everyone else who
// arrives while that's in flight awaits the same promise and gets the same
// result once it resolves.
const inFlight = new Map();

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

  const existingInFlight = inFlight.get(cacheKey);
  if (existingInFlight) return existingInFlight;

  const startGeneration = globalGeneration;
  const promise = (async () => {
    try {
      const payload = await computeFn();
      // Only persist if no invalidation happened anywhere while we were
      // computing — otherwise this payload may not reflect whatever change
      // triggered that invalidation, and writing it back would resurrect
      // data invalidate() just tried to clear. Still returned to whoever's
      // awaiting this exact promise right now — only the cache WRITE is
      // skipped, not the response.
      if (globalGeneration === startGeneration) {
        // Best-effort write — a failed cache write just means the next
        // request recomputes too; it must never fail the response itself.
        LeaderboardSnapshot.findOneAndUpdate(
          { cacheKey },
          { cacheKey, scope, ...meta, payload, computedAt: new Date() },
          { upsert: true }
        ).catch(() => {});
      }
      return payload;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();
  inFlight.set(cacheKey, promise);
  return promise;
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
  globalGeneration++;
  const or = [];
  // Cumulative/overall/normalised views change for the test's batch AND for
  // "all batches" whenever any result in that batch changes.
  if (batch) { or.push({ scope: { $in: ['class-cumulative','overall','normalised'] }, batch }); }
  or.push({ scope: { $in: ['class-cumulative','overall','normalised'] }, batch: '' });
  // Per-test leaderboards only change for the specific test.
  if (testId) { or.push({ scope: 'per-test', testId }); }
  if (!or.length) return Promise.resolve();
  return LeaderboardSnapshot.deleteMany({ $or: or }).catch(() => {});
}

module.exports = { getCached, invalidate, safeBatch, TTL_MS };

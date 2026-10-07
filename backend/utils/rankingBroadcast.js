const Result = require('../dynamo/resultModel');

/**
 * Coalesces the live "ranking-update" Socket.IO ping for a test so a burst
 * of near-simultaneous submissions (the "500 students submit together"
 * scenario) produces ONE top-10 read + ONE broadcast per short window,
 * instead of one full read+broadcast per individual submission. Purely
 * in-process (single Node server, per the deployment this app runs on) —
 * no new infra, just a Map and a setTimeout.
 */
const COALESCE_MS = 2000;
const pending = new Map(); // testId -> timer

function scheduleBroadcast(io, testId) {
  if (!io || !testId) return;
  if (pending.has(testId)) return; // a broadcast for this test is already queued within the window
  const timer = setTimeout(async () => {
    pending.delete(testId);
    try {
      const top = await Result.getTopN(testId, 10);
      io.to('test-' + testId).emit('ranking-update', {
        testId: testId,
        rankings: top.map(function (r) {
          return { userName: r.userName, coachingName: r.coachingName, obtainedMarks: r.obtainedMarks, totalMarks: r.totalMarks, timeTaken: r.timeTaken, rank: r.rank, batch: r.batch };
        }),
      });
    } catch (e) { console.error('[ranking-broadcast]', e); }
  }, COALESCE_MS);
  pending.set(testId, timer);
}

module.exports = { scheduleBroadcast: scheduleBroadcast };

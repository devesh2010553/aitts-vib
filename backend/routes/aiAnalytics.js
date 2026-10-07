/**
 * POST /api/ai-analytics   { testId, qTimes?: number[] }
 *
 * Student-only. Reads the student's OWN result (never trusts client scores),
 * asks Gemini for a coaching report, caches it. See utils/aiAnalytics.js for
 * the cost-control rationale. Disabled instantly by the admin toggle.
 */
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const Test      = require('../dynamo/testModel');
const Result    = require('../dynamo/resultModel');
const { authenticateStudent } = require('../middleware/auth');
const { getFlags }  = require('../utils/featureFlags');
const { analyse }   = require('../utils/aiAnalytics');

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const CACHE_MAX    = 400;
const MAX_CONCURRENT = 6;

const cache = new Map(); // key -> { at, report }
let inFlight = 0;

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(k); return null; }
  return e.report;
}
function cacheSet(k, report) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  cache.set(k, { at: Date.now(), report });
}

// Per-STUDENT (not per-IP — a coaching centre can share one IP) cap, applied
// after authentication. Cache hits don't reach Gemini but still count; 8/hour
// is plenty for reviewing a handful of tests.
const perStudent = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8,
  keyGenerator: req => 'ai:' + req.user.uid,
  message: { error: 'You have used the AI analysis a lot this hour. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});

router.post('/', authenticateStudent, perStudent, async (req, res) => {
  try {
    const flags = await getFlags();
    if (!flags.aiAnalytics) return res.status(403).json({ error: 'AI analysis is currently turned off.' });

    const testId = String((req.body && req.body.testId) || '').slice(0, 100);
    if (!testId) return res.status(400).json({ error: 'testId required' });

    const result = await Result.getByUserAndTest(req.user.uid, testId);
    if (!result || result.inProgress) return res.status(404).json({ error: 'Result not found' });

    const ckey = [req.user.uid, testId, result.obtainedMarks, result.timeTaken].join('|');
    const hit = cacheGet(ckey);
    if (hit) return res.json({ report: hit, cached: true });

    const test = await Test.getById(testId);
    if (!test || !Array.isArray(test.questions)) return res.status(404).json({ error: 'Test not found' });

    // Optional per-question seconds measured in the student's browser. Only
    // used if it lines up exactly with the question list; clamped; it can only
    // affect this student's own report.
    let qTimes = req.body && req.body.qTimes;
    qTimes = (Array.isArray(qTimes) && qTimes.length === test.questions.length)
      ? qTimes.map(n => Math.max(0, Math.min(7200, Math.round(Number(n) || 0)))) : null;

    if (inFlight >= MAX_CONCURRENT) return res.status(429).json({ error: 'Many students are asking AI right now. Please retry in a few seconds.' });
    inFlight++;
    try {
      const report = await analyse(test, result, qTimes);
      cacheSet(ckey, report);
      res.json({ report, cached: false });
    } finally { inFlight--; }
  } catch (err) {
    res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || 'AI analysis failed' });
  }
});

module.exports = router;

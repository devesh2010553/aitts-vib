/**
 * routes/leaderboard.js
 *
 * Three leaderboard types:
 * 1. Per-test ranking       GET /leaderboard/test/:testId
 * 2. Overall (percentage)   GET /leaderboard/overall?batch=
 *    Rank by: (sum of obtained marks / sum of total marks) * 100
 *    Tiebreak: total time taken ascending
 * 3. Normalised cross-batch GET /leaderboard/normalised
 *    Each student's score = percentage across all attempted tests
 *    Fair across batches since 80/80 = 100% = 85/100 = 85%
 */
const express     = require('express');
const router      = express.Router();
const Result      = require('../models/Result');
const Test        = require('../models/Test');
const UserProfile = require('../models/UserProfile');
const { authenticateStudent } = require('../middleware/auth');
const { getCached, safeBatch } = require('../utils/leaderboardCache');

// ── 1. Per-test ranking ────────────────────────────────────────────────────
router.get('/test/:testId', authenticateStudent, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    const filter = { testId: req.params.testId, inProgress: false };
    if (batch) filter.batch = batch;

    // Only the shared rankings list is cacheable — myRank/myResult are
    // per-viewer and must stay live.
    const cacheKey = `test:${req.params.testId}:${batch}`;
    const sanitized = await getCached(cacheKey, 'per-test', { testId: req.params.testId, batch }, async () => {
      const results = await Result.find(filter)
        .sort({ obtainedMarks: -1, timeTaken: 1 })
        .limit(500)
        .select('userName userEmail coachingName obtainedMarks totalMarks timeTaken submittedAt batch userId')
        .lean();

      const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
      return results.map((o, i) => {
        const out = { ...o };
        if (out.userEmail) { const p = out.userEmail.split('@'); out.userEmail = p[0].slice(0,2) + '***@' + (p[1]||''); }
        return { ...out, rank: i + 1, percentage: out.totalMarks ? ((out.obtainedMarks / out.totalMarks) * 100).toFixed(1) : '0.0', batchLabel: bMap[out.batch] || out.batch };
      });
    });

    // My rank — always computed live (never cached), since it's per-viewer.
    let myRank = null, myResult = null;
    if (req.user) {
      myResult = await Result.findOne({ userId: req.user._id, testId: req.params.testId, inProgress: false }).lean();
      if (myResult) {
        const above = await Result.countDocuments({
          ...filter,
          $or: [
            { obtainedMarks: { $gt: myResult.obtainedMarks } },
            { obtainedMarks: myResult.obtainedMarks, timeTaken: { $lt: myResult.timeTaken } }
          ]
        });
        myRank = above + 1;
      }
    }

    res.json({ rankings: sanitized, total: sanitized.length, myRank, myResult: myResult ? { obtainedMarks: myResult.obtainedMarks, totalMarks: myResult.totalMarks, timeTaken: myResult.timeTaken } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. Overall leaderboard (percentage-based) ─────────────────────────────
router.get('/overall', authenticateStudent, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    const cacheKey = `overall:${batch}`;
    const payload = await getCached(cacheKey, 'overall', { batch }, async () => {
      // Aggregate per student: sum obtained, sum total, sum time
      const pipeline = [
        { $match: { inProgress: false } },
        { $group: {
            _id: '$userId',
            totalObtained: { $sum: '$obtainedMarks' },
            totalPossible: { $sum: '$totalMarks'    },
            totalTime:     { $sum: '$timeTaken'     },
            testCount:     { $sum: 1                },
            userName:      { $last: '$userName'     },
            coachingName:  { $last: '$coachingName' },
            batch:         { $last: '$batch'        },
        }},
        { $match: { testCount: { $gte: 1 } } },
      ];
      if (batch) pipeline.splice(1, 0, { $match: { batch } });

      let rows = await Result.aggregate(pipeline);

      // Calculate percentage and sort
      rows = rows.map(r => ({
        ...r,
        percentage: r.totalPossible > 0 ? (r.totalObtained / r.totalPossible * 100) : 0,
      })).sort((a, b) => b.percentage - a.percentage || a.totalTime - b.totalTime);

      const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
      return rows.map((r, i) => ({
        rank:         i + 1,
        name:         r.userName     || 'Unknown',
        coachingName: r.coachingName || '--',
        batch:        bMap[r.batch]  || r.batch || '--',
        testCount:    r.testCount,
        totalObtained:r.totalObtained,
        totalPossible:r.totalPossible,
        percentage:   r.percentage.toFixed(2),
        totalTime:    r.totalTime,
      }));
    });
    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2b. Class / All leaderboard (marks-weighted, fixed denominator) ───────
// Rank = (marks obtained across attempted tests) / (marks possible across
// EVERY published test in scope) — a skipped test still counts toward the
// denominator (scores 0 for it), so consistent performers across many tests
// rank above a single lucky high score. batch='' scopes to every published
// test across all batches (used by the "All" tab); batch=11/12/dropper
// scopes to tests targeting that batch. Also returns the test list for the
// UI's per-test dropdown.
router.get('/class', authenticateStudent, async (req, res) => {
  try {
    const { batch } = req.query;
    if (batch && !['11', '12', 'dropper'].includes(batch)) {
      return res.status(400).json({ error: 'batch must be 11, 12, dropper, or omitted for all' });
    }

    const cacheKey = `class:${batch || ''}`;
    const payload = await getCached(cacheKey, 'class-cumulative', { batch: batch || '' }, async () => {
      // Tests in scope: for a specific batch, targeting it (empty targetBatches = all batches);
      // for "All", every published test regardless of target.
      const testFilter = batch
        ? { isPublished: true, $or: [{ targetBatches: { $size: 0 } }, { targetBatches: batch }] }
        : { isPublished: true };
      const tests = await Test.find(testFilter).select('_id title totalMarks createdAt').sort({ createdAt: 1 }).lean();

      const testIds = tests.map(t => t._id);
      const totalTests = testIds.length;
      const totalPossibleAll = tests.reduce((s, t) => s + (t.totalMarks || 0), 0);

      const resultMatch = { testId: { $in: testIds }, inProgress: false };
      if (batch) resultMatch.batch = batch;

      const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
      let rows = [];
      if (totalTests > 0) {
        rows = await Result.aggregate([
          { $match: resultMatch },
          { $group: {
              _id:           '$userId',
              userName:      { $last: '$userName' },
              coachingName:  { $last: '$coachingName' },
              batch:         { $last: '$batch' },
              testsTaken:    { $sum: 1 },
              totalObtained: { $sum: '$obtainedMarks' },
              totalTime:     { $sum: '$timeTaken' },
          }},
        ]);
      }

      const sorted = rows
        .map(r => ({ ...r, avgPercentage: totalPossibleAll > 0 ? (r.totalObtained / totalPossibleAll * 100) : 0 }))
        .sort((a, b) => b.avgPercentage - a.avgPercentage || a.totalTime - b.totalTime)
        .map((r, i) => ({
          rank:          i + 1,
          name:          r.userName     || 'Unknown',
          coachingName:  r.coachingName || '--',
          batch:         bMap[r.batch]  || r.batch || '--',
          testsTaken:    r.testsTaken,
          totalTests,
          totalObtained: r.totalObtained,
          totalPossible: totalPossibleAll,
          avgPercentage: r.avgPercentage.toFixed(2),
          totalTime:     r.totalTime,
        }));

      return {
        batch: batch || '',
        totalTests,
        totalPossible: totalPossibleAll,
        tests: tests.map(t => ({ _id: t._id, title: t.title })),
        leaderboard: sorted,
      };
    });

    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. Normalised cross-batch leaderboard ─────────────────────────────────
// Same as overall but always includes ALL batches, sorted by percentage
router.get('/normalised', authenticateStudent, async (req, res) => {
  try {
    const payload = await getCached('normalised', 'normalised', {}, async () => {
      const rows = await Result.aggregate([
        { $match: { inProgress: false } },
        { $group: {
            _id:          '$userId',
            totalObtained:{ $sum: '$obtainedMarks' },
            totalPossible:{ $sum: '$totalMarks'    },
            totalTime:    { $sum: '$timeTaken'     },
            testCount:    { $sum: 1                },
            userName:     { $last: '$userName'     },
            coachingName: { $last: '$coachingName' },
            batch:        { $last: '$batch'        },
        }},
        { $match: { testCount: { $gte: 1 }, totalPossible: { $gt: 0 } } },
      ]);

      const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
      return rows
        .map(r => ({ ...r, percentage: r.totalObtained / r.totalPossible * 100 }))
        .sort((a, b) => b.percentage - a.percentage || a.totalTime - b.totalTime)
        .map((r, i) => ({
          rank:         i + 1,
          name:         r.userName     || 'Unknown',
          coachingName: r.coachingName || '--',
          batch:        bMap[r.batch]  || r.batch || '--',
          testCount:    r.testCount,
          totalObtained:r.totalObtained,
          totalPossible:r.totalPossible,
          percentage:   r.percentage.toFixed(2),
          totalTime:    r.totalTime,
        }));
    });

    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET student's own archived results (after MongoDB cleared)
router.get('/archived/:userId', authenticateStudent, async (req, res) => {
  try {
    // Students can only read their own archive
    if (String(req.user._id) !== req.params.userId && req.params.userId !== 'me') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { readArchivedResults } = require('../utils/sheets');
    // Pass no testId to get all results for this user from archive
    const allRows = await readArchivedResults(null, null);
    const userId  = String(req.user._id);
    const myRows  = allRows.filter(r => r.userId === userId);
    res.json(myRows.sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt)));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
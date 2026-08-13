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

// ── 1. Per-test ranking ────────────────────────────────────────────────────
router.get('/test/:testId', authenticateStudent, async (req, res) => {
  try {
    const { batch } = req.query;
    const filter = { testId: req.params.testId, inProgress: false };
    if (batch) filter.batch = batch;

    const results = await Result.find(filter)
      .sort({ obtainedMarks: -1, timeTaken: 1 })
      .limit(500)
      .select('userName userEmail coachingName obtainedMarks totalMarks timeTaken submittedAt batch userId');

    // My rank
    let myRank = null, myResult = null;
    if (req.user) {
      myResult = await Result.findOne({ userId: req.user._id, testId: req.params.testId, inProgress: false });
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

    const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
    const sanitized = results.map((r, i) => {
      const o = r.toObject();
      if (o.userEmail) { const p = o.userEmail.split('@'); o.userEmail = p[0].slice(0,2) + '***@' + (p[1]||''); }
      return { ...o, rank: i + 1, percentage: o.totalMarks ? ((o.obtainedMarks / o.totalMarks) * 100).toFixed(1) : '0.0', batchLabel: bMap[o.batch] || o.batch };
    });

    res.json({ rankings: sanitized, total: sanitized.length, myRank, myResult: myResult ? { obtainedMarks: myResult.obtainedMarks, totalMarks: myResult.totalMarks, timeTaken: myResult.timeTaken } : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. Overall leaderboard (percentage-based) ─────────────────────────────
router.get('/overall', authenticateStudent, async (req, res) => {
  try {
    const { batch } = req.query;

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
    res.json(rows.map((r, i) => ({
      rank:         i + 1,
      name:         r.userName     || 'Unknown',
      coachingName: r.coachingName || '--',
      batch:        bMap[r.batch]  || r.batch || '--',
      testCount:    r.testCount,
      totalObtained:r.totalObtained,
      totalPossible:r.totalPossible,
      percentage:   r.percentage.toFixed(2),
      totalTime:    r.totalTime,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2b. Class leaderboard (cumulative avg %, penalises skipped tests) ─────
// Rank = (sum of each attempted test's %) / (total tests published for this class)
// A student who skips a test is scored 0% for it — rewards consistency over
// a single lucky 100%. Also returns the list of tests for that class so the
// UI can offer a per-test dropdown.
router.get('/class', authenticateStudent, async (req, res) => {
  try {
    const { batch } = req.query;
    if (!['11', '12', 'dropper'].includes(batch)) {
      return res.status(400).json({ error: 'Valid batch (11, 12, dropper) required' });
    }

    // Tests targeting this batch (empty targetBatches = all batches)
    const tests = await Test.find({
      isPublished: true,
      $or: [{ targetBatches: { $size: 0 } }, { targetBatches: batch }]
    }).select('_id title createdAt').sort({ createdAt: 1 });

    const testIds = tests.map(t => t._id);
    const totalTests = testIds.length;

    let rows = [];
    if (totalTests > 0) {
      rows = await Result.aggregate([
        { $match: { testId: { $in: testIds }, batch, inProgress: false } },
        { $group: {
            _id:           '$userId',
            userName:      { $last: '$userName' },
            coachingName:  { $last: '$coachingName' },
            testsTaken:    { $sum: 1 },
            sumPercentage: { $sum: { $cond: [{ $gt: ['$totalMarks', 0] }, { $multiply: [{ $divide: ['$obtainedMarks', '$totalMarks'] }, 100] }, 0] } },
            totalObtained: { $sum: '$obtainedMarks' },
            totalPossible: { $sum: '$totalMarks' },
            totalTime:     { $sum: '$timeTaken' },
        }},
      ]);
    }

    const sorted = rows
      .map(r => ({ ...r, avgPercentage: totalTests > 0 ? r.sumPercentage / totalTests : 0 }))
      .sort((a, b) => b.avgPercentage - a.avgPercentage || a.totalTime - b.totalTime)
      .map((r, i) => ({
        rank:          i + 1,
        name:          r.userName     || 'Unknown',
        coachingName:  r.coachingName || '--',
        testsTaken:    r.testsTaken,
        totalTests,
        totalObtained: r.totalObtained,
        totalPossible: r.totalPossible,
        avgPercentage: r.avgPercentage.toFixed(2),
        totalTime:     r.totalTime,
      }));

    res.json({
      batch,
      totalTests,
      tests: tests.map(t => ({ _id: t._id, title: t.title })),
      leaderboard: sorted,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. Normalised cross-batch leaderboard ─────────────────────────────────
// Same as overall but always includes ALL batches, sorted by percentage
router.get('/normalised', authenticateStudent, async (req, res) => {
  try {
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
    const sorted = rows
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

    res.json(sorted);
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
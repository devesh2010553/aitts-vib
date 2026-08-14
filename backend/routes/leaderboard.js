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
    const test = await Test.findById(req.params.testId)
      .select('_id title totalMarks targetBatches isPublished')
      .lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    // Empty/missing targetBatches means the test is applicable to every batch.
    // Otherwise only the explicitly targeted batches are eligible.
    const targets = Array.isArray(test.targetBatches) ? test.targetBatches : [];
    const eligibleBatches = targets.length ? targets : ['11', '12', 'dropper'];
    const eligibleBatchSet = new Set(eligibleBatches);
    const filter = {
      testId: test._id,
      inProgress: false,
      batch: batch ? batch : { $in: eligibleBatches }
    };

    // Only the shared rankings list is cacheable — myRank/myResult are
    // per-viewer and must stay live.
    const cacheKey = `test-v2:${req.params.testId}:${batch}`;
    const sanitized = await getCached(cacheKey, 'per-test', { testId: req.params.testId, batch }, async () => {
      const results = await Result.find(filter)
        .sort({ obtainedMarks: -1, timeTaken: 1 })
        .limit(500)
        .select('userName userEmail coachingName obtainedMarks totalMarks timeTaken submittedAt batch userId')
        .lean();

      const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
      return results.map((o, i) => {
        const out = { ...o };
        if (out.userEmail) {
          const p = out.userEmail.split('@');
          out.userEmail = p[0].slice(0,2) + '***@' + (p[1]||'');
        }
        return {
          ...out,
          rank: i + 1,
          percentage: out.totalMarks ? ((out.obtainedMarks / out.totalMarks) * 100).toFixed(1) : '0.0',
          batchLabel: bMap[out.batch] || out.batch
        };
      });
    });

    // My rank — always computed live (never cached), since it's per-viewer.
    let myRank = null, myResult = null;
    if (req.user && eligibleBatchSet.has(req.user.batch) && (!batch || batch === req.user.batch)) {
      myResult = await Result.findOne({
        userId: req.user._id,
        testId: req.params.testId,
        inProgress: false
      }).lean();

      // Do not treat a stale/ineligible result as an eligible attempt.
      if (myResult && !eligibleBatchSet.has(myResult.batch)) myResult = null;

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

    res.json({
      rankings: sanitized,
      total: sanitized.length,
      myRank,
      myResult: myResult
        ? { obtainedMarks: myResult.obtainedMarks, totalMarks: myResult.totalMarks, timeTaken: myResult.timeTaken }
        : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── 2b. Class / All leaderboard (student-specific applicable denominator) ─
// For every student independently:
//   applicable tests = published tests whose targetBatches include that
//   student's batch (or tests with no target restriction)
//   denominator     = sum(totalMarks of those applicable tests)
//   numerator       = sum(obtainedMarks from that student's attempted,
//                         applicable tests)
// A skipped applicable test contributes zero to the numerator but remains in
// the denominator. A test that targets another batch is completely excluded.
router.get('/class', authenticateStudent, async (req, res) => {
  try {
    const { batch } = req.query;
    if (batch && !['11', '12', 'dropper'].includes(batch)) {
      return res.status(400).json({ error: 'batch must be 11, 12, dropper, or omitted for all' });
    }

    // v2 deliberately prevents an old snapshot containing the previous global
    // denominator from ever being served after this logic change.
    const cacheKey = `class-v2:${batch || ''}`;

    const payload = await getCached(
      cacheKey,
      'class-cumulative',
      { batch: batch || '' },
      async () => {
        // For a class filter, only tests applicable to that class are exposed
        // to the dropdown. For "All", the dropdown contains every published
        // test; each row still calculates its own applicable set below.
        const tests = await Test.find({ isPublished: true })
          .select('_id title totalMarks createdAt targetBatches')
          .sort({ createdAt: 1 })
          .lean();

        const testIds = tests.map(t => t._id);
        const totalTests = tests.length;

        if (!testIds.length) {
          return {
            batch: batch || '',
            totalTests: 0,
            totalPossible: 0,
            tests: [],
            leaderboard: []
          };
        }

        const resultMatch = { testId: { $in: testIds }, inProgress: false };
        const results = await Result.find(resultMatch)
          .select('userId userName coachingName batch testId obtainedMarks timeTaken submittedAt')
          .lean();

        // UserProfile is the authoritative current class/batch. Result.batch
        // is retained only as a safe fallback for legacy/incomplete data.
        const userIds = [...new Set(results.map(r => String(r.userId)))];
        const profiles = userIds.length
          ? await UserProfile.find({ _id: { $in: userIds } })
              .select('name coachingName batch')
              .lean()
          : [];
        const profileMap = new Map(profiles.map(p => [String(p._id), p]));

        const bMap = { '11': 'Class 11', '12': 'Class 12', dropper: 'Dropper' };
        const testById = new Map(tests.map(t => [String(t._id), t]));

        function isApplicable(test, studentBatch) {
          const targets = Array.isArray(test.targetBatches) ? test.targetBatches : [];
          return targets.length === 0 || targets.includes(studentBatch);
        }

        // Group completed attempts by student. We deliberately do not derive
        // the denominator from this group: missing attempts must still count
        // as zero when their test is applicable.
        const byStudent = new Map();
        for (const result of results) {
          const uid = String(result.userId);
          const profile = profileMap.get(uid);
          const studentBatch = profile?.batch || result.batch;
          if (!studentBatch) continue;
          if (batch && studentBatch !== batch) continue;

          if (!byStudent.has(uid)) {
            byStudent.set(uid, {
              userId: uid,
              name: profile?.name || result.userName || 'Unknown',
              coachingName: profile?.coachingName || result.coachingName || '--',
              batch: studentBatch,
              attempts: new Map()
            });
          }

          // A result for a test that is no longer applicable to the student's
          // current batch must not affect the current cumulative calculation.
          const test = testById.get(String(result.testId));
          if (test && isApplicable(test, studentBatch)) {
            byStudent.get(uid).attempts.set(String(result.testId), result);
          }
        }

        const rows = [];
        for (const student of byStudent.values()) {
          const applicableTests = tests.filter(t => isApplicable(t, student.batch));
          const applicableTestIds = new Set(applicableTests.map(t => String(t._id)));

          let totalPossible = 0;
          let totalObtained = 0;
          let testsTaken = 0;
          let totalTime = 0;

          for (const test of applicableTests) {
            totalPossible += Number(test.totalMarks) || 0;

            const attempt = student.attempts.get(String(test._id));
            if (attempt) {
              testsTaken += 1;
              totalObtained += Number(attempt.obtainedMarks) || 0;
              totalTime += Number(attempt.timeTaken) || 0;
            }
          }

          // Only students with at least one attempted applicable test are
          // shown, matching the previous leaderboard's participation rule.
          if (!testsTaken) continue;

          rows.push({
            name: student.name,
            coachingName: student.coachingName,
            batch: bMap[student.batch] || student.batch || '--',
            testsTaken,
            totalTests: applicableTests.length,
            totalObtained,
            totalPossible,
            avgPercentage: totalPossible > 0 ? (totalObtained / totalPossible * 100) : 0,
            totalTime
          });
        }

        rows.sort((a, b) =>
          b.avgPercentage - a.avgPercentage ||
          a.totalTime - b.totalTime
        );

        const leaderboard = rows.map((r, i) => ({
          rank: i + 1,
          name: r.name,
          coachingName: r.coachingName,
          batch: r.batch,
          testsTaken: r.testsTaken,
          totalTests: r.totalTests,
          totalObtained: r.totalObtained,
          totalPossible: r.totalPossible,
          avgPercentage: r.avgPercentage.toFixed(2),
          totalTime: r.totalTime
        }));

        return {
          batch: batch || '',
          // These are only global metadata for the UI/test dropdown. Each row
          // has its own totalTests/totalPossible denominator.
          totalTests,
          totalPossible: tests.reduce((s, t) => s + (Number(t.totalMarks) || 0), 0),
          tests: tests
            .filter(t => !batch || isApplicable(t, batch))
            .map(t => ({ _id: t._id, title: t.title })),
          leaderboard
        };
      }
    );

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
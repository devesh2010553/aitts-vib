const express     = require('express');
const router      = express.Router();
const Result      = require('../models/Result');
const UserProfile = require('../models/UserProfile');
const { authenticateStudent } = require('../middleware/auth');
const { getCached, safeBatch } = require('../utils/leaderboardCache');

router.get('/test/:testId', authenticateStudent, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    const limit = Math.min(parseInt(req.query.limit)||200, 500);
    const filter = { testId:req.params.testId, inProgress:false };
    if (batch) filter.batch = batch;

    // Shared rankings list is cacheable (same test+batch+limit → same list for
    // every viewer); myRank/myResult stay live below since they're per-viewer.
    const cacheKey = `rankings:${req.params.testId}:${batch}:${limit}`;
    const { sanitized, total } = await getCached(cacheKey, 'per-test', { testId:req.params.testId, batch }, async () => {
      const [results, count] = await Promise.all([
        Result.find(filter).sort({ obtainedMarks:-1, timeTaken:1 }).limit(limit)
          .select('userName userEmail coachingName obtainedMarks totalMarks timeTaken submittedAt batch rank batchRank')
          .lean(),
        Result.countDocuments(filter)
      ]);
      const sanitized = results.map((obj,i) => {
        const out = { ...obj };
        if (out.userEmail) {
          const parts = out.userEmail.split('@');
          out.userEmail = parts[0].substring(0,2) + '***@' + (parts[1]||'');
        }
        return { ...out, rank: i+1 };
      });
      return { sanitized, total: count };
    });

    let myRank=null, myResult=null;
    if (req.user) {
      myResult = await Result.findOne({ userId:req.user._id, testId:req.params.testId, inProgress:false }).lean();
      if (myResult) {
        const above = await Result.countDocuments({ ...filter, $or:[{ obtainedMarks:{ $gt:myResult.obtainedMarks } },{ obtainedMarks:myResult.obtainedMarks, timeTaken:{ $lt:myResult.timeTaken } }] });
        myRank = above+1;
      }
    }
    res.json({ rankings:sanitized, total, myRank, myResult: myResult ? { obtainedMarks:myResult.obtainedMarks, totalMarks:myResult.totalMarks, rank:myResult.rank, batchRank:myResult.batchRank } : null });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/leaderboard', authenticateStudent, async (req, res) => {
  try {
    const batch = safeBatch(req.query.batch);
    const filter = { totalTests:{ $gt:0 } };
    if (batch) filter.batch = batch;
    const users = await UserProfile.find(filter).select('name coachingName batch totalTests totalMarks highestMarks').sort({ totalMarks:-1, highestMarks:-1 }).limit(200).lean();
    res.json(users.map((u,i) => ({ ...u, rank:i+1 })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/top-performers', async (req, res) => {
  try {
    const top = await UserProfile.find({ totalTests:{ $gt:0 } }).select('name coachingName batch totalMarks').sort({ totalMarks:-1 }).limit(10).lean();
    res.json(top.map((u,i) => ({ ...u, rank:i+1 })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;

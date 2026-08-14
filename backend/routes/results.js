const express = require('express');
const router  = express.Router();
const Result  = require('../models/Result');
const Test    = require('../models/Test');
const UserProfile = require('../models/UserProfile');
const { queueResult } = require('../utils/sheetsQueue');
const { invalidate } = require('../utils/leaderboardCache');
const { authenticateStudent } = require('../middleware/auth');

async function calcRanks(testId, obtainedMarks, timeTaken, batch) {
  const q = { testId, inProgress: false, $or: [{ obtainedMarks: { $gt: obtainedMarks } }, { obtainedMarks, timeTaken: { $lt: timeTaken } }] };
  const [o, b] = await Promise.all([Result.countDocuments(q), Result.countDocuments({ ...q, batch })]);
  return { overallRank: o+1, batchRank: b+1 };
}

router.post('/submit', authenticateStudent, async (req, res) => {
  try {
    const { testId, answers, startedAt, timeTaken } = req.body;
    const existing = await Result.findOne({ userId: req.user._id, testId });
    if (existing && !existing.inProgress) return res.status(400).json({ error: 'Already submitted' });
    // Grading only needs marks/correctness data — NOT question/option text or
    // images (the bulk of a ~2MB test document). Excluding them here is the
    // single biggest win for submission-burst performance (many students
    // submitting near the deadline at once).
    const test = await Test.findById(testId)
      .select('-questions.questionText -questions.questionImage -questions.options.text -questions.options.imageData -questions.explanation')
      .lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    let obtainedMarks=0, correctAnswers=0, wrongAnswers=0, notAttempted=0;
    const processedAnswers = [];
    for (const q of test.questions) {
      const ua = (answers||[]).find(a => a.questionId === q._id.toString());
      if (q.isMultiChoice) {
        const sel = (ua&&ua.selectedOptions)||[];
        const cor = q.options.reduce((a,o,i)=>{ if(o.isCorrect)a.push(i); return a; },[]);
        if (!sel.length) { notAttempted++; processedAnswers.push({ questionId:q._id, selectedOption:-1, selectedOptions:[], isCorrect:false, marksAwarded:0 }); }
        else {
          const ok = cor.every(i=>sel.includes(i)) && sel.every(i=>cor.includes(i));
          const ma = ok ? q.marks : -(q.negativeMarks||0);
          if(ok) correctAnswers++; else wrongAnswers++;
          obtainedMarks += ma;
          processedAnswers.push({ questionId:q._id, selectedOption:-1, selectedOptions:sel, isCorrect:ok, marksAwarded:ma });
        }
      } else {
        const s = (ua!=null&&ua.selectedOption!=null) ? ua.selectedOption : -1;
        if (s===-1) { notAttempted++; processedAnswers.push({ questionId:q._id, selectedOption:-1, isCorrect:false, marksAwarded:0 }); }
        else {
          const opt = q.options[s];
          if (opt&&opt.isCorrect) { correctAnswers++; obtainedMarks+=q.marks; processedAnswers.push({ questionId:q._id, selectedOption:s, isCorrect:true, marksAwarded:q.marks }); }
          else { wrongAnswers++; const neg=q.negativeMarks||0; obtainedMarks-=neg; processedAnswers.push({ questionId:q._id, selectedOption:s, isCorrect:false, marksAwarded:-neg }); }
        }
      }
    }
    obtainedMarks = Math.max(0, obtainedMarks);
    const testBonus = test.bonusMarks || 0;
    obtainedMarks += testBonus;
    const tt = Math.max(0, timeTaken||0);
    const { overallRank, batchRank } = await calcRanks(testId, obtainedMarks, tt, req.user.batch);
    const pct = test.totalMarks>0 ? Math.round(obtainedMarks/test.totalMarks*1000)/10 : 0;
    const rd = { userId:req.user._id, testId, userName:req.user.name, userEmail:req.user.email, coachingName:req.user.coachingName, batch:req.user.batch, answers:processedAnswers, totalMarks:test.totalMarks, obtainedMarks, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:overallRank, batchRank, startedAt:startedAt?new Date(startedAt):new Date(Date.now()-tt*1000), submittedAt:new Date(), inProgress:false, savedAnswers:{}, testBonusApplied:testBonus };
    let result;
    if (existing) { result = await Result.findOneAndUpdate({ userId:req.user._id, testId }, rd, { new:true }); }
    else { result = new Result(rd); await result.save(); }
    await Promise.all([
      Test.findByIdAndUpdate(testId, { $inc:{ attemptCount:1 } }),
      UserProfile.findByIdAndUpdate(req.user._id, { $inc:{ totalTests:1, totalMarks:obtainedMarks }, $max:{ highestMarks:obtainedMarks } })
    ]);
    queueResult({ submittedAt:new Date(), userName:req.user.name, userEmail:req.user.email, userPhone:req.user.phone||'', batch:req.user.batch, coachingName:req.user.coachingName, testTitle:test.title, subject:test.subject, topic:test.topic, obtainedMarks, totalMarks:test.totalMarks, percentage:pct, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:overallRank, batchRank, testId, userId:req.user._id });
    invalidate({ testId, batch: req.user.batch }); // fire-and-forget — see leaderboardCache.js
    const io = req.app.get('io');
    if (io) { const top = await Result.find({ testId, inProgress:false }).sort({ obtainedMarks:-1, timeTaken:1 }).limit(10).select('userName coachingName obtainedMarks totalMarks timeTaken rank batch').lean(); io.to('test-'+testId).emit('ranking-update', { testId, rankings:top }); }
    res.json({ message:'Submitted', result:{ id:result._id, obtainedMarks, totalMarks:test.totalMarks, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:overallRank, batchRank, batch:req.user.batch, percentage:pct } });
  } catch(err) { console.error('[RESULTS] submit:', err); res.status(500).json({ error:err.message||'Submission failed' }); }
});

router.get('/my/:testId', authenticateStudent, async (req, res) => {
  try {
    const result = await Result.findOne({ userId:req.user._id, testId:req.params.testId, inProgress:false }).lean();
    if (!result) return res.status(404).json({ error:'Result not found' });
    // The analysis view only renders questionText/explanation per question —
    // never images — so exclude the image fields from this payload too.
    const test = await Test.findById(req.params.testId).select('-questions.questionImage -questions.options.imageData').lean();
    const { overallRank, batchRank } = await calcRanks(req.params.testId, result.obtainedMarks, result.timeTaken, result.batch);
    const [total, totalBatch] = await Promise.all([Result.countDocuments({ testId:req.params.testId, inProgress:false }), Result.countDocuments({ testId:req.params.testId, batch:result.batch, inProgress:false })]);
    res.json({ result, test, rank:overallRank, batchRank, totalParticipants:total, totalBatchParticipants:totalBatch });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/my-results', authenticateStudent, async (req, res) => {
  try { res.json(await Result.find({ userId:req.user._id, inProgress:false }).populate('testId','title subject topic totalMarks').sort({ submittedAt:-1 }).lean()); }
  catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;

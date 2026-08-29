const express = require('express');
const router  = express.Router();
const Result  = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const Test    = require('../dynamo/testModel');   // was: const Test = require('../models/Test');
const User    = require('../dynamo/userModel');   // was: const UserProfile = require('../models/UserProfile');
const { queueResult } = require('../utils/sheetsQueue');
const { invalidate } = require('../utils/leaderboardCache');
const { authenticateStudent } = require('../middleware/auth');

router.post('/submit', authenticateStudent, async (req, res) => {
  try {
    const { testId, answers, startedAt, timeTaken } = req.body;
    const existing = await Result.getByUserAndTest(req.user.uid, testId);
    if (existing && !existing.inProgress) return res.status(400).json({ error: 'Already submitted' });

    // Grading only needs marks/correctness data — the DynamoDB Test item is
    // fetched whole (no server-side field projection like Mongo's .select()
    // for a single GetItem), but nothing here transmits the images/text
    // back OUT to the client — only the grading result does, same as before.
    const test = await Test.getById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    // Same batch enforcement as GET /:id in tests.js — belt-and-suspenders,
    // since submit is the endpoint that actually records a graded result.
    // Blocking it here means even a request built by hand (bypassing the
    // dashboard and the test-open route) can't produce a scored attempt for
    // a batch the test wasn't published to.
    if (test.targetBatches && test.targetBatches.length && !test.targetBatches.includes(req.user.batch)) {
      return res.status(403).json({ error: 'This test is not available for your class/batch' });
    }

    let obtainedMarks=0, correctAnswers=0, wrongAnswers=0, notAttempted=0;
    const processedAnswers = [];
    for (const q of test.questions) {
      const ua = (answers||[]).find(a => a.questionId === q.questionId);
      if (q.isMultiChoice) {
        const sel = (ua&&ua.selectedOptions)||[];
        const cor = q.options.reduce((a,o,i)=>{ if(o.isCorrect)a.push(i); return a; },[]);
        if (!sel.length) { notAttempted++; processedAnswers.push({ questionId:q.questionId, selectedOption:-1, selectedOptions:[], isCorrect:false, marksAwarded:0 }); }
        else {
          const ok = cor.every(i=>sel.includes(i)) && sel.every(i=>cor.includes(i));
          const ma = ok ? q.marks : -(q.negativeMarks||0);
          if(ok) correctAnswers++; else wrongAnswers++;
          obtainedMarks += ma;
          processedAnswers.push({ questionId:q.questionId, selectedOption:-1, selectedOptions:sel, isCorrect:ok, marksAwarded:ma });
        }
      } else {
        const s = (ua!=null&&ua.selectedOption!=null) ? ua.selectedOption : -1;
        if (s===-1) { notAttempted++; processedAnswers.push({ questionId:q.questionId, selectedOption:-1, isCorrect:false, marksAwarded:0 }); }
        else {
          const opt = q.options[s];
          if (opt&&opt.isCorrect) { correctAnswers++; obtainedMarks+=q.marks; processedAnswers.push({ questionId:q.questionId, selectedOption:s, isCorrect:true, marksAwarded:q.marks }); }
          else { wrongAnswers++; const neg=q.negativeMarks||0; obtainedMarks-=neg; processedAnswers.push({ questionId:q.questionId, selectedOption:s, isCorrect:false, marksAwarded:-neg }); }
        }
      }
    }
    obtainedMarks = Math.max(0, obtainedMarks);
    const testBonus = test.bonusMarks || 0;
    obtainedMarks += testBonus;
    const tt = Math.max(0, timeTaken||0);
    const { overallRank, batchRank } = await Result.computeRanks(testId, req.user.batch, obtainedMarks, tt);
    const pct = test.totalMarks>0 ? Math.round(obtainedMarks/test.totalMarks*1000)/10 : 0;
    const rd = {
      userName:req.user.name, userEmail:req.user.email, coachingName:req.user.coachingName, batch:req.user.batch,
      answers:processedAnswers, totalMarks:test.totalMarks, obtainedMarks, correctAnswers, wrongAnswers, notAttempted,
      timeTaken:tt, rank:overallRank, batchRank,
      startedAt: (startedAt?new Date(startedAt):new Date(Date.now()-tt*1000)).toISOString(),
      submittedAt: new Date().toISOString(),
      violations: (existing && existing.violations) || 0, bonusMarks: 0, testBonusApplied:testBonus,
    };
    const result = await Result.submit(req.user.uid, testId, rd);

    await Promise.all([
      Test.incrementAttemptCount(testId),
      User.applySubmitStats(req.user.uid, { marksGained: obtainedMarks }),
    ]);
    queueResult({ submittedAt:new Date(), userName:req.user.name, userEmail:req.user.email, userPhone:req.user.phone||'', batch:req.user.batch, coachingName:req.user.coachingName, testTitle:test.title, subject:test.subject, topic:test.topic, obtainedMarks, totalMarks:test.totalMarks, percentage:pct, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:overallRank, batchRank, testId, userId:req.user.uid });
    invalidate({ testId, batch: req.user.batch }); // fire-and-forget — see leaderboardCache.js
    const io = req.app.get('io');
    if (io) {
      const top = (await Result.queryByTest(testId))
        .filter(r => !r.inProgress)
        .sort((a,b) => b.obtainedMarks - a.obtainedMarks || a.timeTaken - b.timeTaken)
        .slice(0, 10)
        .map(r => ({ userName:r.userName, coachingName:r.coachingName, obtainedMarks:r.obtainedMarks, totalMarks:r.totalMarks, timeTaken:r.timeTaken, rank:r.rank, batch:r.batch }));
      io.to('test-'+testId).emit('ranking-update', { testId, rankings:top });
    }
    res.json({ message:'Submitted', result:{ id: result.testId, obtainedMarks, totalMarks:test.totalMarks, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:overallRank, batchRank, batch:req.user.batch, percentage:pct } });
  } catch(err) { console.error('[RESULTS] submit:', err); res.status(500).json({ error:err.message||'Submission failed' }); }
});

router.get('/my/:testId', authenticateStudent, async (req, res) => {
  try {
    const result = await Result.getByUserAndTest(req.user.uid, req.params.testId);
    if (!result || result.inProgress) return res.status(404).json({ error:'Result not found' });
    // The analysis view only renders questionText/explanation per question —
    // never images — stripped here in JS since DynamoDB's GetItem doesn't
    // support Mongo-style nested-field exclusion projections the way
    // .select('-questions.questionImage ...') did.
    const rawTest = await Test.getById(req.params.testId);
    // _id: q.questionId aliased for the same reason as tests.js's GET /:id —
    // the analysis view (index.html) matches a saved answer to its question
    // via q._id.
    const test = rawTest ? { ...rawTest, _id: rawTest.testId, questions: rawTest.questions.map(q => { const { questionImage, options, ...rest } = q; return { ...rest, _id: q.questionId, options: options.map(o => { const { imageData, ...oRest } = o; return oRest; }) }; }) } : null;
    const { overallRank, batchRank } = await Result.computeRanks(req.params.testId, result.batch, result.obtainedMarks, result.timeTaken);
    const allForTest = (await Result.queryByTest(req.params.testId)).filter(r => !r.inProgress);
    const total = allForTest.length;
    const totalBatch = allForTest.filter(r => r.batch === result.batch).length;
    res.json({ result, test, rank:overallRank, batchRank, totalParticipants:total, totalBatchParticipants:totalBatch });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/my-results', authenticateStudent, async (req, res) => {
  try {
    const results = (await Result.queryByUser(req.user.uid)).filter(r => !r.inProgress).sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    // Replaces .populate('testId', 'title subject topic totalMarks') — fetch
    // each referenced test directly (DynamoDB has no cross-item join).
    const tests = await Promise.all(results.map(r => Test.getById(r.testId)));
    res.json(results.map((r, i) => ({
      ...r,
      testId: tests[i] ? { _id: tests[i].testId, title: tests[i].title, subject: tests[i].subject, topic: tests[i].topic, totalMarks: tests[i].totalMarks } : r.testId,
    })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;

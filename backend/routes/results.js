const express = require('express');
const router  = express.Router();
const Result  = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const Test    = require('../dynamo/testModel');   // was: const Test = require('../models/Test');
const User    = require('../dynamo/userModel');   // was: const UserProfile = require('../models/UserProfile');
const { queueResult } = require('../utils/sheetsQueue');
const { invalidate } = require('../utils/leaderboardCache');
const { scheduleBroadcast } = require('../utils/rankingBroadcast');
const { authenticateStudent } = require('../middleware/auth');

router.post('/submit', authenticateStudent, async (req, res) => {
  try {
    const { testId, answers, startedAt, timeTaken } = req.body;
    const existing = await Result.getByUserAndTest(req.user.uid, testId);
    if (existing && !existing.inProgress) return res.status(400).json({ error: 'Already submitted' });

    // Grading only needs marks/correctness data — getForGrading() is a
    // short-TTL, explicitly-invalidated in-process cache over the full
    // test item (see backend/dynamo/testModel.js) so a burst of
    // simultaneous submissions for the same test doesn't each pay for a
    // separate full GetItem read of identical, unchanging data. Nothing
    // here transmits the images/text back OUT to the client — only the
    // grading result does, same as before.
    const test = await Test.getForGrading(testId);
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
    // Negative marking is allowed to carry through to the final score —
    // previously clamped to a floor of 0 here, so a student who, say,
    // scored +5 from correct answers and -6 from negative marking on wrong
    // ones would show as 0/total instead of the true -1/total. Removed the
    // clamp: obtainedMarks (and the percentage derived from it below) can
    // now legitimately go negative, exactly matching what the admin
    // configured per-question (+marks / -negativeMarks).
    const testBonus = test.bonusMarks || 0;
    obtainedMarks += testBonus;
    const tt = Math.max(0, timeTaken||0);
    // computeRanks now runs targeted Select:COUNT queries against the
    // TestIndex GSI (see resultModel.js) instead of fetching every result
    // for the test — same exact rank rule, far cheaper per submission.
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

    // Result.submit() is now atomic + idempotent: the write itself is
    // conditioned on "no final result exists yet for this user+test", so a
    // double-click, a client retry after a dropped response, or two
    // near-simultaneous submit requests can never create two final results,
    // double-count the attempt, or produce a duplicate Sheets export row.
    // If this IS a genuine duplicate, treat it as a safe idempotent
    // response — return the result that was already recorded — instead of
    // an error, and skip every side effect below since they already ran
    // once for the original submission.
    let result, isDuplicate = false;
    try {
      result = await Result.submit(req.user.uid, testId, rd);
    } catch (err) {
      if (err.alreadySubmitted && err.existing) {
        result = err.existing;
        isDuplicate = true;
      } else {
        throw err;
      }
    }

    // CONCURRENT-SUBMISSION RANK RECONCILIATION
    // overallRank/batchRank above were computed from a read taken BEFORE
    // this write landed. Under real concurrency that read can miss:
    //   (a) this exact submission's own row (it didn't exist yet at read
    //       time — every submission necessarily undercounts itself), and
    //   (b) any other student's submission that finished writing in the
    //       (typically tiny, but non-zero) gap between that read and this
    //       write.
    // Now that the write has landed, computeRanks() is re-run once more —
    // this read is guaranteed to see this student's own row, plus anyone
    // else who has already finished by this exact moment — and the result
    // is corrected in place with a plain single-item UpdateCommand (see
    // Result.reconcileRank). This is authoritative, not a delay/retry
    // trick: it does not "wait and hope," it recomputes from whatever is
    // actually true right now and writes that.
    // HONEST LIMIT: this closes the gap for THIS request as of the moment
    // its own write completed. It does not provide cross-request atomic
    // consensus — two submissions whose writes land within the same
    // instant can each finish reconciling before seeing the other's row,
    // the same way two independent counters can. What it guarantees is
    // that every stored rank was computed from real, already-persisted
    // state at some well-defined moment no earlier than that student's own
    // write — never from a stale pre-write snapshot — and that the *live*
    // rank shown anywhere else in the app (leaderboard.js, rankings.js,
    // /results/my/:testId) is always computed fresh at request time
    // regardless of what's stored here, so any residual staleness in this
    // stored snapshot is bounded to "until the next time anyone looks."
    let finalOverallRank = overallRank, finalBatchRank = batchRank;
    if (!isDuplicate) {
      try {
        const reconciled = await Result.reconcileRank(req.user.uid, testId, req.user.batch, obtainedMarks, tt);
        finalOverallRank = reconciled.overallRank;
        finalBatchRank = reconciled.batchRank;
      } catch (e) {
        // Reconciliation is a correction on top of an already-valid,
        // already-persisted result — if it fails (transient DB error), the
        // student's result is still safely saved with the pre-write rank
        // as a fallback. Never let this fail the submission itself.
        console.error('[RESULTS] rank reconciliation failed (non-fatal):', e);
      }
    }

    if (!isDuplicate) {
      await Promise.all([
        Test.incrementAttemptCount(testId),
        User.applySubmitStats(req.user.uid, { marksGained: obtainedMarks }),
      ]);
      queueResult({ submittedAt:new Date(), userName:req.user.name, userEmail:req.user.email, userPhone:req.user.phone||'', batch:req.user.batch, coachingName:req.user.coachingName, testTitle:test.title, subject:test.subject, topic:test.topic, obtainedMarks, totalMarks:test.totalMarks, percentage:pct, correctAnswers, wrongAnswers, notAttempted, timeTaken:tt, rank:finalOverallRank, batchRank:finalBatchRank, testId, userId:req.user.uid });
      invalidate({ testId, batch: req.user.batch }); // fire-and-forget — see leaderboardCache.js
      // Coalesced: bursts of near-simultaneous submissions for the same
      // test collapse into one top-10 read + one broadcast per short
      // window instead of one per submission (see rankingBroadcast.js).
      scheduleBroadcast(req.app.get('io'), testId);
    }

    const out = isDuplicate ? result : rd;
    const outRank = isDuplicate ? out.rank : finalOverallRank;
    const outBatchRank = isDuplicate ? out.batchRank : finalBatchRank;
    res.json({ message: isDuplicate ? 'Already submitted' : 'Submitted', result:{ id: result.testId, obtainedMarks: out.obtainedMarks, totalMarks: test.totalMarks, correctAnswers: out.correctAnswers, wrongAnswers: out.wrongAnswers, notAttempted: out.notAttempted, timeTaken: out.timeTaken, rank: outRank, batchRank: outBatchRank, batch: out.batch, percentage: test.totalMarks>0 ? Math.round(out.obtainedMarks/test.totalMarks*1000)/10 : 0 } });
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
    // Participant counts used to be derived from a full fetch of every
    // result row for the test (`.length`) — now a COUNT-only query, no
    // item data transferred just to report two numbers.
    const [total, totalBatch] = await Promise.all([
      Result.countForTest(req.params.testId),
      Result.countForTest(req.params.testId, result.batch),
    ]);
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

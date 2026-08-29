const express = require('express');
const router  = express.Router();
const Test    = require('../dynamo/testModel');   // was: const Test = require('../models/Test');
const Result  = require('../dynamo/resultModel'); // was: const Result = require('../models/Result');
const AdImage = require('../models/AdImage'); // stays on MongoDB (MONGODB_URI2) — not part of this migration
const { authenticateStudent } = require('../middleware/auth');

// Dashboard/list view — lightweight metadata only. Does NOT select `questions`
// (full question bank + base64 images, ~2MB/test): the full test is only ever
// needed when a student actually opens it (GET /:id below). questionCount
// (maintained on the Test model) replaces the old `questions.length` usage.
router.get('/', authenticateStudent, async (req, res) => {
  try {
    const tests = await Test.listPublished(); // uses PublishedIndex GSI — see backend/dynamo/testModel.js
    // A test with no targetBatches set (empty array — old tests, or an admin
    // who left it blank) is treated as visible to everyone, same as before
    // this filter existed. Once targetBatches has entries, only students in
    // one of those batches see it — this is the check that was missing
    // entirely: every published test was showing (and, via GET /:id below,
    // was openable and submittable) to every student regardless of batch.
    const visible = tests.filter(t => !t.targetBatches || !t.targetBatches.length || t.targetBatches.includes(req.user.batch));
    const userResults = await Result.queryByUser(req.user.uid);
    const map = {};
    userResults.forEach(r => { map[r.testId] = r; });
    res.json(visible.map(t => {
      const r = map[t.testId];
      return {
        testId: t.testId, _id: t.testId, // _id kept as an alias — the frontend/other callers reference either name in a few spots
        title: t.title, subject: t.subject, topic: t.topic, description: t.description,
        duration: t.duration, totalMarks: t.totalMarks, questionCount: t.questionCount,
        attemptCount: t.attemptCount, startTime: t.startTime, endTime: t.endTime,
        adEnabled: t.adEnabled, adImages: t.adImages, targetBatches: t.targetBatches,
        attempted: !!r && !r.inProgress,
        inProgress: !!r && !!r.inProgress,
        myResult: r ? { obtainedMarks: r.obtainedMarks, rank: r.rank, batchRank: r.batchRank } : null,
      };
    }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Full test detail — the ONLY route that legitimately needs full questions +
// images, because the student is about to take the exam. Unchanged in shape.
router.get('/:id', authenticateStudent, async (req, res) => {
  try {
    const test = await Test.getById(req.params.id);
    if (!test || test.isPublished !== 'true' || test.isActive === false) return res.status(404).json({ error:'Test not found' });
    // Same batch check as the list route, enforced again here on purpose:
    // this is the route that actually serves questions and lets a student
    // start/submit a test, so it's the one that has to hold even if
    // something bypasses the dashboard list (a stale tab, a direct API
    // call, etc). Without this, a Class 11 student could open and submit a
    // Class-12-only test directly by testId even though it never should
    // have been reachable — matches what you saw.
    if (test.targetBatches && test.targetBatches.length && !test.targetBatches.includes(req.user.batch)) {
      return res.status(403).json({ error: 'This test is not available for your class/batch' });
    }
    const existing = await Result.getByUserAndTest(req.user.uid, req.params.id);
    if (existing && !existing.inProgress) return res.status(400).json({ error:'Already submitted', resultId: existing.testId });
    // _id: q.questionId aliased per question, and _id: test.testId on the
    // test itself — the student frontend (index.html) still reads
    // S.currentTest._id and q._id everywhere (save-progress, submit,
    // cheat-log, grading-answer matching). Without this, those all silently
    // sent/compared against `undefined`: save-progress/submit/cheat-log hit
    // DynamoDB with a missing key attribute ("provided key element does not
    // match the schema"), and even once a testId got through, answers were
    // built as {questionId: undefined, ...} and could never match a real
    // question when grading in routes/results.js.
    const questions = test.questions.map(q => ({
      ...q,
      _id: q.questionId,
      options: q.options.map(o => ({ optionId: o.optionId, text: o.text, imageData: o.imageData || '' })),
      isMultiChoice: q.isMultiChoice || false,
    }));
    let resumeData = null;
    if (existing && existing.inProgress) resumeData = { savedAnswers: existing.savedAnswers || {}, violations: existing.violations || 0 };
    res.json({ ...test, _id: test.testId, questions, resumeData });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/:id/ad', authenticateStudent, async (req, res) => {
  try {
    const test = await Test.getById(req.params.id);
    if (!test || !test.adEnabled || !test.adImages || !test.adImages.length) return res.json({ adEnabled:false, images:[] });
    // AdImage lives on MongoDB (MONGODB_URI2, see models/AdImage.js) — a
    // different data store entirely now that Test is on DynamoDB, so this
    // is (as it already was before this migration) an explicit
    // fetch-by-id-list rather than any kind of join/populate.
    const images = await AdImage.find({ _id:{ $in:test.adImages } }).select('imageData redirectUrl title description').lean();
    res.json({ adEnabled:true, images, adRedirectUrl:test.adRedirectUrl||'', adHtml:test.adHtml||'' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.post('/:id/save-progress', authenticateStudent, async (req, res) => {
  try {
    const test = await Test.getById(req.params.id);
    if (!test) return res.status(404).json({ error:'Test not found' });
    if (test.targetBatches && test.targetBatches.length && !test.targetBatches.includes(req.user.batch)) {
      return res.status(403).json({ error: 'This test is not available for your class/batch' });
    }
    const { savedAnswers, violations } = req.body;
    await Result.saveProgress(req.user.uid, req.params.id, {
      savedAnswers: savedAnswers || {}, violations: violations || 0, lastActiveAt: new Date().toISOString(),
      userName: req.user.name, userEmail: req.user.email, coachingName: req.user.coachingName, batch: req.user.batch,
    });
    res.json({ saved:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;

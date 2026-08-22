const express = require('express');
const router  = express.Router();
const Test    = require('../models/Test');
const Result  = require('../models/Result');
const AdImage = require('../models/AdImage'); // lives on MONGODB_URI2 — see AdImage.js
const { authenticateStudent } = require('../middleware/auth');

// Dashboard/list view — lightweight metadata only. Does NOT select `questions`
// (full question bank + base64 images, ~2MB/test): the full test is only ever
// needed when a student actually opens it (GET /:id below). questionCount
// (maintained on the Test model) replaces the old `questions.length` usage.
router.get('/', authenticateStudent, async (req, res) => {
  try {
    const tests = await Test.find({ isPublished:true, isActive:true })
      .select('title subject topic description duration totalMarks questionCount attemptCount startTime endTime adEnabled adImages targetBatches')
      .sort({ createdAt:-1 })
      .lean();
    const userResults = await Result.find({ userId:req.user._id }).select('testId obtainedMarks rank batchRank inProgress').lean();
    const map = {};
    userResults.forEach(r => { map[r.testId.toString()] = r; });
    res.json(tests.map(t => ({ ...t, attempted:!!map[t._id.toString()]&&!map[t._id.toString()].inProgress, inProgress:!!map[t._id.toString()]&&!!map[t._id.toString()].inProgress, myResult:map[t._id.toString()]?{ obtainedMarks:map[t._id.toString()].obtainedMarks, rank:map[t._id.toString()].rank, batchRank:map[t._id.toString()].batchRank }:null })));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// Full test detail — the ONLY route that legitimately needs full questions +
// images, because the student is about to take the exam. Unchanged in shape.
router.get('/:id', authenticateStudent, async (req, res) => {
  try {
    const test = await Test.findOne({ _id:req.params.id, isPublished:true, isActive:true }).lean();
    if (!test) return res.status(404).json({ error:'Test not found' });
    const existing = await Result.findOne({ userId:req.user._id, testId:test._id }).lean();
    if (existing&&!existing.inProgress) return res.status(400).json({ error:'Already submitted', resultId:existing._id });
    test.questions = test.questions.map(q => ({ ...q, options:q.options.map(o => ({ _id:o._id, text:o.text, imageData:o.imageData||'' })), isMultiChoice:q.isMultiChoice||false }));
    let resumeData = null;
    if (existing&&existing.inProgress) resumeData = { savedAnswers:existing.savedAnswers||{}, violations:existing.violations||0 };
    res.json({ ...test, resumeData });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.get('/:id/ad', authenticateStudent, async (req, res) => {
  try {
    const test = await Test.findById(req.params.id).select('adEnabled adImages adRedirectUrl adHtml').lean();
    if (!test||!test.adEnabled||!test.adImages||!test.adImages.length) return res.json({ adEnabled:false, images:[] });
    // AdImage now lives on the MONGODB_URI2 connection (see models/AdImage.js)
    // — Mongoose's automatic ref-populate only resolves models registered on
    // the SAME connection as the parent document, so this has to be a
    // separate explicit query instead of .populate('adImages', ...).
    const images = await AdImage.find({ _id:{ $in:test.adImages } }).select('imageData redirectUrl title description').lean();
    res.json({ adEnabled:true, images, adRedirectUrl:test.adRedirectUrl||'', adHtml:test.adHtml||'' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

router.post('/:id/save-progress', authenticateStudent, async (req, res) => {
  try {
    const { savedAnswers, violations } = req.body;
    await Result.findOneAndUpdate({ userId:req.user._id, testId:req.params.id }, { $set:{ savedAnswers:savedAnswers||{}, violations:violations||0, lastActiveAt:new Date(), inProgress:true } }, { upsert:true, new:true });
    res.json({ saved:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;

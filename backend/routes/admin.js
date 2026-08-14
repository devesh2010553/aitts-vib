const express     = require('express');
const router      = express.Router();
const multer      = require('multer');
const mongoose    = require('mongoose');
const Test        = require('../models/Test');
const UserProfile = require('../models/UserProfile');
const Result      = require('../models/Result');
const AdImage     = require('../models/AdImage');
const admin       = require('../utils/firebaseAdmin');
const { authenticateAdmin } = require('../middleware/auth');

// Stats — public, no auth needed (used on home page for counters)
router.get('/stats', async (req, res) => {
  try {
    const [totalTests, totalStudents, totalAttempts] = await Promise.all([
      Test.countDocuments(), UserProfile.countDocuments(),
      Result.countDocuments({ inProgress: false })
    ]);
    let storageInfo = null;
    try {
      const s = await mongoose.connection.db.stats();
      const used = Math.round(s.dataSize/1024/1024*10)/10;
      storageInfo = { usedMB: used, totalMB: 512, usedPct: Math.round(used/512*100), freesMB: Math.round((512-used)*10)/10 };
    } catch(e) {}
    let sheetStats = null;
    try { sheetStats = await require('../utils/sheets').getSheetStats(); } catch(e) {}
    res.json({ totalTests, totalStudents, totalAttempts, storageInfo, sheetStats });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.use(authenticateAdmin);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// Tests CRUD
router.get('/tests', async (req, res) => {
  try { res.json(await Test.find().sort({ createdAt: -1 })); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/tests', async (req, res) => {
  try { res.status(201).json({ message: 'Test created', test: await new Test(req.body).save() }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/tests/:id', async (req, res) => {
  try {
    const test = await Test.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!test) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated', test });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.patch('/tests/:id/publish', async (req, res) => {
  try {
    const test = await Test.findById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Not found' });
    test.isPublished = !test.isPublished;
    await test.save();
    res.json({ isPublished: test.isPublished });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tests/:id', async (req, res) => {
  try {
    await Promise.all([Test.findByIdAndDelete(req.params.id), Result.deleteMany({ testId: req.params.id })]);
    res.json({ message: 'Test and all results deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Bonus marks: whole-test (applies to every student who attempted it) ───
// Stores the currently-applied amount on the Test doc and $inc's every
// Result by the delta, so re-applying with a new value only shifts marks by
// the difference (safe to call repeatedly / edit the value later).
router.post('/tests/:id/bonus', async (req, res) => {
  try {
    const bonusMarks = Number(req.body.bonusMarks);
    if (!Number.isFinite(bonusMarks)) return res.status(400).json({ error: 'bonusMarks must be a number' });
    const test = await Test.findById(req.params.id);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const delta = bonusMarks - (test.bonusMarks || 0);
    if (delta !== 0) {
      await Result.updateMany(
        { testId: test._id, inProgress: false },
        { $inc: { obtainedMarks: delta, testBonusApplied: delta } }
      );
    }
    test.bonusMarks = bonusMarks;
    await test.save();
    res.json({ message: 'Bonus marks applied to all students who took this test', bonusMarks });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Bonus marks: single student on a single test ───────────────────────────
router.post('/results/:id/bonus', async (req, res) => {
  try {
    const bonusMarks = Number(req.body.bonusMarks);
    if (!Number.isFinite(bonusMarks)) return res.status(400).json({ error: 'bonusMarks must be a number' });
    const result = await Result.findById(req.params.id);
    if (!result) return res.status(404).json({ error: 'Result not found' });
    const delta = bonusMarks - (result.bonusMarks || 0);
    result.obtainedMarks += delta;
    result.bonusMarks = bonusMarks;
    await result.save();
    res.json({ message: 'Bonus marks applied to this student for this test', bonusMarks, obtainedMarks: result.obtainedMarks });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete results for a test by batch
// DELETE results from MongoDB + archive Sheet rows to AIITS_Archive
// Frees both MongoDB space AND Sheet row limit. Data preserved in Archive sheet.
router.delete('/tests/:id/results-only', async (req, res) => {
  try {
    const testId = req.params.id;
    const batch  = req.query.batch || 'all';
    const filter = { testId, inProgress: false };
    if (batch && batch !== 'all') filter.batch = batch;

    // 1. Archive Sheet rows for this test → AIITS_Archive, then remove from main sheet
    let archived = 0;
    try {
      const { archiveTestResults } = require('../utils/sheets');
      const r = await archiveTestResults(testId, batch);
      archived = r.archived;
    } catch(e) {
      console.error('[ADMIN] Sheet archive error (non-fatal):', e.message);
    }

    // 2. Delete from MongoDB
    const affected = await Result.find(filter).select('userId obtainedMarks');
    const userIds  = [...new Set(affected.map(r => String(r.userId)))];
    const del      = await Result.deleteMany(filter);

    // 3. Recalculate UserProfile stats
    for (const uid of userIds) {
      const rem = await Result.find({ userId: uid, inProgress: false });
      await UserProfile.findByIdAndUpdate(uid, {
        totalTests:   rem.length,
        totalMarks:   rem.reduce((s,r) => s+(r.obtainedMarks||0), 0),
        highestMarks: rem.length ? Math.max(...rem.map(r=>r.obtainedMarks||0)) : 0
      });
    }

    res.json({
      deleted: del.deletedCount,
      archived,
      message: del.deletedCount + ' results removed from MongoDB. ' + archived + ' rows moved to Archive sheet.'
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET leaderboard from AIITS_Archive sheet (used after results cleared from MongoDB)
router.get('/tests/:id/sheet-leaderboard', async (req, res) => {
  try {
    const batch = req.query.batch || 'all';
    const { readArchivedResults } = require('../utils/sheets');
    const rows = await readArchivedResults(req.params.id, batch);
    if (!rows.length) return res.json([]);

    const sorted = rows.sort((a,b) => b.obtainedMarks - a.obtainedMarks || a.timeTaken - b.timeTaken);
    const bMap = {'11':'Class 11','12':'Class 12','dropper':'Dropper'};
    res.json(sorted.map((r,i) => ({
      ...r,
      rank: i+1,
      batchLabel: bMap[r.batch] || r.batch,
      percentage: r.totalMarks ? (r.obtainedMarks/r.totalMarks*100).toFixed(1) : r.percentage.toFixed(1)
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tests/:id/results', async (req, res) => {
  try {
    const testId = req.params.id;
    const batch  = req.query.batch || 'all';
    const filter = { testId, inProgress: false };
    if (batch && batch !== 'all') filter.batch = batch;

    // 1. Archive Sheet rows to AIITS_Archive AND remove from main sheet
    let archived = 0;
    try {
      const { archiveTestResults } = require('../utils/sheets');
      const r = await archiveTestResults(testId, batch);
      archived = r.archived;
    } catch(e) {
      console.error('[ADMIN] Sheet archive error (non-fatal):', e.message);
    }

    // 2. Delete from MongoDB
    const affected = await Result.find(filter).select('userId obtainedMarks');
    const userIds  = [...new Set(affected.map(r => String(r.userId)))];
    const del      = await Result.deleteMany(filter);

    for (const uid of userIds) {
      const rem = await Result.find({ userId: uid, inProgress: false });
      await UserProfile.findByIdAndUpdate(uid, {
        totalTests:   rem.length,
        totalMarks:   rem.reduce((s,r) => s+(r.obtainedMarks||0), 0),
        highestMarks: rem.length ? Math.max(...rem.map(r=>r.obtainedMarks||0)) : 0
      });
    }
    await Test.findByIdAndUpdate(testId, { attemptCount: await Result.countDocuments({ testId, inProgress: false }) });

    res.json({ deleted: del.deletedCount, archived, message: del.deletedCount + ' results deleted from MongoDB. ' + archived + ' rows archived to AIITS_Archive sheet.' });
  } catch(err) {
    console.error('[ADMIN] delete results:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/tests/:id/results', async (req, res) => {
  try {
    res.json(await Result.find({ testId: req.params.id, inProgress: false })
      .populate('userId','name phone coachingName batch')
      .sort({ obtainedMarks: -1, timeTaken: 1 }));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Students
router.get('/students', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit)||2000;
    const [students, total] = await Promise.all([
      UserProfile.find().sort({ createdAt: -1 }).limit(limit),
      UserProfile.countDocuments()
    ]);
    // Fetch emails from Firebase in batch (up to 100 at a time)
    const studentsWithEmail = await Promise.all(students.map(async (s) => {
      try {
        const fbUser = await admin.auth().getUser(s.uid);
        return { ...s.toObject(), email: fbUser.email };
      } catch {
        return { ...s.toObject(), email: '' };
      }
    }));
    res.json({ students: studentsWithEmail, total });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete specific student
router.delete('/students/:id', async (req, res) => {
  try {
    const profile = await UserProfile.findById(req.params.id);
    await Promise.all([
      UserProfile.findByIdAndDelete(req.params.id),
      Result.deleteMany({ userId: req.params.id }),
      profile ? admin.auth().deleteUser(profile.uid).catch(() => {}) : Promise.resolve()
    ]);
    res.json({ message: 'Student and their results deleted' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Delete entire batch
router.delete('/students/batch/:batch', async (req, res) => {
  try {
    const batch = req.params.batch;
    if (!['11','12','dropper'].includes(batch)) return res.status(400).json({ error: 'Invalid batch' });
    const profiles = await UserProfile.find({ batch }).select('_id uid');
    const userIds  = profiles.map(u => u._id);

    const [uDel, rDel] = await Promise.all([
      UserProfile.deleteMany({ batch }),
      Result.deleteMany({ userId: { $in: userIds } })
    ]);

    // Delete from Firebase (best-effort)
    await Promise.all(profiles.map(p => admin.auth().deleteUser(p.uid).catch(() => {})));

    res.json({ deletedStudents: uDel.deletedCount, deletedResults: rDel.deletedCount });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Ad Images
router.get('/ad-images', async (req, res) => {
  try { res.json(await AdImage.find().sort({ createdAt: -1 })); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/ad-images', upload.single('image'), async (req, res) => {
  try {
    const imageData = req.file ? 'data:'+req.file.mimetype+';base64,'+req.file.buffer.toString('base64') : '';
    const img = await AdImage.create({
      title: req.body.title||'', description: req.body.description||'',
      imageData, redirectUrl: req.body.redirectUrl||'',
      showOnHome: req.body.showOnHome !== 'false'
    });
    res.status(201).json({ message: 'Uploaded', image: { _id: img._id, title: img.title, redirectUrl: img.redirectUrl, showOnHome: img.showOnHome } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.put('/ad-images/:id', async (req, res) => {
  try {
    const img = await AdImage.findByIdAndUpdate(req.params.id, {
      title: req.body.title||'', description: req.body.description||'',
      redirectUrl: req.body.redirectUrl||'',
      showOnHome: req.body.showOnHome !== false && req.body.showOnHome !== 'false'
    }, { new: true });
    if (!img) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Updated', image: img });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.delete('/ad-images/:id', async (req, res) => {
  try { await AdImage.findByIdAndDelete(req.params.id); res.json({ message: 'Deleted' }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

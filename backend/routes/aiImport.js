/**
 * routes/aiImport.js — "AI PDF Test Import" (spec #1-55).
 * Admin/teacher only. Mounted at /api/admin/ai in server.js.
 *
 * Flow: upload -> background job (importQueue.js) -> poll status -> teacher
 * reviews the structured result -> create-draft maps it into a normal Test
 * document (isPublished:false) -> teacher opens it in the EXISTING test
 * editor to fine-tune/publish. No parallel editor, no parallel publish path.
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const crypto  = require('crypto');
const PdfImportJob = require('../models/PdfImportJob');
const Test = require('../dynamo/testModel'); // was: const Test = require('../models/Test') — Test now lives on DynamoDB, not MongoDB
const { authenticateAdmin } = require('../middleware/auth');
const { extractPdf, sha256 } = require('../utils/pdfExtract');
const aiProvider = require('../utils/aiProvider');
const { enqueueImportJob, mapJobQuestionsToTestQuestions, getJobPdfBuffer } = require('../utils/importQueue');
const { uploadRawBuffer, uploadImageBase64, uploadTestImages, signedRawUrl } = require('../utils/cloudinary');

router.use(authenticateAdmin); // spec #38 — only authenticated admins/teachers, never students

// PDFs are naturally larger than the admin image-upload limit (8MB, see
// admin.js) but still bounded — 25MB comfortably covers a multi-page scanned
// question paper while keeping the resulting base64-in-Mongo job document
// (see PdfImportJob.js) well under MongoDB's 16MB document cap once
// extracted assets are added on top.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are accepted'));
    cb(null, true);
  },
});

// ── 1. Upload — creates a job, kicks off async processing, returns immediately (spec #36) ──
router.post('/import-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
    if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'AI PDF import is not configured on this server (set GROQ_API_KEY or GEMINI_API_KEY).' });
    }

    const hash = sha256(req.file.buffer);
    const existing = await PdfImportJob.findOne({ fileHash: hash }).select('_id fileName status createdTestId createdAt').lean();
    if (existing && req.query.force !== 'true') {
      // spec #44 — warn, don't block; teacher can force a re-import if intentional.
      return res.status(409).json({
        error: 'This PDF appears to have already been imported.',
        existingJobId: existing._id, existingFileName: existing.fileName,
        existingStatus: existing.status, existingTestId: existing.createdTestId, importedAt: existing.createdAt,
      });
    }

    // Store the original in Cloudinary (raw resource) and keep only the URL in
    // Mongo. uploadRawBuffer returns null when Cloudinary isn't configured, in
    // which case we fall back to the old inline-base64 path rather than
    // rejecting the upload.
    const stored = await uploadRawBuffer(req.file.buffer, req.file.originalname, 'aiits/imports/pdf');

    const job = await PdfImportJob.create({
      status: 'queued', stage: 'Queued',
      fileName: req.file.originalname, fileHash: hash,
      pdfUrl: (stored && stored.url) || '',
      pdfPublicId: (stored && stored.publicId) || '',
      pdfBase64: stored ? '' : req.file.buffer.toString('base64'),
      createdBy: (req.admin && req.admin.email) || '',
    });

    // The queue is in-process, so hand the buffer we already have straight to
    // the worker. The initial import then never round-trips to Cloudinary at
    // all — only the later reprocess/image-replace routes need to re-fetch.
    enqueueImportJob(job._id, req.file.buffer); // not awaited — processing happens in the background, request returns now
    res.status(202).json({ jobId: job._id, status: 'queued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 2. Lightweight poll — status/stage/counts only, no PDF/question payload (spec #37, #41) ──
router.get('/import-status/:jobId', async (req, res) => {
  try {
    const job = await PdfImportJob.findById(req.params.jobId)
      .select('status stage error pageCount questionsDetected totalQuestionsGuess imagesDetected tablesDetected createdTestId fileName')
      .lean();
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    res.json(job);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3. Full structured result — for the teacher review screen ──
router.get('/import/:jobId', async (req, res) => {
  try {
    // pdfBase64 excluded here on purpose (can be multi-MB) — fetched
    // separately via /import/:jobId/pdf only when the teacher actually opens
    // the side-by-side reference.
    const job = await PdfImportJob.findById(req.params.jobId).select('-pdfBase64').lean();
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    res.json(job);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 3b. Original PDF — for side-by-side reference (spec #25, #26) ──
router.get('/import/:jobId/pdf', async (req, res) => {
  try {
    const job = await PdfImportJob.findById(req.params.jobId).select('pdfUrl pdfPublicId pdfBase64 fileName').lean();
    if (!job) return res.status(404).json({ error: 'Not found' });
    // Cloudinary-hosted: redirect so the bytes never pass through this server.
    // Sign the URL when we have the public_id, so the teacher's browser isn't
    // refused by the account's PDF/raw delivery restriction either.
    if (job.pdfUrl) {
      return res.redirect(job.pdfPublicId ? signedRawUrl(job.pdfPublicId) : job.pdfUrl);
    }
    if (!job.pdfBase64) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(job.fileName || 'document.pdf').replace(/"/g, '')}"`);
    res.send(Buffer.from(job.pdfBase64, 'base64'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 4. Reprocess a single question's page range (spec #27) — not the whole document ──
router.post('/import/:jobId/reprocess-question/:index', async (req, res) => {
  try {
    const job = await PdfImportJob.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    const i = parseInt(req.params.index, 10);
    const q = job.questions[i];
    if (!q) return res.status(404).json({ error: 'Question not found in this job' });

    const pdfBuffer = await getJobPdfBuffer(job);
    const extraction = await extractPdf(pdfBuffer);
    const pageStart = q.pageStart || 1, pageEnd = q.pageEnd || pageStart;
    const pageNumbers = [];
    for (let p = pageStart; p <= pageEnd; p++) pageNumbers.push(p);

    const result = await aiProvider.analyzeRegion({
      pageNumbers, pageCount: extraction.pageCount,
      textByPage: extraction.textByPage, pageImages: extraction.pageImages, embeddedImages: extraction.embeddedImages,
      scannedPages: extraction.scannedPages,
      forceImages: true, // a single-question reprocess is small enough (1-2 pages) to afford always sending the image, and the whole point is getting a better look at it
    });

    // Prefer the question matching the same original number if present in
    // the re-analysis; otherwise fall back to the first result for that region.
    const rebuilt = result.questions.find(r => r.number === q.number) || result.questions[0];
    if (!rebuilt) return res.status(422).json({ error: 'Reprocessing did not detect a question in this page range' });

    job.questions[i] = {
      number: rebuilt.number ?? q.number, pageStart: q.pageStart, pageEnd: q.pageEnd,
      questionText: rebuilt.questionText || '',
      questionImage: q.questionImage, // asset re-resolution kept out of scope for a single-question reprocess; teacher can still use manual image replace (spec #28)
      options: (rebuilt.options || []).map(o => ({ label: o.label || '', text: o.text || '', imageData: '', isCorrect: false })),
      questionType: rebuilt.questionType || q.questionType,
      isMultiChoice: !!rebuilt.isMultiChoice,
      marks: typeof rebuilt.marks === 'number' ? rebuilt.marks : q.marks,
      negativeMarks: typeof rebuilt.negativeMarks === 'number' ? rebuilt.negativeMarks : q.negativeMarks,
      answerDetected: false,
      confidence: rebuilt.confidence || 'review',
      flags: rebuilt.flags || [],
    };
    await job.save();
    res.json({ question: job.questions[i] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 5. Manual image replace on a draft question (spec #28) ──
router.put('/import/:jobId/questions/:index/image', async (req, res) => {
  try {
    const { embeddedImageIndex } = req.body; // teacher picks one of the extracted assets shown in the review UI
    const job = await PdfImportJob.findById(req.params.jobId);
    if (!job || !job.questions[req.params.index]) return res.status(404).json({ error: 'Not found' });

    const pdfBuffer = await getJobPdfBuffer(job);
    const extraction = await extractPdf(pdfBuffer);
    const found = extraction.embeddedImages.find(i => i.index === embeddedImageIndex);
    if (!found) return res.status(404).json({ error: 'Image index not found in this document' });

    // Same treatment as the automatic path — the replacement goes to Cloudinary,
    // not into the job document as base64.
    job.questions[req.params.index].questionImage = await uploadImageBase64(found.base64, 'aiits/imports/questions');
    await job.save();
    res.json({ message: 'Image updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── 6. Create the draft Test — from here on it's a normal AIITS test (spec #21, #47, #48) ──
router.post('/import/:jobId/create-draft', async (req, res) => {
  try {
    const job = await PdfImportJob.findById(req.params.jobId).select('-pdfBase64');
    if (!job) return res.status(404).json({ error: 'Import job not found' });
    if (job.status !== 'done') return res.status(400).json({ error: `Import is still ${job.status} — wait for it to finish before creating a draft` });
    if (job.createdTestId) return res.status(200).json({ testId: job.createdTestId, message: 'Draft already created for this import' });

    const meta = req.body || {}; // optional teacher-supplied metadata (spec #33) — title/subject/topic/duration/batches
    // Safety net: anything still inline (legacy job, or Cloudinary was down
    // mid-import) gets uploaded here so no base64 ever lands in DynamoDB.
    const questions = await uploadTestImages(mapJobQuestionsToTestQuestions(job.questions));

    const test = await Test.create({
      title: meta.title || job.fileName || 'AI Imported Test',
      subject: meta.subject || 'General',
      topic: meta.topic || 'Imported',
      description: meta.description || `Imported from ${job.fileName}`,
      duration: meta.duration || 60,
      questions,
      isPublished: false, // spec #23, #48 — never auto-published
      targetBatches: Array.isArray(meta.targetBatches) ? meta.targetBatches : [],
    });

    job.createdTestId = test.testId;
    await job.save();
    res.status(201).json({ testId: test.testId, questionCount: test.questionCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
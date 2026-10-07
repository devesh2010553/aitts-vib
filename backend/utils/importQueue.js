/**
 * In-process import job processor. Deliberately NOT Redis/BullMQ/a separate
 * worker service (spec #36) — a single admin uploading occasional PDFs
 * doesn't need more than that.
 *
 * Concurrency is capped at 1 PDF at a time on purpose: PDF import is
 * I/O-bound (subprocess-free now, but still image-heavy AI calls +
 * multi-MB payloads), and serializing it keeps memory/API-cost usage
 * predictable and fully decoupled from student-facing request handling
 * (spec #35) — nothing here ever runs inside a student request's call stack.
 */
const PdfImportJob = require('../models/PdfImportJob');
const { extractPdf, extractFromImages } = require('./pdfExtract');
const aiProvider = require('./aiProvider');
const sharp = require('sharp');
const { uploadImageBase64, fetchRawBuffer, fetchImageBuffer } = require('./cloudinary');

/**
 * Single read path for a job's original PDF. Prefers the Cloudinary raw URL
 * and only falls back to the legacy inline base64 (jobs created before the
 * Cloudinary switch, or a server with no Cloudinary credentials).
 */
async function getJobPdfBuffer(job) {
  if (job.pdfUrl) return fetchRawBuffer(job.pdfUrl, job.pdfPublicId);
  if (job.pdfBase64) return Buffer.from(job.pdfBase64, 'base64');
  throw new Error('This import job has no stored PDF');
}

/** Same idea as getJobPdfBuffer(), for a sourceType:'images' job — fetches
 *  (or decodes from the base64 fallback) every stored source photo, in
 *  page order. */
async function getJobImageBuffers(job) {
  const buffers = [];
  for (const img of (job.sourceImages || [])) {
    if (img.url) buffers.push(await fetchImageBuffer(img.url));
    else if (img.base64) buffers.push(Buffer.from(img.base64, 'base64'));
  }
  if (!buffers.length) throw new Error('This import job has no stored images');
  return buffers;
}

/**
 * One entry point for "get this job's extraction," regardless of whether it
 * came from a PDF or a set of photos — everything past this point (batching,
 * AI calls, asset resolution) is identical either way.
 * `providedSource` lets the upload route hand over buffers it already has
 * in memory (a single Buffer for a PDF, an array of Buffers for images) so
 * the very first processing pass never has to re-download its own upload;
 * every later call (reprocess, image-replace) omits it and re-fetches from
 * Cloudinary instead.
 */
async function getJobExtraction(job, providedSource) {
  if (job.sourceType === 'images') {
    const buffers = providedSource || await getJobImageBuffers(job);
    return extractFromImages(buffers);
  }
  const pdfBuffer = (providedSource && !Array.isArray(providedSource)) ? providedSource : await getJobPdfBuffer(job);
  return extractPdf(pdfBuffer);
}

const PAGES_PER_BATCH = parseInt(process.env.AI_IMPORT_PAGES_PER_BATCH) || 1;
// Small gap between successive Groq calls so a multi-page import doesn't
// front-load requests into the same minute and trip the free-tier
// per-minute rate limit before it even has a chance to retry (aiProvider.js
// retries reactively; this is the proactive half of the same fix).
const BATCH_DELAY_MS = parseInt(process.env.AI_IMPORT_BATCH_DELAY_MS) || 1500;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const queue = [];
let draining = false;

// One AbortController per currently-running job, so "Cancel" can stop the
// in-flight AI request immediately rather than waiting for the current page
// to finish. cancelledJobs is checked between pages too, for the (much more
// common) case where cancel lands while nothing is in-flight yet — e.g.
// during the pacing delay between batches.
const activeControllers = new Map(); // String(jobId) -> AbortController
const cancelledJobs = new Set();     // String(jobId)

/** Called from the /cancel route. Marks the job cancelled and aborts
 *  whatever request is currently in flight for it, if any. Returns false
 *  if the job isn't actually running (already finished, or never started —
 *  the route treats that as "nothing to cancel" rather than an error). */
function cancelImportJob(jobId) {
  const key = String(jobId);
  if (!activeControllers.has(key) && !queue.some(q => String(q.jobId) === key)) return false;
  cancelledJobs.add(key);
  const controller = activeControllers.get(key);
  if (controller) controller.abort();
  return true;
}

function enqueueImportJob(jobId, providedSource) {
  // providedSource is optional — when the upload route hands it over we
  // process straight from memory instead of re-downloading our own upload.
  // A single Buffer for a PDF job, an array of Buffers for an images job.
  queue.push({ jobId, providedSource });
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const { jobId, providedSource } = queue.shift();
    const key = String(jobId);
    if (cancelledJobs.has(key)) {
      // Cancelled while still waiting in the queue, never actually started —
      // still mark it so the poll endpoint reflects it correctly.
      cancelledJobs.delete(key);
      await PdfImportJob.findByIdAndUpdate(jobId, { status: 'cancelled', stage: 'Cancelled' }).catch(() => {});
      continue;
    }
    try { await processJob(jobId, providedSource); }
    catch (e) { console.error('[AI-IMPORT] Unhandled error processing job', jobId, ':', e.message); }
  }
  draining = false;
}

async function setStage(job, stage, extra = {}) {
  job.stage = stage;
  Object.assign(job, extra);
  await job.save().catch(e => console.error('[AI-IMPORT] Failed to save progress:', e.message));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Crop a rendered page image to a normalized [x0,y0,x1,y1] bounding box —
 *  the fallback path for diagrams that are vector-drawn (not an embedded
 *  raster the AI could reference by index) but visible on the page image. */
async function cropRegion(pageImageBase64, box) {
  try {
    const buf = Buffer.from(pageImageBase64, 'base64');
    const img = sharp(buf);
    const meta = await img.metadata();
    const [x0, y0, x1, y1] = box;
    const left = Math.max(0, Math.round(x0 * meta.width));
    const top = Math.max(0, Math.round(y0 * meta.height));
    const width = Math.max(1, Math.min(meta.width - left, Math.round((x1 - x0) * meta.width)));
    const height = Math.max(1, Math.min(meta.height - top, Math.round((y1 - y0) * meta.height)));
    const cropped = await img.extract({ left, top, width, height }).png().toBuffer();
    return cropped.toString('base64');
  } catch (e) {
    console.error('[AI-IMPORT] Region crop failed:', e.message);
    return null;
  }
}

/** Resolves ONE asset ref (from the AI response) into base64 image data —
 *  an embedded-image ref splices bytes already extracted locally, a region
 *  ref crops the page render via sharp. Returns '' if it can't be resolved. */
async function resolveOneAsset(asset, extraction) {
  if (!asset) return '';
  if (asset.type === 'embedded' && typeof asset.imageIndex === 'number') {
    const found = extraction.embeddedImages.find(i => i.index === asset.imageIndex);
    if (found) return found.base64;
  }
  if (asset.type === 'region' && Array.isArray(asset.box) && extraction.pageImages[asset.page]) {
    const normalizedBox = aiProvider.normalizeAndPadBox(asset.box);
    if (!normalizedBox) return '';
    const cropped = await cropRegion(extraction.pageImages[asset.page], normalizedBox);
    if (cropped) return cropped;
  }
  return '';
}

/** Resolve a question's `assets` refs AND each option's own `asset` (added
 *  so option-only diagrams — "which of these figures..." questions — get
 *  uploaded too; previously only the question-level asset was ever wired
 *  up and option images silently never made it into the draft). Uploads
 *  each resolved image to Cloudinary immediately so raw base64 never sits
 *  in the job document. */
async function resolveAssets(q, extraction) {
  let questionImage = '';
  for (const asset of (q.assets || [])) {
    const resolved = await resolveOneAsset(asset, extraction);
    if (resolved) { questionImage = resolved; break; } // first resolvable asset wins — the schema expects at most one diagram per question stem
  }
  questionImage = await uploadImageBase64(questionImage, 'aiits/imports/questions');

  const optionImageByLabel = {};
  for (const o of (q.options || [])) {
    if (!o.asset || !o.label) continue;
    const resolved = await resolveOneAsset(o.asset, extraction);
    if (resolved) optionImageByLabel[String(o.label).toUpperCase()] = await uploadImageBase64(resolved, 'aiits/imports/options');
  }

  return { questionImage, optionImageByLabel };
}

function mapToDraftQuestion(q, questionImage, optionImageByLabel) {
  const options = (q.options || []).map(o => ({
    label: o.label || '', text: o.text || '',
    imageData: (optionImageByLabel && optionImageByLabel[String(o.label || '').toUpperCase()]) || '',
    isCorrect: false,
  }));
  const flags = Array.isArray(q.flags) ? q.flags.slice(0, 10) : [];
  let confidence = ['high', 'review', 'low'].includes(q.confidence) ? q.confidence : 'review';
  if (q.marks == null) flags.push('Marks not detected in PDF — confirm before publishing');
  if (!options.length && ['mcq', 'multi'].includes(q.questionType)) { flags.push('No options detected'); confidence = 'review'; }
  if (flags.length && confidence === 'high') confidence = 'review';

  return {
    number: typeof q.number === 'number' ? q.number : null,
    pageStart: q.pageStart, pageEnd: q.pageEnd,
    questionText: q.questionText || '',
    questionImage: questionImage || '',
    options,
    questionType: q.questionType || 'mcq',
    isMultiChoice: !!q.isMultiChoice,
    marks: typeof q.marks === 'number' ? q.marks : null,
    negativeMarks: typeof q.negativeMarks === 'number' ? q.negativeMarks : null,
    answerDetected: false,
    confidence,
    flags,
  };
}

/** Applies a detected answer key onto the matching questions by number —
 *  spec #30: answers are only ever set from an explicit answer key in the
 *  document, never guessed by the model as part of writing the question. */
function applyAnswerKey(questions, answerKey) {
  for (const entry of (answerKey || [])) {
    const q = questions.find(qq => qq.number === entry.number);
    if (!q) continue;
    const opt = q.options.find(o => (o.label || '').toUpperCase() === String(entry.correctLabel).toUpperCase());
    if (opt) { opt.isCorrect = true; q.answerDetected = true; }
  }
}

async function processJob(jobId, providedSource) {
  const job = await PdfImportJob.findById(jobId);
  if (!job) return;
  const key = String(jobId);

  try {
    await setStage(job, job.sourceType === 'images' ? 'Reading images...' : 'Reading PDF...', { status: 'processing' });
    const extraction = await getJobExtraction(job, providedSource);

    await setStage(job, 'Extracting images and layout...', {
      pageCount: extraction.pageCount,
      imagesDetected: extraction.embeddedImages.length,
      tablesDetected: extraction.tableCount || 0,
      totalQuestionsGuess: Math.max(1, Math.round(extraction.pageCount * 1.5)), // rough estimate only — never shown as a fake precise percentage
    });

    const allPageNumbers = Array.from({ length: extraction.pageCount }, (_, i) => i + 1);
    const batches = chunk(allPageNumbers, PAGES_PER_BATCH);

    let allQuestions = [];
    let allAnswerKey = [];

    for (let bi = 0; bi < batches.length; bi++) {
      if (cancelledJobs.has(key)) { await markCancelled(job, key); return; }

      const batchPages = batches[bi];
      await setStage(job, `Detecting questions... pages ${batchPages[0]}-${batchPages[batchPages.length-1]} of ${extraction.pageCount}`);

      const controller = new AbortController();
      activeControllers.set(key, controller);

      let result;
      try {
        result = await aiProvider.analyzeBatch({
          pageNumbers: batchPages, pageCount: extraction.pageCount,
          textByPage: extraction.textByPage, pageImages: extraction.pageImages, embeddedImages: extraction.embeddedImages,
          scannedPages: extraction.scannedPages,
          signal: controller.signal,
        });
      } catch (e) {
        if (e.name === 'AbortError' || cancelledJobs.has(key)) { await markCancelled(job, key); return; }
        if (e.quotaExhausted) {
          // Every configured Gemini key is exhausted — every remaining page
          // would hit the exact same wall. Stop here with a clear message
          // instead of grinding through each remaining page's own retry
          // budget for nothing; whatever was already detected is kept
          // (same "partial results" UX as a manual cancel, see markCancelled).
          console.error('[AI-IMPORT] Job', jobId, 'stopped —', e.message);
          job.error = e.message;
          job.questions = allQuestions;
          job.questionsDetected = allQuestions.length;
          await markCancelled(job, key);
          return;
        }
        // One bad batch shouldn't fail the whole document — flag and continue,
        // teacher reviews/reprocesses just that page range (spec #27, #42).
        console.error('[AI-IMPORT] Batch failed:', e.message);
        allQuestions.push({
          number: null, pageStart: batchPages[0], pageEnd: batchPages[batchPages.length - 1],
          questionText: '', options: [], questionType: 'other', isMultiChoice: false,
          marks: null, negativeMarks: null, answerDetected: false,
          confidence: 'low', flags: [`AI processing failed for pages ${batchPages.join('-')}: ${e.message}`],
        });
        continue;
      } finally {
        activeControllers.delete(key);
      }

      for (const q of result.questions) {
        const { questionImage, optionImageByLabel } = await resolveAssets(q, extraction);
        allQuestions.push(mapToDraftQuestion(q, questionImage, optionImageByLabel));
      }
      allAnswerKey = allAnswerKey.concat(result.answerKey);

      // Incremental progress — the whole point of async processing is a
      // teacher can watch real progress rather than stare at a spinner (#37).
      await setStage(job, job.stage, { questionsDetected: allQuestions.length, 'questions': allQuestions });

      if (bi < batches.length - 1 && BATCH_DELAY_MS > 0) await sleep(BATCH_DELAY_MS);
      if (cancelledJobs.has(key)) { await markCancelled(job, key); return; }
    }

    applyAnswerKey(allQuestions, allAnswerKey);

    await setStage(job, 'Validating...', { questions: allQuestions, questionsDetected: allQuestions.length });
    await setStage(job, 'Done', { status: 'done' });
  } catch (err) {
    if (err.name === 'AbortError' || cancelledJobs.has(key)) { await markCancelled(job, key); return; }
    console.error('[AI-IMPORT] Job', jobId, 'failed:', err);
    job.status = 'failed';
    job.stage = 'Failed';
    job.error = err.message || 'Unknown error';
    await job.save().catch(() => {});
  } finally {
    activeControllers.delete(key);
    cancelledJobs.delete(key);
  }
}

async function markCancelled(job, key) {
  cancelledJobs.delete(key);
  activeControllers.delete(key);
  job.status = 'cancelled';
  job.stage = 'Cancelled';
  await job.save().catch(() => {});
}

/** Maps a job's reviewed questions into an actual draft Test document, using
 *  the EXACT existing Test schema (backend/dynamo/testModel.js) — spec #21, #47:
 *  no parallel schema, the result is a normal draft test from here on,
 *  editable/publishable via the existing admin test editor. */
function mapJobQuestionsToTestQuestions(draftQuestions) {
  return draftQuestions
    .filter(q => q.questionText || q.options.length) // drop empty failed-batch placeholders
    .map(q => ({
      questionText: q.questionText,
      questionImage: q.questionImage,
      options: q.options.map(o => ({ text: o.text, isCorrect: o.isCorrect, imageData: o.imageData })),
      isMultiChoice: q.isMultiChoice,
      correctOptions: q.options.map((o, i) => o.isCorrect ? i : -1).filter(i => i >= 0),
      marks: typeof q.marks === 'number' ? q.marks : 4,          // existing Test schema default (see Test.js questionSchema)
      negativeMarks: typeof q.negativeMarks === 'number' ? q.negativeMarks : 1,
      explanation: '',
    }));
}

module.exports = {
  enqueueImportJob,
  cancelImportJob,
  mapJobQuestionsToTestQuestions,
  getJobPdfBuffer,
  getJobImageBuffers,
  getJobExtraction,
};

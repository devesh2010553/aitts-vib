/**
 * In-process import job processor. Deliberately NOT Redis/BullMQ/a separate
 * worker service (spec #36) — this app already has one precedent for this
 * exact pattern (utils/sheetsQueue.js's debounced write-behind queue), and a
 * single admin uploading occasional PDFs doesn't need more than that.
 *
 * Concurrency is capped at 1 PDF at a time on purpose: PDF import is
 * I/O-bound (subprocess-free now, but still image-heavy AI calls +
 * multi-MB payloads), and serializing it keeps memory/API-cost usage
 * predictable and fully decoupled from student-facing request handling
 * (spec #35) — nothing here ever runs inside a student request's call stack.
 */
const PdfImportJob = require('../models/PdfImportJob');
const Test = require('../models/Test');
const { extractPdf } = require('./pdfExtract');
const aiProvider = require('./aiProvider');
const sharp = require('sharp');

const PAGES_PER_BATCH = parseInt(process.env.AI_IMPORT_PAGES_PER_BATCH) || 1;

const queue = [];
let draining = false;

function enqueueImportJob(jobId) {
  queue.push(jobId);
  if (!draining) drain();
}

async function drain() {
  draining = true;
  while (queue.length) {
    const jobId = queue.shift();
    try { await processJob(jobId); }
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

/** Resolve a question's `assets` refs (from the AI response) into actual
 *  base64 image data — embedded-image refs splice bytes we already
 *  extracted locally; region refs crop the page render via sharp. Either
 *  way the AI itself never had to reproduce or redraw image content. */
async function resolveAssets(q, extraction) {
  let questionImage = '';
  const optionImageByLabel = {}; // not currently populated by the AI schema, reserved for a future per-option asset case
  for (const asset of (q.assets || [])) {
    if (asset.type === 'embedded' && typeof asset.imageIndex === 'number') {
      const found = extraction.embeddedImages.find(i => i.index === asset.imageIndex);
      if (found) { questionImage = found.base64; continue; }
    }
    if (asset.type === 'region' && Array.isArray(asset.box) && extraction.pageImages[asset.page]) {
      const cropped = await cropRegion(extraction.pageImages[asset.page], asset.box);
      if (cropped) { questionImage = cropped; continue; }
    }
  }
  return { questionImage, optionImageByLabel };
}

function mapToDraftQuestion(q, questionImage) {
  const options = (q.options || []).map(o => ({ label: o.label || '', text: o.text || '', imageData: '', isCorrect: false }));
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

async function processJob(jobId) {
  const job = await PdfImportJob.findById(jobId);
  if (!job) return;

  try {
    await setStage(job, 'Reading PDF...', { status: 'processing' });
    const pdfBuffer = Buffer.from(job.pdfBase64, 'base64');
    const extraction = await extractPdf(pdfBuffer);

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
      const batchPages = batches[bi];
      await setStage(job, `Detecting questions... pages ${batchPages[0]}-${batchPages[batchPages.length-1]} of ${extraction.pageCount}`);

      let result;
      try {
        result = await aiProvider.analyzeBatch({
          pageNumbers: batchPages, pageCount: extraction.pageCount,
          textByPage: extraction.textByPage, pageImages: extraction.pageImages, embeddedImages: extraction.embeddedImages,
          scannedPages: extraction.scannedPages,
        });
      } catch (e) {
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
      }

      for (const q of result.questions) {
        const { questionImage } = await resolveAssets(q, extraction);
        allQuestions.push(mapToDraftQuestion(q, questionImage));
      }
      allAnswerKey = allAnswerKey.concat(result.answerKey);

      // Incremental progress — the whole point of async processing is a
      // teacher can watch real progress rather than stare at a spinner (#37).
      await setStage(job, job.stage, { questionsDetected: allQuestions.length, 'questions': allQuestions });
    }

    applyAnswerKey(allQuestions, allAnswerKey);

    await setStage(job, 'Validating...', { questions: allQuestions, questionsDetected: allQuestions.length });
    await setStage(job, 'Done', { status: 'done' });
  } catch (err) {
    console.error('[AI-IMPORT] Job', jobId, 'failed:', err);
    job.status = 'failed';
    job.stage = 'Failed';
    job.error = err.message || 'Unknown error';
    await job.save().catch(() => {});
  }
}

/** Maps a job's reviewed questions into an actual draft Test document, using
 *  the EXACT existing Test schema (backend/models/Test.js) — spec #21, #47:
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

module.exports = { enqueueImportJob, mapJobQuestionsToTestQuestions };

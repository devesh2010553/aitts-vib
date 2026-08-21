const mongoose = require('mongoose');

// Intermediate representation for one detected question — kept separate from
// the actual Test/questionSchema (backend/models/Test.js) until the teacher
// reviews it, because it needs fields (confidence, source page range, raw
// asset refs) that have no business living in the real Test schema forever.
const draftQuestionSchema = new mongoose.Schema({
  number:        { type: Number },              // original question number from the PDF, if detected
  pageStart:     { type: Number },
  pageEnd:       { type: Number },
  questionText:  { type: String, default: '' },
  questionImage: { type: String, default: '' },  // base64, same convention as Test.questionSchema — reuses existing storage, no new asset system
  options: [{
    label:     { type: String },                  // original label as printed (A/B/1/i) — kept for teacher review, not required by Test schema
    text:      { type: String, default: '' },
    imageData: { type: String, default: '' },
    isCorrect: { type: Boolean, default: false },
  }],
  questionType:   { type: String, default: 'mcq' }, // mcq | multi | numerical | assertion-reason | true-false | subjective | other
  isMultiChoice:  { type: Boolean, default: false },
  marks:          { type: Number, default: null },  // null = not detected in PDF, teacher must confirm (see #31 — never invent marks)
  negativeMarks:  { type: Number, default: null },
  answerDetected: { type: Boolean, default: false }, // true only if an answer key entry mapped to this question
  confidence:     { type: String, enum: ['high', 'review', 'low'], default: 'high' },
  flags:          [{ type: String }],               // human-readable reasons for a non-"high" confidence, e.g. "option count uncertain"
}, { _id: false });

const pdfImportJobSchema = new mongoose.Schema({
  status: { type: String, enum: ['queued', 'processing', 'done', 'failed'], default: 'queued' },
  stage:  { type: String, default: 'Queued' }, // human-readable current stage, shown in the progress UI
  error:  { type: String, default: '' },

  fileName: { type: String, default: '' },
  fileHash: { type: String, index: true }, // sha256 — duplicate-import detection (#44)
  pageCount: { type: Number, default: 0 },
  // Original PDF, kept for teacher side-by-side reference (#25). Base64, same
  // storage convention as everything else in this app. Capped at upload time
  // (see routes/aiImport.js) to stay well under MongoDB's 16MB document limit.
  pdfBase64: { type: String, default: '' },

  questionsDetected:  { type: Number, default: 0 },
  totalQuestionsGuess:{ type: Number, default: 0 }, // rough estimate for progress display, not exact
  imagesDetected:     { type: Number, default: 0 },
  tablesDetected:      { type: Number, default: 0 },
  mathDetected:        { type: Number, default: 0 },

  questions: [draftQuestionSchema],

  createdTestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Test', default: null }, // set once the draft Test is created
  createdBy:     { type: String, default: '' }, // admin identifier, informational only

}, { timestamps: true });

// TTL: import jobs are working data, not a permanent record — once a draft
// Test exists the job itself has served its purpose. Auto-expire finished
// jobs after 14 days so this collection doesn't grow unbounded (originals
// PDFs included). Only applies to done/failed jobs via a partial filter so
// an in-progress job is never accidentally cleaned up mid-run.
pdfImportJobSchema.index(
  { updatedAt: 1 },
  { expireAfterSeconds: 14 * 24 * 60 * 60, partialFilterExpression: { status: { $in: ['done', 'failed'] } } }
);

module.exports = mongoose.model('PdfImportJob', pdfImportJobSchema);

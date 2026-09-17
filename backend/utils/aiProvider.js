/**
 * AI provider abstraction (spec #34). Only this module knows how to talk to
 * a specific AI API — everything else in the import pipeline calls
 * analyzeBatch()/analyzeRegion() and works with plain JS objects, so a
 * different provider could be swapped in later without touching the queue,
 * routes, or schema-mapping code.
 *
 * Uses Groq (console.groq.com — GroqCloud, the LPU inference company; NOT
 * the same as xAI's "Grok"). Groq's API is OpenAI-compatible (chat
 * completions with image_url content blocks), so this is nearly identical
 * in shape to the xAI version this replaced — only the endpoint, key env
 * var, and default model changed. Called directly via fetch. The API key is
 * read from process.env.GROQ_API_KEY and never leaves the server.
 *
 * Groq's free tier is real (no credit card required) but rate-limited —
 * expect to hit its per-minute request/token limit partway through a
 * multi-page PDF, not just on a single huge one; importQueue.js processes
 * one page at a time so a 15-page paper is 15 separate calls in a row.
 * callModel() below retries a 429/5xx with backoff (honoring Groq's
 * Retry-After header when present) instead of giving up on the first hit —
 * without that, a batch that got rate-limited was silently recorded as
 * "failed" and its questions were gone from the final draft for good,
 * which is why large imports used to stop after only 2-3 questions.
 *
 * Vision models on Groq also cap how many images can go in ONE request —
 * qwen3.6-27b allows 5, qwen3.8-27b allows only 3 (console.groq.com/docs/vision).
 * A page with more diagrams than that used to make the WHOLE request 400,
 * losing every question on that page. buildUserContent() below caps what it
 * sends to the active model's limit and tells the model what got left out,
 * instead of oversending and losing the page.
 */

const MODEL = process.env.AI_IMPORT_MODEL || 'qwen/qwen3.8-27b';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Confirm at console.groq.com/docs/vision before changing models — this is
// the "images per request" ceiling Groq enforces per model, not a guess.
const MAX_IMAGES_PER_REQUEST = { 'qwen/qwen3.6-27b': 5, 'qwen/qwen3.8-27b': 3 };
const IMAGE_CAP = MAX_IMAGES_PER_REQUEST[MODEL] || 3; // unknown model: assume the tighter limit
const MAX_RETRIES = parseInt(process.env.AI_IMPORT_MAX_RETRIES) || 4;
const RETRY_BASE_MS = parseInt(process.env.AI_IMPORT_RETRY_BASE_MS) || 3000;

const SYSTEM_PROMPT = `You are a document-reconstruction engine for a JEE/NEET-style test platform. You are given pages of an existing question paper (as images and/or extracted text) and must RECONSTRUCT it exactly as a structured question list — you are NOT writing new questions.

Hard rules:
- Never invent, rewrite, simplify, or "improve" question text, numbers, or options. Reproduce them exactly as printed, including numerical values.
- Never guess a correct answer. Only mark an answer if you find it in an explicit answer-key section elsewhere in the document, and only then via the answerKey array (not by editing an option's isCorrect yourself).
- Never invent marks or negative-marking values. Only report marks/negativeMarks if explicitly printed near the question or in a section header (e.g. "+4/-1"); otherwise use null.
- Exclude repeated page headers/footers (e.g. running titles, "Page X of Y") from questionText — but do not remove legitimate question content just because it's near a page edge.
- A question that continues across a page break is still ONE question — merge it, do not split it.
- Use visual position (not just text order) to determine reading order on multi-column pages.
- If a question has an associated diagram/figure/table/graph and it was extracted as one of the numbered "Embedded image #N" assets provided to you, reference it by that number. If the diagram is NOT among the embedded images (common for vector-drawn diagrams, e.g. circuit/geometry figures made of lines rather than a raster image) but IS visible in a page image you were given, instead return an approximate bounding box [x0,y0,x1,y1] in 0–1 normalized coordinates (relative to that full page image) so it can be cropped out — do not attempt to redraw or describe it as text.
- The SAME asset mechanism applies to individual OPTIONS, not just the question as a whole — this is common in "which of the following figures..." style questions. If a specific option (not the question stem) has its own diagram, put that option's asset on the option object itself (see schema below: each option may carry its own "asset"), not on the question's top-level "assets" array.
- Some pages may include a note like "N image(s) on this page were not attached (limit reached)". If a question or option you can see in the page image clearly has a diagram that is missing from the embedded-image numbers you were given (because it was left out under that limit), do NOT invent a bounding box guess for it — instead leave that asset empty, set confidence to "review", and add a flag such as "diagram present but not attached — reprocess this page alone to capture it".
- If you cannot reliably determine something (option count, boundary, whether a diagram belongs to this question, OCR of unclear text), do not guess — set confidence to "review" or "low" and add a short flag string explaining what's uncertain.
- Only classify a numbered/lettered list as multiple-choice OPTIONS if it's actually presented as answer choices for the preceding question — not every numbered list in a document is an MCQ option set.

Respond with STRICT JSON ONLY (no markdown fences, no commentary) matching exactly:
{
  "questions": [
    {
      "number": <int or null>,
      "pageStart": <int>, "pageEnd": <int>,
      "questionText": "<string, header/footer stripped>",
      "questionType": "mcq" | "multi" | "numerical" | "assertion-reason" | "true-false" | "match" | "subjective" | "other",
      "isMultiChoice": <bool>,
      "options": [ { "label": "<A/B/1/i as printed>", "text": "<string>", "asset": null | { "type": "embedded", "imageIndex": <int> } | { "type": "region", "page": <int>, "box": [x0,y0,x1,y1] } } ],
      "marks": <number or null>,
      "negativeMarks": <number or null>,
      "assets": [ { "type": "embedded", "imageIndex": <int> } | { "type": "region", "page": <int>, "box": [x0,y0,x1,y1] } ],
      "confidence": "high" | "review" | "low",
      "flags": ["<short reason string>", ...]
    }
  ],
  "answerKey": [ { "number": <int>, "correctLabel": "<matches an option label above>" } ]
}
If no answer key is present in the document, return "answerKey": [].`;

function buildUserContent(batch) {
  // OpenAI-compatible content-block format: {type:'text',text} and
  // {type:'image_url', image_url:{url:'data:image/png;base64,<data>'}} —
  // different shape from Anthropic's {type:'image', source:{...}}.
  const content = [];
  content.push({ type: 'text', text: `Pages ${batch.pageNumbers.join(', ')} of a ${batch.pageCount}-page document. Reconstruct every question found on these pages, following the rules above.` });

  const scannedSet = new Set(batch.scannedPages || []);
  const relevantEmbedded = (batch.embeddedImages || []).filter(img => batch.pageNumbers.includes(img.page));
  const pagesWithEmbedded = new Set(relevantEmbedded.map(img => img.page));

  // Groq enforces a hard per-model cap on images per request (IMAGE_CAP,
  // see top of file) — exceeding it 400s the ENTIRE call, losing every
  // question on the page(s) in this batch, not just the extra image. Page
  // images take priority (without one, a scanned page can't be read at
  // all); embedded diagrams fill whatever budget is left, in order.
  let imagesUsed = 0;
  let omittedCount = 0;
  const imageBlocks = []; // collected separately so page-image and embedded-image budgeting share one counter

  for (const pageNum of batch.pageNumbers) {
    const text = batch.textByPage[pageNum - 1] || '';
    if (text) content.push({ type: 'text', text: `--- Page ${pageNum} extracted text ---\n${text}` });

    // Only send the (expensive, TPM-hungry) page image when there's an
    // actual reason to: no usable text layer (scanned page — vision is the
    // ONLY way to read it), or a diagram was extracted from this page and
    // the model needs to see its position/context to associate it with the
    // right question. A normal text-only page gets text alone. This is what
    // keeps a single request under Groq's free-tier TPM ceiling — sending
    // every page's image unconditionally (the original design) blew well
    // past an 8000 TPM limit on even a 2-page batch.
    const needsImage = batch.forceImages || scannedSet.has(pageNum) || pagesWithEmbedded.has(pageNum);
    if (needsImage && batch.pageImages[pageNum] && imagesUsed < IMAGE_CAP) {
      imageBlocks.push({ type: 'text', text: `--- Page ${pageNum} rendered image ---` });
      imageBlocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${batch.pageImages[pageNum]}`, detail: 'low' } });
      imagesUsed++;
    } else if (needsImage) {
      omittedCount++;
    }
  }

  for (const img of relevantEmbedded) {
    if (imagesUsed >= IMAGE_CAP) { omittedCount++; continue; }
    imageBlocks.push({ type: 'text', text: `--- Embedded image #${img.index} (from page ${img.page}) ---` });
    imageBlocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.base64}`, detail: 'low' } });
    imagesUsed++;
  }

  content.push(...imageBlocks);
  if (omittedCount > 0) {
    content.push({ type: 'text', text: `Note: ${omittedCount} image(s) on this page were not attached (this model allows at most ${IMAGE_CAP} images per request). Follow the instruction above for any question/option that appears to need one of them — do not guess its content.` });
  }

  return content;
}

function parseJsonResponse(text) {
  // Models occasionally wrap JSON in a markdown fence despite instructions —
  // strip that defensively rather than failing the whole batch over it.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'');
  return JSON.parse(cleaned);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callModel(content) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set — configure it to enable AI PDF import.');
  }
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 16000, // Groq's documented ceiling for these models is 16,384 — this leaves headroom rather than truncating mid-JSON on a page with many/long questions
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
  });

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body,
      });
    } catch (networkErr) {
      // fetch itself threw (DNS blip, connection reset) — treat exactly like
      // a retryable server error rather than failing the whole page.
      lastErr = networkErr;
      if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * Math.pow(2, attempt)); continue; }
      throw networkErr;
    }

    if (res.ok) {
      const data = await res.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('AI provider returned no text content');
      try {
        return parseJsonResponse(text);
      } catch (parseErr) {
        // Occasionally the model returns truncated/malformed JSON (more
        // likely right at the old 8000-token ceiling, less likely now, but
        // still possible on an unusually dense page) — that used to fail
        // the whole page instantly. Worth one retry: it's non-deterministic
        // output, a second attempt at the same page often comes back clean.
        lastErr = new Error(`AI provider returned invalid JSON: ${parseErr.message}`);
        if (attempt === MAX_RETRIES) throw lastErr;
        console.warn(`[AI-IMPORT] Malformed JSON from model, retrying (attempt ${attempt+1}/${MAX_RETRIES})`);
        await sleep(RETRY_BASE_MS);
        continue;
      }
    }

    // 429 (rate limit) and 5xx (transient) are worth retrying — a page
    // that's simply the Nth request this minute is not a bad page, and
    // giving up on it here is exactly what used to silently drop most of a
    // multi-page document down to just its first couple of pages.
    const retryable = res.status === 429 || res.status >= 500;
    const body_ = await res.text().catch(() => '');
    lastErr = new Error(`AI provider error ${res.status}: ${body_.slice(0, 300)}`);
    if (!retryable || attempt === MAX_RETRIES) throw lastErr;

    const retryAfterHeader = res.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Math.max(1000, parseFloat(retryAfterHeader) * 1000) : RETRY_BASE_MS * Math.pow(2, attempt);
    console.warn(`[AI-IMPORT] ${res.status} from Groq, retrying in ${Math.round(waitMs/1000)}s (attempt ${attempt+1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }
  throw lastErr;
}

/**
 * Analyze one batch of pages (a small page range — see importQueue.js for
 * batching strategy) and return { questions, answerKey } per the schema
 * above. Never sends the raw PDF — only the already-locally-extracted
 * text/images for these specific pages (spec #9, #39).
 */
async function analyzeBatch(batch) {
  const content = buildUserContent(batch);
  const result = await callModel(content);
  return {
    questions: Array.isArray(result.questions) ? result.questions : [],
    answerKey: Array.isArray(result.answerKey) ? result.answerKey : [],
  };
}

/**
 * Reprocess a single page range (spec #27) — same call shape as
 * analyzeBatch, used when a teacher flags one question as wrong rather than
 * re-running the whole document.
 */
async function analyzeRegion(batch) {
  return analyzeBatch(batch);
}

module.exports = { analyzeBatch, analyzeRegion, MODEL, IMAGE_CAP };
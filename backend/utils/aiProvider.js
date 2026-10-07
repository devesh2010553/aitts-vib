/**
 * AI provider abstraction (spec #34). Only this module knows how to talk to
 * a specific AI API — everything else in the import pipeline calls
 * analyzeBatch()/analyzeRegion() and works with plain JS objects.
 *
 * Two providers are wired in, selected by AI_IMPORT_PROVIDER=groq|gemini
 * (defaults to 'gemini' if GEMINI_API_KEY is set, else 'groq' — so setting
 * GEMINI_API_KEY alone is enough to switch, no other config needed):
 *
 * - groq   (console.groq.com — GroqCloud, NOT xAI's "Grok"). OpenAI-compatible
 *   chat completions. Free tier has no credit card requirement but a real
 *   per-minute request/token ceiling, AND a hard per-model cap on images in
 *   ONE request (qwen3.6-27b: 5, qwen3.8-27b: 3 — console.groq.com/docs/vision).
 *   Exceeding the image cap 400s the whole request, losing every question on
 *   that page — buildUserContent() below caps what it sends per provider.
 *
 * - gemini (aistudio.google.com — Google AI Studio). Free tier ("Gemini Flash")
 *   is far more generous for this workload: no meaningful per-request image
 *   cap, a much larger free RPM/TPM allowance, and native structured JSON
 *   output (responseMimeType: 'application/json'). Get a key at
 *   aistudio.google.com — no credit card required — and set it as
 *   GEMINI_API_KEY. Model defaults to gemini-3.6-flash; override with
 *   AI_IMPORT_MODEL if Google renames/deprecates it later (they retire
 *   Gemini model IDs for new API keys periodically — check
 *   ai.google.dev/gemini-api/docs/models if this ever 404s again).
 *
 *   MULTIPLE KEYS: since this deployment is Gemini-only (no Groq fallback —
 *   deliberate choice), set GEMINI_API_KEY, GEMINI_API_KEY2, GEMINI_API_KEY3
 *   (any subset; only GEMINI_API_KEY is required) to get 2-3x the effective
 *   free-tier daily quota. Each AI Studio key has its OWN independent daily
 *   cap, so once one key returns a genuine quota-exhausted 429 ("You
 *   exceeded your current quota"), callGemini() immediately rotates to the
 *   next configured key for a fresh quota bucket — instead of retrying the
 *   same exhausted key, which can never succeed until that key's quota
 *   resets (could be hours). A round-robin cursor also spreads normal,
 *   non-error traffic across all configured keys rather than hammering key
 *   #1 until it runs dry before ever touching #2/#3.
 *
 * Both API keys are read straight from process.env and never leave the
 * server. Neither provider is ever sent the raw PDF — only the already
 * locally-extracted text/images for the specific pages in a batch (spec #9,
 * #39) via pdfExtract.js.
 *
 * A page that gets rate-limited (429) or hits a transient 5xx used to be
 * recorded as a permanently "failed" batch with zero retry — that's the
 * original reason large imports used to stop after only 2-3 questions.
 * callModel() below retries with backoff before giving up on a page.
 *
 * IMPORTANT — retry count vs quota: every retry attempt is a REAL API call
 * that spends quota. MAX_RETRIES defaults to 4 for both providers on
 * purpose — an earlier version bumped Gemini specifically to 7 to ride out
 * "high demand" 503s, but that made things WORSE in practice: on a
 * multi-page import, 7 retries/page burns through a free-tier daily quota
 * far faster, so imports started hitting the hard 429 quota wall almost
 * immediately instead of the occasional transient 503. With multi-key
 * rotation now available, resilience comes from switching to a fresh quota
 * bucket, not from hammering a single key harder.
 */

const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY2, process.env.GEMINI_API_KEY3].filter(Boolean);
const PROVIDER = process.env.AI_IMPORT_PROVIDER || (GEMINI_KEYS.length ? 'gemini' : 'groq');

const GROQ_MODEL_DEFAULT   = 'qwen/qwen3.8-27b';
const GEMINI_MODEL_DEFAULT = 'gemini-3.6-flash'; // gemini-2.5-flash was retired for new API keys — confirm at ai.google.dev/gemini-api/docs/models if this 404s again later
// A common mix-up: AI_IMPORT_MODEL selects the MODEL, AI_IMPORT_PROVIDER
// selects the PROVIDER. Setting AI_IMPORT_MODEL=gemini (or =groq) sends that
// literal string to the API as a model name, which 404s with a confusing
// "models/gemini is not found" error. Catch it here and fall back to the
// correct default instead of letting every single page fail on it.
let rawModelEnv = (process.env.AI_IMPORT_MODEL || '').trim();
if (rawModelEnv && ['gemini', 'groq'].includes(rawModelEnv.toLowerCase())) {
  console.warn(`[AI-IMPORT] AI_IMPORT_MODEL="${rawModelEnv}" looks like a provider name, not a model name — did you mean AI_IMPORT_PROVIDER? Ignoring it and using the default model for "${PROVIDER}" instead.`);
  rawModelEnv = '';
}
const MODEL = rawModelEnv || (PROVIDER === 'gemini' ? GEMINI_MODEL_DEFAULT : GROQ_MODEL_DEFAULT);

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const geminiApiUrl = () => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;

// Confirm at console.groq.com/docs/vision before changing Groq models — this
// is the "images per request" ceiling Groq enforces per model, not a guess.
// Gemini has no comparably tight limit for a batch this size (we send at
// most one page image + a handful of embedded diagrams), so it's given a
// generous cap that in practice never triggers the truncation path below.
const GROQ_MAX_IMAGES_PER_REQUEST = { 'qwen/qwen3.6-27b': 5, 'qwen/qwen3.8-27b': 3 };
const IMAGE_CAP = PROVIDER === 'gemini' ? 16 : (GROQ_MAX_IMAGES_PER_REQUEST[MODEL] || 3);

// See the big header comment above re: retry count vs quota consumption —
// 4 is deliberate, not a placeholder.
const MAX_RETRIES = parseInt(process.env.AI_IMPORT_MAX_RETRIES) || 4;
const RETRY_BASE_MS = parseInt(process.env.AI_IMPORT_RETRY_BASE_MS) || 3000;
const RETRY_MAX_MS = parseInt(process.env.AI_IMPORT_RETRY_MAX_MS) || 20000; // caps each individual wait so a run of retries doesn't spiral into a multi-minute stall
function backoffMs(attempt) { return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt)); }
const MAX_OUTPUT_TOKENS = 16000; // Groq's documented ceiling for the qwen models is 16,384; Gemini allows far more — sized to Groq's tighter limit so a page's JSON doesn't get truncated mid-object on either provider

// How long to skip a Gemini key after it returns a genuine quota-exhausted
// 429 (see parseGeminiRetryDelayMs below for how that's distinguished from a
// short transient throttle). This is a heuristic, not a known reset time —
// AI Studio free-tier daily quotas reset roughly once every 24h but the
// exact instant isn't exposed in the error response, so this just avoids
// re-trying a key we already know is dead for a while. A restart clears it.
const GEMINI_KEY_COOLDOWN_MS = parseInt(process.env.AI_IMPORT_GEMINI_KEY_COOLDOWN_MS) || 6 * 60 * 60 * 1000;
const geminiKeyExhaustedUntil = new Map(); // apiKey string -> epoch ms
let geminiKeyCursor = 0; // round-robins WHICH key starts each fresh call, so normal traffic spreads across all configured keys too

const BOX_FORMAT_INSTRUCTION = PROVIDER === 'gemini'
  ? 'a bounding box as integers [ymin,xmin,ymax,xmax] normalized to a 0-1000 scale — this is the exact box convention Gemini is trained on for object detection; do NOT convert it to a 0-1 float range and do NOT reorder it to x-first, either of those will make the crop wrong'
  : 'an approximate bounding box [x0,y0,x1,y1] in 0–1 normalized coordinates (x before y, floats not integers)';
const BOX_SCHEMA_EXAMPLE = PROVIDER === 'gemini' ? '[ymin,xmin,ymax,xmax]' : '[x0,y0,x1,y1]';

const SYSTEM_PROMPT = `You are a document-reconstruction engine for a JEE/NEET-style test platform. You are given pages of an existing question paper (as images and/or extracted text) and must RECONSTRUCT it exactly as a structured question list — you are NOT writing new questions.

Hard rules:
- Never invent, rewrite, simplify, or "improve" question text, numbers, or options. Reproduce them exactly as printed, including numerical values.
- Never guess a correct answer. Only mark an answer if you find it in an explicit answer-key section elsewhere in the document, and only then via the answerKey array (not by editing an option's isCorrect yourself).
- Never invent marks or negative-marking values. Only report marks/negativeMarks if explicitly printed near the question or in a section header (e.g. "+4/-1"); otherwise use null.
- Exclude repeated page headers/footers (e.g. running titles, "Page X of Y") from questionText — but do not remove legitimate question content just because it's near a page edge.
- A question that continues across a page break is still ONE question — merge it, do not split it.
- Use visual position (not just text order) to determine reading order on multi-column pages.
- If a question has an associated diagram/figure/table/graph and it was extracted as one of the numbered "Embedded image #N" assets provided to you, reference it by that number. If the diagram is NOT among the embedded images (common for vector-drawn diagrams, e.g. circuit/geometry figures made of lines rather than a raster image) but IS visible in a page image you were given, instead return ${BOX_FORMAT_INSTRUCTION} so it can be cropped out — do not attempt to redraw or describe it as text. Make sure the box fully encloses the whole diagram including its edges/labels, not just its center — a box that's too tight will crop off part of it.
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
      "options": [ { "label": "<A/B/1/i as printed>", "text": "<string>", "asset": null | { "type": "embedded", "imageIndex": <int> } | { "type": "region", "page": <int>, "box": ${BOX_SCHEMA_EXAMPLE} } } ],
      "marks": <number or null>,
      "negativeMarks": <number or null>,
      "assets": [ { "type": "embedded", "imageIndex": <int> } | { "type": "region", "page": <int>, "box": ${BOX_SCHEMA_EXAMPLE} } ],
      "confidence": "high" | "review" | "low",
      "flags": ["<short reason string>", ...]
    }
  ],
  "answerKey": [ { "number": <int>, "correctLabel": "<matches an option label above>" } ]
}
If no answer key is present in the document, return "answerKey": [].`;

/**
 * Provider-agnostic content blocks: {type:'text', text} and
 * {type:'image', mimeType, base64}. callGroq()/callGemini() below each
 * translate this into their own wire format — Groq wants
 * {type:'image_url', image_url:{url:'data:...'}}, Gemini wants
 * {inline_data:{mime_type, data}}.
 */
function buildUserContent(batch) {
  const content = [];
  content.push({ type: 'text', text: `Pages ${batch.pageNumbers.join(', ')} of a ${batch.pageCount}-page document. Reconstruct every question found on these pages, following the rules above.` });

  const scannedSet = new Set(batch.scannedPages || []);
  const relevantEmbedded = (batch.embeddedImages || []).filter(img => batch.pageNumbers.includes(img.page));
  const pagesWithEmbedded = new Set(relevantEmbedded.map(img => img.page));

  // The active provider enforces some cap on images per request (IMAGE_CAP)
  // — exceeding it either errors the whole call (Groq) or just wastes
  // tokens (Gemini, generous cap so this rarely bites). Page images take
  // priority (without one, a scanned page can't be read at all); embedded
  // diagrams fill whatever budget is left, in order.
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
    // right question. A normal text-only page gets text alone — this is
    // what keeps a single request well under either provider's per-minute
    // token ceiling.
    const needsImage = batch.forceImages || scannedSet.has(pageNum) || pagesWithEmbedded.has(pageNum);
    if (needsImage && batch.pageImages[pageNum] && imagesUsed < IMAGE_CAP) {
      imageBlocks.push({ type: 'text', text: `--- Page ${pageNum} rendered image ---` });
      imageBlocks.push({ type: 'image', mimeType: 'image/png', base64: batch.pageImages[pageNum] });
      imagesUsed++;
    } else if (needsImage) {
      omittedCount++;
    }
  }

  for (const img of relevantEmbedded) {
    if (imagesUsed >= IMAGE_CAP) { omittedCount++; continue; }
    imageBlocks.push({ type: 'text', text: `--- Embedded image #${img.index} (from page ${img.page}) ---` });
    imageBlocks.push({ type: 'image', mimeType: 'image/png', base64: img.base64 });
    imagesUsed++;
  }

  content.push(...imageBlocks);
  if (omittedCount > 0) {
    content.push({ type: 'text', text: `Note: ${omittedCount} image(s) on this page were not attached (this request allows at most ${IMAGE_CAP} images). Follow the instruction above for any question/option that appears to need one of them — do not guess its content.` });
  }

  return content;
}

/**
 * Converts a region asset's box — in whichever coordinate convention the
 * active provider was told to use (BOX_FORMAT_INSTRUCTION above) — into one
 * canonical [x0,y0,x1,y1] range in 0-1, then pads it outward a little.
 *
 * Gemini is specifically trained on [ymin,xmin,ymax,xmax] normalized to
 * 0-1000 for object detection (ai.google.dev's bounding-box docs). Earlier
 * this prompt asked EVERY provider for [x0,y0,x1,y1]/0-1 regardless — fine
 * for Groq, but fighting Gemini's own training, which produced boxes that
 * routinely missed roughly half the diagram. Now each provider is asked
 * for its native format and this is the one place that un-normalizes back
 * to a single shape for cropRegion() (importQueue.js) to consume.
 *
 * The padding on top is a second, independent safety margin — every vision
 * model's boxes are approximate, not pixel-exact, so padding outward trades
 * a sliver of extra whitespace for never clipping the actual diagram, which
 * is the much safer failure mode here.
 */
function normalizeAndPadBox(box, pad = 0.08) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(n => typeof n !== 'number' || Number.isNaN(n))) return null;

  let x0, y0, x1, y1;
  if (PROVIDER === 'gemini') {
    const [ymin, xmin, ymax, xmax] = box; // Gemini's native order/scale
    x0 = xmin / 1000; y0 = ymin / 1000; x1 = xmax / 1000; y1 = ymax / 1000;
  } else {
    [x0, y0, x1, y1] = box;
  }
  if (x1 < x0) [x0, x1] = [x1, x0]; // defensive — occasionally still swapped regardless of provider
  if (y1 < y0) [y0, y1] = [y1, y0];

  const w = x1 - x0, h = y1 - y0;
  x0 = Math.max(0, x0 - w * pad); y0 = Math.max(0, y0 - h * pad);
  x1 = Math.min(1, x1 + w * pad); y1 = Math.min(1, y1 + h * pad);
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

function parseJsonResponse(text) {
  // Models occasionally wrap JSON in a markdown fence despite instructions —
  // strip that defensively rather than failing the whole batch over it.
  // (Gemini's responseMimeType:'application/json' avoids this in practice,
  // but the same parser runs for both providers so it's cheap insurance.)
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}

/**
 * Same as a plain setTimeout-based sleep, but abortable via an AbortSignal.
 * Without this, hitting "Cancel" during a backoff wait (which can be up to
 * RETRY_MAX_MS = 20s) did nothing until that wait finished on its own —
 * cancellation could take the better part of a minute to actually stop
 * anything. Every sleep() call in the retry loop below passes the batch's
 * signal through, so an abort() interrupts a wait immediately, not just an
 * in-flight fetch.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; return reject(e); }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
      }, { once: true });
    }
  });
}

/**
 * Distinguishes a short, self-resolving Gemini rate limit from a hard quota
 * cap. Gemini includes a RetryInfo.retryDelay (e.g. "19s") in the error body
 * when it expects the limit to clear on its own soon; a genuine
 * quota-exceeded response (daily cap hit, "check your plan and billing")
 * omits it, because retrying — on THIS key — won't help until the quota
 * window resets, which could be hours away. Returns the wait in ms, or null
 * if no such hint was present (signals a hard quota exhaustion upstream).
 */
function parseGeminiRetryDelayMs(text) {
  try {
    const data = JSON.parse(text);
    const details = data && data.error && data.error.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (typeof d.retryDelay === 'string') {
          const m = /^([\d.]+)s$/.exec(d.retryDelay.trim());
          if (m) return Math.ceil(parseFloat(m[1]) * 1000);
        }
      }
    }
  } catch (e) { /* not JSON, or not the shape we expect — treat as no hint */ }
  return null;
}

/** Shared retry/backoff loop — takes a `doRequest()` that performs ONE HTTP
 *  attempt and returns { ok, status, text, retryAfterMs?, quotaExhausted? }.
 *  A quotaExhausted outcome is thrown immediately (err.quotaExhausted =
 *  true), never retried here — callGemini()'s key-rotation loop is what
 *  handles that case, by moving to a different key's quota entirely rather
 *  than waiting out a cap that retrying can't fix. */
async function withRetries(providerLabel, doRequest, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let outcome;
    try {
      outcome = await doRequest();
    } catch (networkErr) {
      // An intentional cancel (importQueue.js aborts the in-flight request
      // when a teacher hits "Cancel") surfaces here as an AbortError — that
      // is NOT a transient failure to retry through, it's a request to
      // stop; propagate it immediately so the job can be marked cancelled
      // rather than burning through the backoff schedule first.
      if (networkErr.name === 'AbortError') throw networkErr;
      // fetch itself threw (DNS blip, connection reset) — retryable, same as a 5xx.
      lastErr = networkErr;
      if (attempt < MAX_RETRIES) { await sleep(backoffMs(attempt), signal); continue; }
      throw networkErr;
    }

    if (outcome.ok) {
      const text = outcome.text;
      if (!text) throw new Error(`${providerLabel} returned no text content`);
      try {
        return parseJsonResponse(text);
      } catch (parseErr) {
        // Occasionally the model returns truncated/malformed JSON — worth
        // one retry rather than failing the whole page instantly; it's
        // non-deterministic output, a second attempt often comes back clean.
        lastErr = new Error(`${providerLabel} returned invalid JSON: ${parseErr.message}`);
        if (attempt === MAX_RETRIES) throw lastErr;
        console.warn(`[AI-IMPORT] Malformed JSON from ${providerLabel}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(RETRY_BASE_MS, signal);
        continue;
      }
    }

    if (outcome.quotaExhausted) {
      // Not worth retrying THIS request at all — callGemini()'s caller
      // handles switching to a different key's quota instead.
      const err = new Error(`${providerLabel} error ${outcome.status}: ${(outcome.text || '').slice(0, 300)}`);
      err.quotaExhausted = true;
      throw err;
    }

    // 429 (rate limit) and 5xx (transient) are worth retrying — a page
    // that's simply the Nth request this minute is not a bad page, and
    // giving up on it here is exactly what used to silently drop most of a
    // multi-page document down to just its first couple of pages.
    const retryable = outcome.status === 429 || outcome.status >= 500;
    lastErr = new Error(`${providerLabel} error ${outcome.status}: ${(outcome.text || '').slice(0, 300)}`);
    if (!retryable || attempt === MAX_RETRIES) throw lastErr;

    const waitMs = outcome.retryAfterMs || backoffMs(attempt);
    const reason = outcome.status === 503 ? `${providerLabel} is overloaded (high demand)` : `${outcome.status} from ${providerLabel}`;
    console.warn(`[AI-IMPORT] ${reason}, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs, signal);
  }
  throw lastErr;
}

async function callGroq(content, signal) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is not set — configure it to enable AI PDF import (this deployment is Groq-only in this branch; set AI_IMPORT_PROVIDER=gemini and GEMINI_API_KEY to switch).');
  }
  const groqContent = content.map(b =>
    b.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.base64}`, detail: 'low' } }
      : { type: 'text', text: b.text }
  );
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: groqContent },
    ],
  });

  return withRetries('Groq', async () => {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body,
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return { ok: true, text };
    }
    const text = await res.text().catch(() => '');
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader ? Math.max(1000, parseFloat(retryAfterHeader) * 1000) : null;
    return { ok: false, status: res.status, text, retryAfterMs };
  }, signal);
}

/** One attempt at ONE Gemini request using a SPECIFIC key (with its own
 *  internal retry/backoff for transient errors). Separated from callGemini()
 *  so the key-rotation loop there can call this once per configured key. */
async function callGeminiWithKey(content, signal, apiKey, keyLabel) {
  const parts = content.map(b =>
    b.type === 'image'
      ? { inline_data: { mime_type: b.mimeType, data: b.base64 } }
      : { text: b.text }
  );
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json', // native structured output — no markdown-fence guessing needed
    },
  });

  return withRetries(keyLabel, async () => {
    const res = await fetch(geminiApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal,
    });
    if (res.ok) {
      const data = await res.json();
      const cand = data.candidates && data.candidates[0];
      // A response can come back with no parts if it was cut off by a
      // safety filter or hit maxOutputTokens before any text — surface
      // finishReason in that case rather than a bare "no text content".
      const text = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('');
      if (!text && cand && cand.finishReason && cand.finishReason !== 'STOP') {
        return { ok: false, status: 502, text: `Gemini stopped early: ${cand.finishReason}` };
      }
      return { ok: true, text };
    }
    const text = await res.text().catch(() => '');
    if (res.status === 404) {
      return { ok: false, status: 404, text: `Gemini model "${MODEL}" was not found (check AI_IMPORT_MODEL is a real model id like "gemini-3.6-flash", not a provider name — see AI_IMPORT_PROVIDER for that): ${text}` };
    }
    if (res.status === 429) {
      const retryDelayMs = parseGeminiRetryDelayMs(text);
      if (retryDelayMs != null) return { ok: false, status: 429, text, retryAfterMs: retryDelayMs }; // short, self-clearing throttle — worth retrying on this same key
      return { ok: false, status: 429, text, quotaExhausted: true }; // hard cap — this key is done until it resets; caller rotates to the next one
    }
    return { ok: false, status: res.status, text };
  }, signal);
}

/**
 * Tries every configured Gemini key in round-robin order until one
 * succeeds. A quota-exhausted key is marked and skipped for
 * GEMINI_KEY_COOLDOWN_MS on subsequent calls, and rotation to the next key
 * happens immediately (no backoff) since a different key is a genuinely
 * fresh quota bucket, not the same failure again.
 */
async function callGemini(content, signal) {
  if (!GEMINI_KEYS.length) {
    throw new Error('GEMINI_API_KEY is not set — get a free key at aistudio.google.com to enable AI PDF import.');
  }

  const now = Date.now();
  const notCoolingDown = GEMINI_KEYS.filter(k => !geminiKeyExhaustedUntil.has(k) || geminiKeyExhaustedUntil.get(k) <= now);
  // If literally every key is (heuristically) cooling down, try them anyway
  // rather than refuse outright — the cooldown is a guess, not a certainty,
  // and it's better to attempt and fail than to block an import on a guess.
  const pool = (notCoolingDown.length ? notCoolingDown : GEMINI_KEYS);
  const keysToTry = pool.map((_, i) => pool[(geminiKeyCursor + i) % pool.length]);

  let lastErr;
  for (let ki = 0; ki < keysToTry.length; ki++) {
    const apiKey = keysToTry[ki];
    const keyNum = GEMINI_KEYS.indexOf(apiKey) + 1;
    const keyLabel = GEMINI_KEYS.length > 1 ? `Gemini (key ${keyNum}/${GEMINI_KEYS.length})` : 'Gemini';
    try {
      const result = await callGeminiWithKey(content, signal, apiKey, keyLabel);
      geminiKeyExhaustedUntil.delete(apiKey); // a success means this key is healthy again, regardless of any earlier guess
      geminiKeyCursor = (GEMINI_KEYS.indexOf(apiKey) + 1) % GEMINI_KEYS.length; // next fresh call starts from the next key
      return result;
    } catch (e) {
      if (e.name === 'AbortError') throw e; // cancellation — never rotate/retry through this, propagate immediately
      lastErr = e;
      if (e.quotaExhausted) {
        geminiKeyExhaustedUntil.set(apiKey, Date.now() + GEMINI_KEY_COOLDOWN_MS);
        if (keysToTry.length > 1) console.warn(`[AI-IMPORT] ${keyLabel} hit its quota — switching to the next configured Gemini key.`);
        continue; // different quota bucket entirely — no backoff needed, try it right away
      }
      // A non-quota failure (exhausted its own retries on 503s, malformed
      // JSON after retries, etc.) isn't inherently fixed by switching keys,
      // but if another key is configured it's still worth trying rather
      // than failing the whole page over one key's bad luck.
      if (ki < keysToTry.length - 1) console.warn(`[AI-IMPORT] ${keyLabel} failed (${e.message.slice(0, 150)}), trying next configured key.`);
    }
  }
  if (GEMINI_KEYS.length > 1) lastErr.message += ` (all ${GEMINI_KEYS.length} configured Gemini keys are currently exhausted or failing)`;
  throw lastErr;
}

async function callModel(content, signal) {
  return PROVIDER === 'gemini' ? callGemini(content, signal) : callGroq(content, signal);
}

/**
 * Analyze one batch of pages (a small page range — see importQueue.js for
 * batching strategy) and return { questions, answerKey } per the schema
 * above. Never sends the raw PDF — only the already-locally-extracted
 * text/images for these specific pages (spec #9, #39).
 *
 * batch.signal (optional AbortSignal) lets importQueue.js cancel an
 * in-flight request immediately — e.g. the "Cancel" button on the review
 * screen — instead of waiting for the current page to finish.
 */
async function analyzeBatch(batch) {
  const content = buildUserContent(batch);
  const result = await callModel(content, batch.signal);
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

module.exports = { analyzeBatch, analyzeRegion, normalizeAndPadBox, PROVIDER, MODEL, IMAGE_CAP };

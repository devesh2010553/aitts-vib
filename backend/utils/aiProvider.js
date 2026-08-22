/**
 * AI provider abstraction (spec #34). Only this module knows how to talk to
 * a specific AI API — everything else in the import pipeline calls
 * analyzeBatch()/analyzeRegion() and works with plain JS objects, so a
 * different provider could be swapped in later without touching the queue,
 * routes, or schema-mapping code.
 *
 * Uses xAI's Grok API, which is OpenAI-compatible (chat completions with
 * image_url content blocks) rather than Anthropic's Messages format. Called
 * directly via fetch (Node 20+ has native fetch). The API key is read from
 * process.env.XAI_API_KEY and never leaves the server (never sent to or
 * read by the frontend).
 *
 * Note: xAI's API is billed per-token like any other provider (no free
 * tier for API access — only their web Playground is free to try) — check
 * console.x.ai for current pricing/model names before relying on a cost
 * estimate, and confirm AI_IMPORT_MODEL below is still a valid vision model
 * there, since model names change over time.
 */

const MODEL = process.env.AI_IMPORT_MODEL || 'grok-4-fast';
const API_URL = 'https://api.x.ai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a document-reconstruction engine for a JEE/NEET-style test platform. You are given pages of an existing question paper (as images and/or extracted text) and must RECONSTRUCT it exactly as a structured question list — you are NOT writing new questions.

Hard rules:
- Never invent, rewrite, simplify, or "improve" question text, numbers, or options. Reproduce them exactly as printed, including numerical values.
- Never guess a correct answer. Only mark an answer if you find it in an explicit answer-key section elsewhere in the document, and only then via the answerKey array (not by editing an option's isCorrect yourself).
- Never invent marks or negative-marking values. Only report marks/negativeMarks if explicitly printed near the question or in a section header (e.g. "+4/-1"); otherwise use null.
- Exclude repeated page headers/footers (e.g. running titles, "Page X of Y") from questionText — but do not remove legitimate question content just because it's near a page edge.
- A question that continues across a page break is still ONE question — merge it, do not split it.
- Use visual position (not just text order) to determine reading order on multi-column pages.
- If a question has an associated diagram/figure/table/graph and it was extracted as one of the numbered "Embedded image #N" assets provided to you, reference it by that number. If the diagram is NOT among the embedded images (common for vector-drawn diagrams, e.g. circuit/geometry figures made of lines rather than a raster image) but IS visible in a page image you were given, instead return an approximate bounding box [x0,y0,x1,y1] in 0–1 normalized coordinates (relative to that full page image) so it can be cropped out — do not attempt to redraw or describe it as text.
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
      "options": [ { "label": "<A/B/1/i as printed>", "text": "<string>" } ],
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

  for (const pageNum of batch.pageNumbers) {
    const text = batch.textByPage[pageNum - 1] || '';
    if (text) content.push({ type: 'text', text: `--- Page ${pageNum} extracted text ---\n${text}` });
    if (batch.pageImages[pageNum]) {
      content.push({ type: 'text', text: `--- Page ${pageNum} rendered image ---` });
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${batch.pageImages[pageNum]}`, detail: 'high' } });
    }
  }

  const relevantEmbedded = batch.embeddedImages.filter(img => batch.pageNumbers.includes(img.page));
  for (const img of relevantEmbedded) {
    content.push({ type: 'text', text: `--- Embedded image #${img.index} (from page ${img.page}) ---` });
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.base64}`, detail: 'high' } });
  }

  return content;
}

function parseJsonResponse(text) {
  // Models occasionally wrap JSON in a markdown fence despite instructions —
  // strip that defensively rather than failing the whole batch over it.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'');
  return JSON.parse(cleaned);
}

async function callModel(content) {
  if (!process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY is not set — configure it to enable AI PDF import.');
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI provider error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('AI provider returned no text content');
  return parseJsonResponse(text);
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

module.exports = { analyzeBatch, analyzeRegion, MODEL };

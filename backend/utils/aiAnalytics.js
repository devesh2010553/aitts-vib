/**
 * "Ask AI" result analysis — builds a compact prompt from a graded result and
 * asks Gemini for a structured coaching report.
 *
 * Why this is cheap for the server:
 *  - ONE Gemini call per (student, test, score) — the answer is cached in
 *    memory for 12h, and the browser also keeps its own copy in localStorage,
 *    so reopening the report never reaches this code.
 *  - Per-student hourly cap + a small global concurrency cap (see the route).
 *  - The prompt is a compact digest (truncated question text, no images,
 *    no option lists for correct answers) — a few thousand tokens at most.
 *  - Node only awaits Google's response; no CPU work, no DB writes.
 *
 * Key: GEMINI_API_KEY3 only (separate quota from the PDF importer's keys).
 * Model: AI_ANALYTICS_MODEL (default gemini-3.6-flash, same default the PDF
 * importer uses — change the env var if Google renames it).
 */
// Ask AI deliberately uses ONLY GEMINI_API_KEY3, so its quota never competes with the PDF importer (which uses GEMINI_API_KEY / KEY2).
const KEYS = [process.env.GEMINI_API_KEY3].filter(Boolean);
const MODEL = (process.env.AI_ANALYTICS_MODEL || 'gemini-3.6-flash').trim();
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const TIMEOUT_MS = 30000;
const KEY_COOLDOWN_MS = 30 * 60 * 1000;

const cooldown = new Map(); // key -> epoch ms until which it is skipped
let cursor = 0;

const SYSTEM = `You are a calm, practical exam coach for JEE/NEET students. You receive a digest of ONE student's graded test attempt. Analyse ONLY what is in the digest — never invent scores, topics or facts that are not supported by it.

Guidance:
- Infer weak topics from the text of the questions the student got wrong or skipped (group similar ones). If the test's subject/topic is given, use it for context.
- Judge time use from total time vs. allotted time and, when per-question times are provided, from the slowest questions and from questions answered very fast but wrong (rushing) or very slow but skipped.
- Mention negative marking only if wrong answers actually cost marks.
- Be specific and encouraging, short sentences, simple English. No filler, no generic study-tips that ignore the data.

Respond with STRICT JSON only (no markdown fences), exactly this shape:
{
  "summary": "<2-3 sentences: overall performance in plain words>",
  "time": "<2-3 sentences on time management, grounded in the numbers>",
  "strengths": ["<short>", "..."],
  "weakAreas": [ { "topic": "<short topic name>", "why": "<1 sentence evidence, cite question numbers like Q4, Q9>" } ],
  "focus": [ "<concrete next action, most important first>", "..." ]
}
Limits: strengths max 3, weakAreas max 5, focus max 5. Each string under 220 characters.`;

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Build the compact digest text. `qTimes` (seconds per question) is optional. */
function buildDigest(test, result, qTimes) {
  const qs = test.questions || [];
  const byQ = {};
  (result.answers || []).forEach(a => { byQ[a.questionId] = a; });
  const letters = 'ABCDEFGH';
  const haveTimes = Array.isArray(qTimes) && qTimes.length === qs.length;

  const lines = qs.slice(0, 120).map((q, i) => {
    const a = byQ[q.questionId] || {};
    const skipped = a.isCorrect !== true && (a.selectedOption === -1 || a.selectedOption == null) && !(a.selectedOptions && a.selectedOptions.length);
    const status = a.isCorrect ? 'CORRECT' : (skipped ? 'SKIPPED' : 'WRONG');
    let line = `Q${i + 1} [${status}${q.isBonus ? ', bonus' : ''}] ${clip(q.questionText, 170)}`;
    if (status === 'WRONG') {
      const chosen = q.isMultiChoice ? (a.selectedOptions || []) : [a.selectedOption];
      const corr = (q.options || []).map((o, j) => o.isCorrect ? j : -1).filter(j => j >= 0);
      const nm = j => (q.options && q.options[j]) ? `${letters[j] || j + 1}:${clip(q.options[j].text, 40)}` : '?';
      line += ` | chose ${chosen.map(nm).join(',')} | correct ${corr.map(nm).join(',')}`;
    }
    if (haveTimes) line += ` | ${qTimes[i]}s`;
    return line;
  });

  const durMin = test.duration || null;
  const head = [
    `Test: ${clip(test.title, 80)} | Subject: ${clip(test.subject, 40)} | Topic: ${clip(test.topic, 80)}`,
    `Score: ${result.obtainedMarks}/${test.totalMarks} | Correct ${result.correctAnswers}, Wrong ${result.wrongAnswers}, Skipped ${result.notAttempted}`,
    `Time taken: ${Math.round((result.timeTaken || 0) / 60)} min${durMin ? ` of ${durMin} min allowed` : ''} for ${qs.length} questions`,
    haveTimes ? 'Per-question time (seconds) is appended to each line.' : 'Per-question time is NOT available — judge time only from the total.',
  ];
  return head.join('\n') + '\n\n' + lines.join('\n');
}

function parseJson(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(t);
  const arr = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map(x => clip(x, 240)).filter(Boolean);
  return {
    summary: clip(obj.summary, 500),
    time: clip(obj.time, 500),
    strengths: arr(obj.strengths, 3),
    weakAreas: (Array.isArray(obj.weakAreas) ? obj.weakAreas : []).slice(0, 5)
      .map(w => ({ topic: clip(w && w.topic, 80), why: clip(w && w.why, 240) })).filter(w => w.topic),
    focus: arr(obj.focus, 5),
  };
}

async function callOnce(apiKey, digest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL_BASE}${encodeURIComponent(MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: digest }] }],
        generationConfig: { maxOutputTokens: 6000, temperature: 0.4, responseMimeType: 'application/json' },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || '').join('');
    if (!text) throw Object.assign(new Error('Gemini returned no text' + (cand && cand.finishReason ? ` (${cand.finishReason})` : '')), { status: 502 });
    return parseJson(text);
  } finally { clearTimeout(timer); }
}

/** Calls Gemini, rotating to the next configured key on quota/overload errors. */
async function analyse(test, result, qTimes) {
  if (!KEYS.length) throw Object.assign(new Error('AI is not configured on the server (GEMINI_API_KEY3 missing).'), { status: 503 });
  const digest = buildDigest(test, result, qTimes);
  const now = Date.now();
  const live = KEYS.filter(k => !(cooldown.get(k) > now));
  const pool = live.length ? live : KEYS;
  const order = pool.map((_, i) => pool[(cursor + i) % pool.length]);
  let lastErr;
  for (const key of order) {
    try {
      const out = await callOnce(key, digest);
      cursor = (KEYS.indexOf(key) + 1) % KEYS.length;
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status === 429) cooldown.set(key, Date.now() + KEY_COOLDOWN_MS);
      const retriable = e.status === 429 || e.status >= 500 || e.name === 'AbortError' || e instanceof SyntaxError;
      if (!retriable) break;
    }
  }
  console.warn('[AI-ANALYTICS] failed:', lastErr && lastErr.message);
  throw Object.assign(new Error('AI is busy right now. Please try again in a minute.'), { status: 503 });
}

module.exports = { analyse, MODEL };
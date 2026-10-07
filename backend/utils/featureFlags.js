/**
 * Student-facing feature switches (admin panel -> "Student Features" card).
 *
 *   tools       — the bottom-nav "Tools" tab (Gemini chat + 3D molecule viewer).
 *                 Both tools run entirely in the student's browser, so this
 *                 flag only decides whether the tab is SHOWN — turning it off
 *                 means the tool code is never even downloaded.
 *   aiAnalytics — the "Ask AI" button on results (the one feature that does
 *                 spend server-side Gemini quota).
 *
 * Stored as ONE tiny SiteSetting doc on the secondary Mongo connection (same
 * place as the other site-content settings). Reads go through a short
 * in-memory cache, so even if every student's browser refreshed its flags at
 * once the database sees at most ~2 reads/minute.
 */
const SiteSetting = require('../models/SiteSetting');

const KEY = 'studentFeatureFlags';
const DEFAULTS = { tools: true, aiAnalytics: true };
const TTL_MS = 30 * 1000;

let cache = null;      // { flags, at }
let inflight = null;   // de-dupes concurrent cache-miss reads

function normalise(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  return out;
}

async function getFlags() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.flags;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const doc = await SiteSetting.findById(KEY).lean();
      let parsed = null;
      try { parsed = doc && doc.value ? JSON.parse(doc.value) : null; } catch { parsed = null; }
      const flags = normalise(parsed);
      cache = { flags, at: Date.now() };
      return flags;
    } catch (err) {
      // DB hiccup: serve the last known flags (or defaults) rather than failing the page.
      console.warn('[FLAGS] read failed:', err.message);
      return cache ? cache.flags : { ...DEFAULTS };
    } finally { inflight = null; }
  })();
  return inflight;
}

async function setFlags(patch) {
  const next = { ...(await getFlags()) };
  for (const k of Object.keys(DEFAULTS)) if (patch && typeof patch[k] === 'boolean') next[k] = patch[k];
  await SiteSetting.findByIdAndUpdate(KEY, { value: JSON.stringify(next) }, { upsert: true });
  cache = { flags: next, at: Date.now() };
  return next;
}

module.exports = { getFlags, setFlags, DEFAULTS };

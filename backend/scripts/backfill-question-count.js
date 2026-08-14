/**
 * One-time backfill: sets Test.questionCount for documents created before this
 * field existed. Safe to re-run (idempotent) — only touches docs where the
 * stored count doesn't match the actual array length.
 *
 * Run manually once, after deploying the questionCount change:
 *   node backend/scripts/backfill-question-count.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Test = require('../models/Test');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('[BACKFILL] Connected. Scanning tests...');

  const tests = await Test.find().select('_id questions questionCount');
  let updated = 0;
  for (const t of tests) {
    const actual = (t.questions || []).length;
    if (t.questionCount !== actual) {
      await Test.updateOne({ _id: t._id }, { $set: { questionCount: actual } });
      updated++;
    }
  }

  console.log(`[BACKFILL] Done. ${updated}/${tests.length} test(s) updated.`);
  await mongoose.disconnect();
}

run().catch(err => { console.error('[BACKFILL] Failed:', err); process.exit(1); });

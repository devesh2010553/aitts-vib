// Validates the /leaderboard/class cumulative-percentage fix against the
// exact scenario from the bug report. Mirrors the algorithm in
// backend/routes/leaderboard.js's /class route exactly (same steps, same
// order) using in-memory mock data, so it can run without a live MongoDB.
// Run: node backend/scripts/validate-leaderboard-fix.js

const BATCHES = ['11', '12', 'dropper'];

// ── Mock data, matching the bug report's scenario ──────────────────────────
const allTests = [
  { _id: 't1', title: 'Test 1', totalMarks: 4,  targetBatches: ['11', '12'] }, // applicable to 11 AND 12
  { _id: 't2', title: 'Test 2', totalMarks: 72, targetBatches: ['12'] },       // applicable ONLY to 12
];

const rawResults = [
  // Student A — Class 11 — took Test 1 only (Test 2 not applicable to them)
  { userId: 'A', userName: 'Student A', coachingName: '--', batch: '11', testId: 't1', obtainedMarks: 4,  timeTaken: 100 },
  // Student B — Class 12 — took both
  { userId: 'B', userName: 'Student B', coachingName: '--', batch: '12', testId: 't1', obtainedMarks: 3,  timeTaken: 90  },
  { userId: 'B', userName: 'Student B', coachingName: '--', batch: '12', testId: 't2', obtainedMarks: 16, timeTaken: 200 },
];

// ── Exact same algorithm as backend/routes/leaderboard.js's /class route ──
function buildByBatch(tests) {
  const byBatch = {};
  for (const b of BATCHES) {
    const applicable = tests.filter(t => !t.targetBatches || t.targetBatches.length === 0 || t.targetBatches.includes(b));
    byBatch[b] = {
      testIdSet:     new Set(applicable.map(t => String(t._id))),
      totalPossible: applicable.reduce((s, t) => s + (t.totalMarks || 0), 0),
      totalTests:    applicable.length,
    };
  }
  return byBatch;
}

function groupByUser(results) {
  const map = {};
  for (const r of results) {
    if (!map[r.userId]) map[r.userId] = { userName: r.userName, coachingName: r.coachingName, batch: r.batch, entries: [] };
    map[r.userId].entries.push({ testId: r.testId, obtainedMarks: r.obtainedMarks, timeTaken: r.timeTaken });
  }
  return Object.values(map);
}

function computeLeaderboard(tests, results, batchFilter) {
  const byBatch = buildByBatch(tests);
  const scoped = batchFilter ? results.filter(r => r.batch === batchFilter) : results;
  const rawRows = groupByUser(scoped);

  return rawRows.map(r => {
    const scope = byBatch[r.batch] || { testIdSet: new Set(), totalPossible: 0, totalTests: 0 };
    const validEntries = r.entries.filter(e => scope.testIdSet.has(String(e.testId)));
    const totalObtained = validEntries.reduce((s, e) => s + e.obtainedMarks, 0);
    return {
      name: r.userName, batch: r.batch,
      testsTaken:    validEntries.length,
      totalTests:    scope.totalTests,
      totalObtained,
      totalPossible: scope.totalPossible,
      avgPercentage: scope.totalPossible > 0 ? (totalObtained / scope.totalPossible * 100) : 0,
    };
  }).sort((a, b) => b.avgPercentage - a.avgPercentage);
}

// ── Assertions ───────────────────────────────────────────────────────────
function assertEqual(actual, expected, label) {
  const pass = actual === expected;
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${label}: expected ${expected}, got ${actual}`);
  if (!pass) process.exitCode = 1;
}

console.log('── "All" filter (both students together) ──');
const all = computeLeaderboard(allTests, rawResults, null);
const studentA = all.find(r => r.name === 'Student A');
const studentB = all.find(r => r.name === 'Student B');

assertEqual(studentA.testsTaken, 1, 'Student A testsTaken');
assertEqual(studentA.totalTests, 1, 'Student A totalTests (own applicable count)');
assertEqual(studentA.totalObtained, 4, 'Student A totalObtained');
assertEqual(studentA.totalPossible, 4, 'Student A totalPossible (NOT 76)');
assertEqual(studentA.avgPercentage, 100, 'Student A avgPercentage');

assertEqual(studentB.testsTaken, 2, 'Student B testsTaken');
assertEqual(studentB.totalTests, 2, 'Student B totalTests');
assertEqual(studentB.totalObtained, 19, 'Student B totalObtained');
assertEqual(studentB.totalPossible, 76, 'Student B totalPossible');
assertEqual(studentB.avgPercentage, 25, 'Student B avgPercentage');

console.log('\n── Class 11 filter (only Student A) ──');
const c11 = computeLeaderboard(allTests, rawResults, '11');
assertEqual(c11.length, 1, 'Class 11 row count');
assertEqual(c11[0].avgPercentage, 100, 'Class 11 Student A avgPercentage');

console.log('\n── Class 12 filter (only Student B) ──');
const c12 = computeLeaderboard(allTests, rawResults, '12');
assertEqual(c12.length, 1, 'Class 12 row count');
assertEqual(c12[0].avgPercentage, 25, 'Class 12 Student B avgPercentage');

console.log('\nIf every line above says PASS, the fix matches the exact scenario from the bug report.');

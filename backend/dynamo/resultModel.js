const { GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand, BatchWriteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { db, TABLES } = require('../config/dynamoClient');

/**
 * Replaces backend/models/Result.js. Table: AIITS_Results
 *   PK: userId (= the same Firebase uid used as AIITS_Users' PK)
 *   SK: testId (= AIITS_Tests' testId)
 *   -> a Get on {userId, testId} replaces Mongoose's unique {userId,testId}
 *      index/lookup exactly - same shape, now the actual primary key instead
 *      of a secondary index.
 *   GSI TestIndex:  PK = testId, SK = obtainedMarks (Number)
 *                   - "everyone who took this test, roughly by score" for
 *                   per-test rankings/leaderboard. Tie-breaking by time is
 *                   NOT part of the key (DynamoDB sort keys are single
 *                   attributes) - done client-side after the Query, over
 *                   the same bounded result-set size (students-per-test)
 *                   Mongo was already working with, not a scan.
 *   GSI BatchIndex: PK = batch, SK = testId
 *                   - "every result for this class" - the query the
 *                   cumulative leaderboard needs, run once per batch (3x
 *                   for "All", 1x for a specific class filter).
 *
 * NOTE on the leaderboard math specifically: this is the part that used to
 * be a MongoDB aggregation pipeline ($group/$sum). DynamoDB has no
 * equivalent, so the exact same per-student-applicable-tests logic from
 * routes/leaderboard.js's /class route (fixed earlier this project - a
 * Class 11 student's percentage must be computed against ONLY Class 11's
 * applicable tests, never a combined denominator) is reimplemented in plain
 * JS in that route file, operating on the raw items queryByBatch() returns
 * here. The math itself is unchanged; only where it executes moved from the
 * database engine to application code.
 *
 * PERFORMANCE NOTE (2024 optimization pass):
 * computeRanks() used to fetch and JS-filter EVERY result row for a test on
 * every single submission (twice, counting the separate top-10 fetch that
 * used to live in routes/results.js) - an O(n)-per-submission read pattern
 * that turns "500 students submit around the same time" into O(n^2) total
 * read volume. It now issues small, targeted Select:COUNT queries against
 * the TestIndex GSI's sort key (obtainedMarks), so each rank computation
 * only reads the slice of students who actually beat/tie this score,
 * instead of every result for the test. The rank MATH (same tie-break rule:
 * higher marks wins; equal marks broken by lower timeTaken) is unchanged -
 * only where/how it's computed changed. getTopN() replaces the second full
 * fetch used for the live leaderboard socket ping with a single bounded
 * Query using the GSI's existing descending-marks ordering plus Limit.
 */

// Generic paginated Query - DynamoDB Query only returns up to 1MB per call;
// any query that can return more than one page (this table's per-test or
// per-batch result sets can, once a test has enough students) must follow
// LastEvaluatedKey until it's exhausted, or results/counts get silently
// truncated.
async function queryAll(params) {
  let items = [];
  let count = 0;
  let key;
  do {
    if (key) params.ExclusiveStartKey = key;
    const r = await db.send(new QueryCommand(params));
    if (r.Items) items = items.concat(r.Items);
    if (typeof r.Count === 'number') count += r.Count;
    key = r.LastEvaluatedKey;
  } while (key);
  return { items: items, count: count };
}

// Same pagination handling for Scan (countSubmitted below).
async function scanAll(params) {
  let items = [];
  let count = 0;
  let key;
  do {
    if (key) params.ExclusiveStartKey = key;
    const r = await db.send(new ScanCommand(params));
    if (r.Items) items = items.concat(r.Items);
    if (typeof r.Count === 'number') count += r.Count;
    key = r.LastEvaluatedKey;
  } while (key);
  return { items: items, count: count };
}

async function getByUserAndTest(userId, testId) {
  const r = await db.send(new GetCommand({ TableName: TABLES.RESULTS, Key: { userId, testId } }));
  return r.Item || null;
}

async function queryByUser(userId) {
  const { items } = await queryAll({
    TableName: TABLES.RESULTS, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId },
  });
  return items;
}

async function queryByTest(testId, opts) {
  opts = opts || {};
  const params = {
    TableName: TABLES.RESULTS, IndexName: 'TestIndex',
    KeyConditionExpression: 'testId = :t', ExpressionAttributeValues: { ':t': testId },
    ScanIndexForward: false,
  };
  if (opts.batch) {
    params.FilterExpression = '#batch = :b';
    params.ExpressionAttributeNames = { '#batch': 'batch' };
    params.ExpressionAttributeValues[':b'] = opts.batch;
  }
  const { items } = await queryAll(params);
  return items;
}

async function queryByBatch(batch) {
  const { items } = await queryAll({
    TableName: TABLES.RESULTS, IndexName: 'BatchIndex',
    KeyConditionExpression: '#batch = :b',
    ExpressionAttributeNames: { '#batch': 'batch' },
    ExpressionAttributeValues: { ':b': batch },
  });
  return items;
}

// Exact top-N for the live "someone just submitted" leaderboard ping over
// Socket.IO — NOT an approximation. In-progress items structurally never
// appear in TestIndex to begin with (obtainedMarks, the GSI's sort key, is
// only ever set by submit() — saveProgress() never writes it — so a DynamoDB
// GSI is sparse: an item is only projected into it once it has both the
// GSI's partition AND sort key attributes), and the conditional
// saveProgress() below now makes it impossible for a completed result to be
// flipped back to inProgress afterward, so that invariant actually holds in
// practice. The inProgress filter is kept anyway as a second, independent
// safety net rather than relying solely on that structural guarantee.
//
// Exactness: TestIndex is already sorted by obtainedMarks descending. We
// page through it (ScanIndexForward:false) and can stop as soon as we're
// PROVABLY past the point where any later item could still affect the top N
// — specifically, once the current page's last item has obtainedMarks
// strictly less than the Nth-ranked item accumulated so far. Because the
// GSI returns items in non-increasing obtainedMarks order, every item on
// every later page also has obtainedMarks <= that page's last item, i.e.
// strictly less than the Nth item's marks — so none of them can be tied
// with (let alone beat) anyone currently occupying a top-N spot, and the
// entire tie-bucket at the boundary has therefore already been read in
// full. No fixed buffer, no truncation — if fewer than N completed results
// exist at all, every page gets read (LastEvaluatedKey exhausted) and the
// full set is returned.
async function getTopN(testId, n) {
  let accumulated = [];
  let key;
  const PAGE_SIZE = Math.max(n, 100); // bigger than n so the common case finishes in one page; not a correctness bound, just a fetch-size tuning knob
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLES.RESULTS, IndexName: 'TestIndex',
      KeyConditionExpression: 'testId = :t', ExpressionAttributeValues: { ':t': testId },
      ScanIndexForward: false, Limit: PAGE_SIZE, ExclusiveStartKey: key,
    }));
    const pageItems = (r.Items || []).filter(function (x) { return !x.inProgress; });
    accumulated = accumulated.concat(pageItems);
    key = r.LastEvaluatedKey;

    if (pageItems.length && accumulated.length >= n) {
      accumulated.sort(function (a, b) { return (b.obtainedMarks - a.obtainedMarks) || (a.timeTaken - b.timeTaken); });
      const boundaryMarks = accumulated[n - 1].obtainedMarks;
      const lastPageMarks = pageItems[pageItems.length - 1].obtainedMarks;
      if (lastPageMarks < boundaryMarks) break; // proven: nothing on any further page can enter or reorder the top N
    }
  } while (key);

  accumulated.sort(function (a, b) { return (b.obtainedMarks - a.obtainedMarks) || (a.timeTaken - b.timeTaken); });
  return accumulated.slice(0, n);
}

// Only succeeds while the result is still in-progress (or doesn't exist
// yet) — see the comment on submit() below for why this matters: without
// it, a Save & Next request that was delayed on the network (slow
// connection, request queued behind others, etc.) and arrives AFTER the
// student has already finished and submitted could silently flip a
// completed, graded result back to inProgress:true, corrupting a finished
// attempt and making it disappear from that student's own results page
// (/results/my/:testId treats inProgress results as "not found"). The
// condition makes that specific request fail instead of applying — the
// caller (routes/tests.js) treats a ConditionalCheckFailedException here as
// "ignore, the exam for this student is already over," not an error.
async function saveProgress(userId, testId, fields) {
  const names = {}, values = {}, sets = ['inProgress = :true'];
  values[':true'] = true;
  for (const k in fields) {
    names['#' + k] = k; values[':' + k] = fields[k]; sets.push('#' + k + ' = :' + k);
  }
  try {
    await db.send(new UpdateCommand({
      TableName: TABLES.RESULTS, Key: { userId, testId },
      UpdateExpression: 'SET ' + sets.join(', '),
      ConditionExpression: 'attribute_not_exists(userId) OR inProgress = :true',
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const stale = new Error('This test was already submitted; this save was ignored.');
      stale.alreadySubmitted = true;
      throw stale;
    }
    throw err;
  }
}

// Idempotent, atomic final submit. ConditionExpression means this write
// only succeeds if no result row exists yet for this user+test, or the
// existing row is still inProgress (i.e. this really is the first final
// submission) - closing the double-click / client-retry / duplicate-request
// race that a plain read-then-write check can't close. Callers should catch
// err.alreadySubmitted and treat it as a safe idempotent response (return
// err.existing), not an error, since a legitimate retry after a lost
// response must land here too.
async function submit(userId, testId, resultData) {
  const now = new Date().toISOString();
  const item = Object.assign({ userId: userId, testId: testId }, resultData, { inProgress: false, savedAnswers: {}, createdAt: now, updatedAt: now });
  try {
    await db.send(new PutCommand({
      TableName: TABLES.RESULTS, Item: item,
      ConditionExpression: 'attribute_not_exists(userId) OR inProgress = :true',
      ExpressionAttributeValues: { ':true': true },
    }));
    return item;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      const existing = await getByUserAndTest(userId, testId);
      const dup = new Error('Result already submitted');
      dup.alreadySubmitted = true;
      dup.existing = existing;
      throw dup;
    }
    throw err;
  }
}

// Total submitted-result count for a test (optionally restricted to a
// batch) - used for "X participants" display. COUNT-only, no item data
// transferred, instead of fetching every result row just to call
// .length on it. attribute_not_exists(inProgress) OR inProgress = :false
// is defensive belt-and-suspenders (see getTopN's comment on why
// in-progress items shouldn't reach here structurally) — kept explicit so
// correctness doesn't silently depend on that invariant continuing to hold
// if the schema ever changes.
async function countForTest(testId, batch) {
  const values = { ':t': testId, ':false': false };
  let filter = '(attribute_not_exists(inProgress) OR inProgress = :false)';
  const names = {};
  const params = {
    TableName: TABLES.RESULTS, IndexName: 'TestIndex', Select: 'COUNT',
    KeyConditionExpression: 'testId = :t', ExpressionAttributeValues: values,
  };
  if (batch) {
    names['#batch'] = 'batch';
    values[':b'] = batch;
    filter += ' AND #batch = :b';
  }
  params.FilterExpression = filter;
  if (Object.keys(names).length) params.ExpressionAttributeNames = names;
  const { count } = await queryAll(params);
  return count;
}

// Counts results for testId with obtainedMarks strictly greater than
// `marks`, optionally restricted to one batch. Uses the TestIndex GSI's
// sort key (obtainedMarks) as a range condition so DynamoDB only walks the
// slice of students who actually beat this score, instead of the whole
// test's results. inProgress is filtered explicitly (see comment above) —
// exact rank calculations must never count an in-progress attempt.
async function countGreater(testId, marks, batch) {
  const values = { ':t': testId, ':m': marks, ':false': false };
  let filter = '(attribute_not_exists(inProgress) OR inProgress = :false)';
  const names = {};
  if (batch) {
    names['#batch'] = 'batch';
    values[':b'] = batch;
    filter += ' AND #batch = :b';
  }
  const params = {
    TableName: TABLES.RESULTS, IndexName: 'TestIndex', Select: 'COUNT',
    KeyConditionExpression: 'testId = :t AND obtainedMarks > :m',
    FilterExpression: filter,
    ExpressionAttributeValues: values,
  };
  if (Object.keys(names).length) params.ExpressionAttributeNames = names;
  const { count } = await queryAll(params);
  return count;
}

// Counts results tied on obtainedMarks but with a strictly faster timeTaken
// (the tie-break rule) - same score bucket only, a small slice rather than
// the whole test. inProgress excluded explicitly, same reasoning as above.
async function countTiedFaster(testId, marks, timeTaken, batch) {
  const names = {};
  const values = { ':t': testId, ':m': marks, ':tt': timeTaken, ':false': false };
  let filter = 'timeTaken < :tt AND (attribute_not_exists(inProgress) OR inProgress = :false)';
  if (batch) {
    names['#batch'] = 'batch';
    values[':b'] = batch;
    filter += ' AND #batch = :b';
  }
  const params = {
    TableName: TABLES.RESULTS, IndexName: 'TestIndex', Select: 'COUNT',
    KeyConditionExpression: 'testId = :t AND obtainedMarks = :m',
    FilterExpression: filter,
    ExpressionAttributeValues: values,
  };
  if (Object.keys(names).length) params.ExpressionAttributeNames = names;
  const { count } = await queryAll(params);
  return count;
}

// Rank rules are UNCHANGED: 1 + (everyone COMPLETED with strictly higher
// marks) + (everyone COMPLETED tied on marks with a strictly faster time).
// Only the mechanism changed - four small targeted counts (run in
// parallel) instead of fetching and JS-filtering every result row for the
// test.
async function computeRanks(testId, batch, obtainedMarks, timeTaken) {
  const counts = await Promise.all([
    countGreater(testId, obtainedMarks),
    countTiedFaster(testId, obtainedMarks, timeTaken),
    countGreater(testId, obtainedMarks, batch),
    countTiedFaster(testId, obtainedMarks, timeTaken, batch),
  ]);
  return {
    overallRank: counts[0] + counts[1] + 1,
    batchRank: counts[2] + counts[3] + 1,
  };
}

// Post-write rank reconciliation. See the long comment in routes/results.js
// for the concurrency reasoning: computeRanks() run BEFORE this student's
// own write can undercount siblings who finish writing in the gap between
// that read and this write (including, first and foremost, this student's
// OWN row, which by definition doesn't exist yet at read time). Calling
// computeRanks() again immediately after a successful write closes that
// specific gap - the state read now is guaranteed to include this
// student's own just-written row, plus anyone else who completed before
// this exact moment - and the result is written back with a plain
// (unconditional-on-content) UpdateCommand keyed by the primary key, which
// only ever touches this one student's own item.
async function reconcileRank(userId, testId, batch, obtainedMarks, timeTaken) {
  const { overallRank, batchRank } = await computeRanks(testId, batch, obtainedMarks, timeTaken);
  await db.send(new UpdateCommand({
    TableName: TABLES.RESULTS, Key: { userId, testId },
    UpdateExpression: 'SET #rank = :r, batchRank = :br',
    ExpressionAttributeNames: { '#rank': 'rank' },
    ExpressionAttributeValues: { ':r': overallRank, ':br': batchRank },
  }));
  return { overallRank, batchRank };
}

async function applyBonusToTest(testId, delta) {
  const results = (await queryByTest(testId)).filter(function(r){ return !r.inProgress; });
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    await db.send(new UpdateCommand({
      TableName: TABLES.RESULTS, Key: { userId: r.userId, testId: testId },
      UpdateExpression: 'SET obtainedMarks = obtainedMarks + :d, bonusMarks = :b, updatedAt = :now',
      ExpressionAttributeValues: { ':d': delta, ':b': (r.bonusMarks != null ? r.bonusMarks + delta : delta), ':now': new Date().toISOString() },
    }));
  }
  return results.length;
}

async function applyBonusToOne(userId, testId, bonusMarks) {
  const existing = await getByUserAndTest(userId, testId);
  if (!existing) return null;
  const delta = bonusMarks - (existing.bonusMarks || 0);
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.RESULTS, Key: { userId, testId },
    UpdateExpression: 'SET obtainedMarks = obtainedMarks + :d, bonusMarks = :b, updatedAt = :now',
    ExpressionAttributeValues: { ':d': delta, ':b': bonusMarks, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  return r.Attributes;
}

async function deleteByTest(testId, batch) {
  const results = await queryByTest(testId, batch && batch !== 'all' ? { batch: batch } : {});
  const chunks = [];
  for (let i = 0; i < results.length; i += 25) chunks.push(results.slice(i, i + 25));
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    await db.send(new BatchWriteCommand({
      RequestItems: {
        [TABLES.RESULTS]: chunk.map(function(r){ return { DeleteRequest: { Key: { userId: r.userId, testId: r.testId } } }; }),
      },
    }));
  }
  return results;
}

async function deleteAllByUser(userId) {
  const results = await queryByUser(userId);
  const chunks = [];
  for (let i = 0; i < results.length; i += 25) chunks.push(results.slice(i, i + 25));
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    await db.send(new BatchWriteCommand({
      RequestItems: {
        [TABLES.RESULTS]: chunk.map(function(r){ return { DeleteRequest: { Key: { userId: r.userId, testId: r.testId } } }; }),
      },
    }));
  }
  return results.length;
}

async function countSubmitted() {
  const { count } = await scanAll({
    TableName: TABLES.RESULTS, Select: 'COUNT',
    FilterExpression: 'inProgress = :f', ExpressionAttributeValues: { ':f': false },
  });
  return count;
}

module.exports = {
  getByUserAndTest: getByUserAndTest, queryByUser: queryByUser, queryByTest: queryByTest, queryByBatch: queryByBatch,
  getTopN: getTopN, countForTest: countForTest,
  saveProgress: saveProgress, submit: submit, computeRanks: computeRanks, reconcileRank: reconcileRank,
  applyBonusToTest: applyBonusToTest, applyBonusToOne: applyBonusToOne, deleteByTest: deleteByTest, deleteAllByUser: deleteAllByUser,
  countSubmitted: countSubmitted,
};

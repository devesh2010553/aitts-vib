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
 */

async function getByUserAndTest(userId, testId) {
  const r = await db.send(new GetCommand({ TableName: TABLES.RESULTS, Key: { userId, testId } }));
  return r.Item || null;
}

async function queryByUser(userId) {
  const r = await db.send(new QueryCommand({
    TableName: TABLES.RESULTS, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId },
  }));
  return r.Items || [];
}

async function queryByTest(testId, opts) {
  opts = opts || {};
  const params = {
    TableName: TABLES.RESULTS, IndexName: 'TestIndex',
    KeyConditionExpression: 'testId = :t', ExpressionAttributeValues: { ':t': testId },
    ScanIndexForward: false,
  };
  if (opts.batch) {
    params.FilterExpression = 'batch = :b';
    params.ExpressionAttributeValues[':b'] = opts.batch;
  }
  const r = await db.send(new QueryCommand(params));
  return r.Items || [];
}

async function queryByBatch(batch) {
  const r = await db.send(new QueryCommand({
    TableName: TABLES.RESULTS, IndexName: 'BatchIndex',
    KeyConditionExpression: 'batch = :b', ExpressionAttributeValues: { ':b': batch },
  }));
  return r.Items || [];
}

async function saveProgress(userId, testId, fields) {
  const names = {}, values = {}, sets = ['inProgress = :true'];
  values[':true'] = true;
  for (const k in fields) {
    names['#' + k] = k; values[':' + k] = fields[k]; sets.push('#' + k + ' = :' + k);
  }
  await db.send(new UpdateCommand({
    TableName: TABLES.RESULTS, Key: { userId, testId },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }));
}

async function submit(userId, testId, resultData) {
  const now = new Date().toISOString();
  const item = Object.assign({ userId: userId, testId: testId }, resultData, { inProgress: false, savedAnswers: {}, createdAt: now, updatedAt: now });
  await db.send(new PutCommand({ TableName: TABLES.RESULTS, Item: item }));
  return item;
}

async function computeRanks(testId, batch, obtainedMarks, timeTaken) {
  const all = (await queryByTest(testId)).filter(function(r){ return !r.inProgress; });
  function beats(r) { return r.obtainedMarks > obtainedMarks || (r.obtainedMarks === obtainedMarks && r.timeTaken < timeTaken); }
  const overallRank = all.filter(beats).length + 1;
  const batchRank = all.filter(function(r){ return r.batch === batch && beats(r); }).length + 1;
  return { overallRank: overallRank, batchRank: batchRank };
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
  const r = await db.send(new ScanCommand({
    TableName: TABLES.RESULTS, Select: 'COUNT',
    FilterExpression: 'inProgress = :f', ExpressionAttributeValues: { ':f': false },
  }));
  return r.Count || 0;
}

module.exports = {
  getByUserAndTest: getByUserAndTest, queryByUser: queryByUser, queryByTest: queryByTest, queryByBatch: queryByBatch,
  saveProgress: saveProgress, submit: submit, computeRanks: computeRanks,
  applyBonusToTest: applyBonusToTest, applyBonusToOne: applyBonusToOne, deleteByTest: deleteByTest, deleteAllByUser: deleteAllByUser,
  countSubmitted: countSubmitted,
};

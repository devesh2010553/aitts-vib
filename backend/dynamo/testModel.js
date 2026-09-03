const crypto = require('crypto');
const { GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { db, TABLES } = require('../config/dynamoClient');

/**
 * Replaces backend/models/Test.js. Table: AIITS_Tests
 *   PK: testId (generated here, replaces Mongo's auto _id — every place
 *       that used to reference `Test._id` as an ObjectId now uses this
 *       string instead; Result.testId is the same string)
 *   GSI PublishedIndex: PK = isPublished (stored as the STRING 'true'/'false'
 *       — DynamoDB key attributes can't be boolean), SK = createdAt (ISO
 *       string) — supports the dashboard's "list published, active tests,
 *       newest first" query without a full table scan.
 *
 * Questions/options get their own generated ids (questionId/optionId) here,
 * replacing the _id Mongoose used to auto-assign to embedded subdocuments —
 * Result.answers[].questionId and grading logic reference these the same
 * way they referenced the old ObjectIds.
 */

function genId(prefix) { return `${prefix}_${crypto.randomUUID()}`; }

// DynamoDB Query/Scan only return up to 1MB per call — test items can be
// large (embedded questions + base64 images), so a full-table listing can
// span multiple pages even with a modest number of tests. Follow
// LastEvaluatedKey until it's exhausted instead of silently truncating.
async function queryAllPaged(params) {
  let items = [];
  let key;
  do {
    if (key) params.ExclusiveStartKey = key;
    const r = await db.send(new QueryCommand(params));
    if (r.Items) items = items.concat(r.Items);
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

async function scanAllPaged(params) {
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

function normalizeQuestions(questions) {
  return (questions || []).map(q => ({
    questionId: q.questionId || genId('q'),
    questionText: q.questionText || '',
    questionImage: q.questionImage || '',
    options: (q.options || []).map(o => ({
      optionId: o.optionId || genId('o'),
      text: o.text || '', isCorrect: !!o.isCorrect, imageData: o.imageData || '',
    })),
    isMultiChoice: !!q.isMultiChoice,
    correctOptions: q.correctOptions || [],
    marks: typeof q.marks === 'number' ? q.marks : 4,
    negativeMarks: typeof q.negativeMarks === 'number' ? q.negativeMarks : 1,
    explanation: q.explanation || '',
  }));
}

async function getById(testId) {
  const r = await db.send(new GetCommand({ TableName: TABLES.TESTS, Key: { testId } }));
  return r.Item || null;
}

// Metadata-only read — no questions/options/images. For callers (e.g.
// save-progress's batch-eligibility check) that only need a couple of
// invariant fields and would otherwise pay to fetch+deserialize the whole
// question bank (with embedded images) on every call.
async function getMeta(testId) {
  const r = await db.send(new GetCommand({
    TableName: TABLES.TESTS, Key: { testId },
    ProjectionExpression: 'testId, targetBatches, isActive, isPublished, adEnabled, adImages, adRedirectUrl, adHtml',
  }));
  return r.Item || null;
}

// In-process cache for the FULL test object (questions + images), used
// ONLY by the grading path (routes/results.js /submit). A submission spike
// (e.g. 500 students submitting the same test within a few seconds) would
// otherwise issue that many near-simultaneous full GetItem calls for the
// exact same, unchanging item against local DynamoDB — real, avoidable
// CPU/disk load on the modest local hardware this app targets. Short TTL
// as a safety net even if an invalidation call below is ever missed;
// explicit invalidation on every content-changing write means the TTL
// almost never actually has to be relied on in practice. NOT invalidated
// by incrementAttemptCount/setAttemptCount — those only change a display
// counter grading never reads, so invalidating on every single submission
// (constantly, during exactly the spike this exists to absorb) would
// defeat the purpose. Admin-facing reads never go through this — GET
// /:id, the admin test list, etc. all still call getById() directly and
// always see the true current state; only grading trades a few seconds of
// staleness for not re-reading unchanging data hundreds of times over.
const GRADING_CACHE_TTL_MS = 5000;
const gradingCache = new Map();   // testId -> { test, expiresAt }
const gradingInFlight = new Map(); // testId -> Promise, collapses a cold-start stampede into one GetItem

function invalidateGradingCache(testId) {
  gradingCache.delete(testId);
}

async function getForGrading(testId) {
  const cached = gradingCache.get(testId);
  if (cached && cached.expiresAt > Date.now()) return cached.test;
  const existing = gradingInFlight.get(testId);
  if (existing) return existing;
  const p = (async () => {
    try {
      const test = await getById(testId);
      if (test) gradingCache.set(testId, { test, expiresAt: Date.now() + GRADING_CACHE_TTL_MS });
      return test;
    } finally {
      gradingInFlight.delete(testId);
    }
  })();
  gradingInFlight.set(testId, p);
  return p;
}

async function create(data) {
  const now = new Date().toISOString();
  const questions = normalizeQuestions(data.questions);
  const item = {
    testId: genId('test'),
    title: data.title, subject: data.subject, topic: data.topic, description: data.description || '',
    duration: data.duration,
    questions,
    totalMarks: questions.reduce((s, q) => s + q.marks, 0),
    questionCount: questions.length,
    isActive: data.isActive !== false,
    isPublished: data.isPublished ? 'true' : 'false', // GSI key — see table doc above
    startTime: data.startTime || null, endTime: data.endTime || null,
    adEnabled: !!data.adEnabled, adImages: data.adImages || [], // AdImage string ids — AdImage itself stays on MongoDB (see backend/models/AdImage.js), fetched by id directly, same pattern as before
    adRedirectUrl: data.adRedirectUrl || '', adHtml: data.adHtml || '',
    attemptCount: 0, targetBatches: data.targetBatches || [], bonusMarks: 0,
    createdAt: now, updatedAt: now,
  };
  await db.send(new PutCommand({ TableName: TABLES.TESTS, Item: item }));
  return item;
}

async function update(testId, data) {
  const existing = await getById(testId);
  if (!existing) return null;
  const questions = data.questions ? normalizeQuestions(data.questions) : existing.questions;
  const item = {
    ...existing,
    title: data.title ?? existing.title, subject: data.subject ?? existing.subject,
    topic: data.topic ?? existing.topic, description: data.description ?? existing.description,
    duration: data.duration ?? existing.duration,
    questions,
    totalMarks: questions.reduce((s, q) => s + q.marks, 0),
    questionCount: questions.length,
    isActive: data.isActive ?? existing.isActive,
    isPublished: data.isPublished != null ? (data.isPublished ? 'true' : 'false') : existing.isPublished,
    startTime: data.startTime ?? existing.startTime, endTime: data.endTime ?? existing.endTime,
    adEnabled: data.adEnabled ?? existing.adEnabled, adImages: data.adImages ?? existing.adImages,
    adRedirectUrl: data.adRedirectUrl ?? existing.adRedirectUrl, adHtml: data.adHtml ?? existing.adHtml,
    targetBatches: data.targetBatches ?? existing.targetBatches,
    updatedAt: new Date().toISOString(),
  };
  await db.send(new PutCommand({ TableName: TABLES.TESTS, Item: item }));
  invalidateGradingCache(testId);
  return item;
}

async function setPublished(testId, isPublished) {
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'SET isPublished = :p, updatedAt = :now',
    ExpressionAttributeValues: { ':p': isPublished ? 'true' : 'false', ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  invalidateGradingCache(testId);
  return r.Attributes;
}

async function incrementAttemptCount(testId) {
  await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'ADD attemptCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}

async function setBonusMarks(testId, bonusMarks) {
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'SET bonusMarks = :b, updatedAt = :now',
    ExpressionAttributeValues: { ':b': bonusMarks, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  invalidateGradingCache(testId);
  return r.Attributes;
}

/** Dashboard list — published+active tests, newest first. Uses PublishedIndex
 *  so this never scans the whole table, no matter how many draft/old tests
 *  accumulate over time. isActive is filtered client-side after the Query
 *  (it's not part of the key — a small filter over an already-narrow result
 *  set from the GSI, not a full scan). */
async function listPublished() {
  const items = await queryAllPaged({
    TableName: TABLES.TESTS, IndexName: 'PublishedIndex',
    KeyConditionExpression: 'isPublished = :p', ExpressionAttributeValues: { ':p': 'true' },
    ScanIndexForward: false,
  });
  return items.filter(t => t.isActive !== false);
}

/** Admin's full test list — every test regardless of status. Scan is fine
 *  here (admin-only, low traffic, same reasoning as userModel.scanAll). */
async function scanAll() {
  const { items } = await scanAllPaged({ TableName: TABLES.TESTS });
  return items;
}

async function deleteById(testId) {
  await db.send(new DeleteCommand({ TableName: TABLES.TESTS, Key: { testId } }));
  invalidateGradingCache(testId);
}

async function count() {
  const { count: c } = await scanAllPaged({ TableName: TABLES.TESTS, Select: 'COUNT' });
  return c;
}

async function setAttemptCount(testId, count) {
  await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'SET attemptCount = :c, updatedAt = :now',
    ExpressionAttributeValues: { ':c': count, ':now': new Date().toISOString() },
  }));
}

module.exports = { getById, getMeta, getForGrading, create, update, setPublished, incrementAttemptCount, setAttemptCount, setBonusMarks, listPublished, scanAll, deleteById, genId, count };

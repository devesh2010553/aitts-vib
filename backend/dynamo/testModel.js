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
  return item;
}

async function setPublished(testId, isPublished) {
  const r = await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'SET isPublished = :p, updatedAt = :now',
    ExpressionAttributeValues: { ':p': isPublished ? 'true' : 'false', ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
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
  return r.Attributes;
}

/** Dashboard list — published+active tests, newest first. Uses PublishedIndex
 *  so this never scans the whole table, no matter how many draft/old tests
 *  accumulate over time. isActive is filtered client-side after the Query
 *  (it's not part of the key — a small filter over an already-narrow result
 *  set from the GSI, not a full scan). */
async function listPublished() {
  const r = await db.send(new QueryCommand({
    TableName: TABLES.TESTS, IndexName: 'PublishedIndex',
    KeyConditionExpression: 'isPublished = :p', ExpressionAttributeValues: { ':p': 'true' },
    ScanIndexForward: false,
  }));
  return (r.Items || []).filter(t => t.isActive !== false);
}

/** Admin's full test list — every test regardless of status. Scan is fine
 *  here (admin-only, low traffic, same reasoning as userModel.scanAll). */
async function scanAll() {
  const r = await db.send(new ScanCommand({ TableName: TABLES.TESTS }));
  return r.Items || [];
}

async function deleteById(testId) {
  await db.send(new DeleteCommand({ TableName: TABLES.TESTS, Key: { testId } }));
}

async function count() {
  const r = await db.send(new ScanCommand({ TableName: TABLES.TESTS, Select: 'COUNT' }));
  return r.Count || 0;
}

async function setAttemptCount(testId, count) {
  await db.send(new UpdateCommand({
    TableName: TABLES.TESTS, Key: { testId },
    UpdateExpression: 'SET attemptCount = :c, updatedAt = :now',
    ExpressionAttributeValues: { ':c': count, ':now': new Date().toISOString() },
  }));
}

module.exports = { getById, create, update, setPublished, incrementAttemptCount, setAttemptCount, setBonusMarks, listPublished, scanAll, deleteById, genId, count };

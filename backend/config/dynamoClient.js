const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

// Single shared DynamoDB connection for the three collections moved off
// MongoDB: UserProfile, Test, Result (see backend/dynamo/*.js). Everything
// else (chat, ad images, PDF imports, the leaderboard cache, forgot-password
// attempts) stays on MongoDB — see backend/config/chatDb.js and the main
// mongoose.connect() in server.js, both untouched by this migration.
const REQUIRED = ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[DYNAMO] Missing env vars:', missing.join(', '), '— see DYNAMODB_SETUP.md');
}

// requestHandler / maxAttempts, reasoned for THIS deployment specifically
// (single Node process + DynamoDB Local, both on the same machine, target
// hardware ~i5/16GB/512GB SSD) — not generic "make it big" numbers:
//   - maxAttempts: 3 (1 try + 2 retries). Local DynamoDB has no real
//     throttling to retry through — a failure here is almost always a
//     genuine transient hiccup (e.g. brief resource contention on the same
//     machine), and the SDK's default retry strategy already backs off
//     with jitter between attempts. Deliberately NOT set higher: against a
//     single local process, a burst of failures under heavy load (e.g. the
//     literal 500-submit-at-once spike) retrying 4+ times each would be
//     retry AMPLIFICATION working against the same already-loaded process,
//     making a temporary slowdown worse instead of absorbing it.
//   - maxSockets: 128. Node's http keep-alive agent reuses connections
//     across requests, and on localhost a round trip is sub-millisecond —
//     one connection serves many sequential requests, not one request each.
//     128 gives real headroom above what a single Node process handling a
//     500-1000-concurrent-student spike should realistically have
//     in-flight to DynamoDB at any one instant, without opening far more
//     concurrent sockets than this machine's connection-handling capacity
//     usefully supports. Not the earlier, less-justified 250.
const rawClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    socketTimeout: 8000,
    httpsAgent: { maxSockets: 128, keepAlive: true },
    httpAgent: { maxSockets: 128, keepAlive: true },
  }),
});

// marshallOptions.removeUndefinedValues: DynamoDB's raw API rejects
// `undefined` attribute values outright (unlike Mongoose, which just omits
// them) — this is the single most common source of a surprise runtime error
// when porting Mongoose-style "just build an object with optional fields"
// code, so it's turned off here at the client level once, rather than
// requiring every call site to remember to strip undefined fields itself.
const db = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLES = {
  USERS:   process.env.DYNAMODB_TABLE_USERS   || 'AIITS_Users',
  TESTS:   process.env.DYNAMODB_TABLE_TESTS   || 'AIITS_Tests',
  RESULTS: process.env.DYNAMODB_TABLE_RESULTS || 'AIITS_Results',
};

module.exports = { db, TABLES };

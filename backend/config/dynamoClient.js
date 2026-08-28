const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

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

const rawClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
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

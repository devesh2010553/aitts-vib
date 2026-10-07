/**
 * scripts/loadtest/setup-students.js
 *
 * Provisions N real student accounts against a TARGET deployment for load
 * testing, and writes their ID tokens to students.json for k6 to read.
 *
 * WHY THIS EXISTS: authenticateStudent (backend/middleware/auth.js) verifies
 * a real Firebase ID token on every request via admin.auth().verifyIdToken().
 * There is no test/bypass auth path in this codebase (correctly — don't add
 * one), so a load test needs real accounts and real tokens, not synthetic
 * bearer strings.
 *
 * DO NOT run this against your production Firebase project / production
 * DynamoDB tables. Point it at a staging Firebase project and a staging
 * deployment (see README.md in this folder). It creates real Firebase Auth
 * users and real AIITS_Users / AIITS_Results rows.
 *
 * Required env vars:
 *   FIREBASE_SERVICE_ACCOUNT_JSON   same value your server uses (Admin SDK)
 *   FIREBASE_API_KEY                Web API key for the SAME Firebase project
 *                                    (Firebase console -> Project settings ->
 *                                    General -> Web API Key) — needed to sign
 *                                    in via the REST API and get an ID token,
 *                                    since the Admin SDK itself only creates
 *                                    accounts, it can't sign in as one.
 *   TARGET_BASE_URL                 e.g. https://staging.example.com
 *   STUDENT_COUNT                   how many accounts to provision (default 500)
 *   STUDENT_BATCH                   '11' | '12' | 'dropper' (default '11') —
 *                                    keep all load-test students in one
 *                                    batch so the test also exercises batch
 *                                    ranking, not just overall ranking
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT_JSON='...' FIREBASE_API_KEY=xxx \
 *     TARGET_BASE_URL=https://staging.example.com STUDENT_COUNT=500 \
 *     node scripts/loadtest/setup-students.js
 *
 * Re-running is safe: /auth/register already handles "account already
 * exists" for a uid, and this script skips accounts whose Firebase user
 * already exists (matched by email) by just signing in instead of
 * re-creating.
 */
const admin = require('firebase-admin');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TARGET_BASE_URL;
const API_KEY = process.env.FIREBASE_API_KEY;
const COUNT = parseInt(process.env.STUDENT_COUNT || '500', 10);
const BATCH = process.env.STUDENT_BATCH || '11';
const OUT_FILE = path.join(__dirname, 'students.json');
const RUN_TAG = process.env.LOADTEST_TAG || 'loadtest'; // namespacing so re-runs / different runs don't collide on email

if (!BASE_URL || !API_KEY) {
  console.error('Set TARGET_BASE_URL and FIREBASE_API_KEY (see comment header in this file).');
  process.exit(1);
}
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error('Set FIREBASE_SERVICE_ACCOUNT_JSON to the same value your server uses.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
}

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function signIn(email, password) {
  const r = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    email, password, returnSecureToken: true,
  });
  if (r.status !== 200) throw new Error('sign-in failed for ' + email + ': ' + JSON.stringify(r.body));
  return r.body; // { idToken, refreshToken, localId, ... }
}

async function ensureFirebaseUser(email, password) {
  try {
    const u = await admin.auth().getUserByEmail(email);
    return u;
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    return admin.auth().createUser({ email, password, emailVerified: true });
  }
}

async function registerProfile(idToken, i) {
  const body = {
    idToken,
    name: `LoadTest Student ${i}`,
    phone: `9${String(7000000000 + i)}`.slice(0, 10),
    coachingName: 'LoadTest Coaching',
    fatherName: 'LoadTest Father',
    fatherOccupation: 'Load Testing',
    whatsappNumber: `9${String(7000000000 + i)}`.slice(0, 10),
    batch: BATCH,
  };
  const r = await postJson(`${BASE_URL}/api/auth/register`, body);
  // 201 = created, 200 with "Account already exists" = fine, both OK to continue
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`register failed for student ${i}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

async function main() {
  console.log(`Provisioning ${COUNT} student accounts (batch=${BATCH}) against ${BASE_URL} ...`);
  const students = [];
  const CONCURRENCY = 20; // provisioning itself shouldn't hammer Firebase/the target — this is setup, not the test
  let i = 0;
  async function worker() {
    while (i < COUNT) {
      const idx = i++;
      const email = `${RUN_TAG}.student${idx}@example.test`;
      const password = 'LoadTest!12345';
      try {
        await ensureFirebaseUser(email, password);
        const signInResult = await signIn(email, password);
        await registerProfile(signInResult.idToken, idx);
        students.push({ index: idx, email, uid: signInResult.localId, idToken: signInResult.idToken, refreshToken: signInResult.refreshToken });
        if (students.length % 50 === 0) console.log(`  ${students.length}/${COUNT} provisioned`);
      } catch (err) {
        console.error(`  student ${idx} FAILED:`, err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(OUT_FILE, JSON.stringify(students, null, 2));
  console.log(`\nDone. ${students.length}/${COUNT} accounts ready. Wrote ${OUT_FILE}`);
  console.log('NOTE: idToken is valid ~1 hour. If your test run is longer, use refresh-token.js (this folder) to refresh before starting k6.');
}

main().catch((e) => { console.error(e); process.exit(1); });

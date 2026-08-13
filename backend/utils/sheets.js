const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');
const MAIN_SHEET_ID   = '1TTMI8-v9Z7kycqTY_d9SmCxErLCKopPuv75anMlRKBc';
const ARCHIVE_TRIGGER = 45000;
const ARCHIVE_CHUNK   = 10000;
const RESULTS_HEADERS = ['SubmittedAt','StudentName','Email','Phone','Batch','CoachingName','TestTitle','Subject','Topic','ObtainedMarks','TotalMarks','Percentage','Correct','Wrong','Skipped','TimeSecs','OverallRank','BatchRank','TestID','UserID'];
const STUDENTS_HEADERS= ['RegisteredAt','Name','Email','Phone','Batch','CoachingName','FatherName','FatherOccupation','WhatsApp','TotalTests','TotalMarks','HighestMarks','UserID'];

function getAuth() {
  let creds;
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try { creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); }
    catch(e) { throw new Error('GOOGLE_CREDENTIALS_JSON invalid JSON: '+e.message); }
  } else {
    const p = path.join(__dirname,'..','..','credentials.json');
    if (!fs.existsSync(p)) throw new Error('No Google credentials. Set GOOGLE_CREDENTIALS_JSON in Render env vars.');
    creds = JSON.parse(fs.readFileSync(p,'utf8'));
  }
  return new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive'] });
}
function gc() { return google.sheets({ version:'v4', auth: getAuth() }); }
function gd() { return google.drive({ version:'v3', auth: getAuth() }); }

async function ensureTab(c, sid, tab) {
  const m = await c.spreadsheets.get({ spreadsheetId: sid });
  if (!m.data.sheets.some(s => s.properties.title === tab)) {
    await c.spreadsheets.batchUpdate({ spreadsheetId: sid, resource: { requests: [{ addSheet: { properties: { title: tab } } }] } });
  }
}
async function rowCount(c, sid, tab) {
  try { const r = await c.spreadsheets.values.get({ spreadsheetId: sid, range: tab+'!A:A' }); return (r.data.values||[]).length; }
  catch(e) { return 0; }
}
async function initTab(c, sid, tab, headers) {
  await ensureTab(c, sid, tab);
  if ((await rowCount(c, sid, tab)) === 0) {
    await c.spreadsheets.values.update({ spreadsheetId: sid, range: tab+'!A1', valueInputOption: 'RAW', resource: { values: [headers] } });
  }
}

function toRow(d) {
  return [
    new Date(d.submittedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),
    d.userName||'', d.userEmail||'', d.userPhone||'', d.batch||'',
    d.coachingName||'', d.testTitle||'', d.subject||'', d.topic||'',
    d.obtainedMarks||0, d.totalMarks||0, d.percentage||0,
    d.correctAnswers||0, d.wrongAnswers||0, d.notAttempted||0,
    d.timeTaken||0, d.rank||'', d.batchRank||'',
    String(d.testId||''), String(d.userId||'')
  ];
}

exports.writeResult = async function(d) {
  try {
    const c = gc(); await initTab(c, MAIN_SHEET_ID, 'Results', RESULTS_HEADERS);
    await c.spreadsheets.values.append({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A:T', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [toRow(d)] } });
    archiveIfNeeded(c).catch(e => console.error('[SHEETS] archive error:', e.message));
    return true;
  } catch(err) { console.error('[SHEETS] writeResult:', err.message); return false; }
};

exports.writeResultsBatch = async function(arr) {
  if (!arr||!arr.length) return true;
  const c = gc(); await initTab(c, MAIN_SHEET_ID, 'Results', RESULTS_HEADERS);
  await c.spreadsheets.values.append({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A:T', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: arr.map(toRow) } });
  archiveIfNeeded(c).catch(e => console.error('[SHEETS] archive error:', e.message));
  return true;
};

exports.writeStudent = async function(d) {
  try {
    const c = gc(); await initTab(c, MAIN_SHEET_ID, 'Students', STUDENTS_HEADERS);
    const res = await c.spreadsheets.values.get({ spreadsheetId: MAIN_SHEET_ID, range: 'Students!A:M' });
    const rows = res.data.values||[];
    let existingRow = -1;
    for (let i=1;i<rows.length;i++) { if (rows[i][12]===String(d.userId)) { existingRow=i+1; break; } }
    const row = [new Date(d.createdAt||Date.now()).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),d.name||'',d.email||'',d.phone||'',d.batch||'',d.coachingName||'',d.fatherName||'',d.fatherOccupation||'',d.whatsappNumber||'',d.totalTests||0,d.totalMarks||0,d.highestMarks||0,String(d.userId||'')];
    if (existingRow > 0) {
      await c.spreadsheets.values.update({ spreadsheetId: MAIN_SHEET_ID, range: 'Students!A'+existingRow, valueInputOption: 'RAW', resource: { values: [row] } });
    } else {
      await c.spreadsheets.values.append({ spreadsheetId: MAIN_SHEET_ID, range: 'Students!A:M', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', resource: { values: [row] } });
    }
    return true;
  } catch(err) { console.error('[SHEETS] writeStudent:', err.message); return false; }
};

exports.readUserResults = async function(userId) {
  try {
    const c = gc();
    const res = await c.spreadsheets.values.get({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A:T' });
    const rows = res.data.values||[];
    return rows.slice(1).filter(r => r[19]===String(userId)).map(r => ({
      submittedAt:r[0],userName:r[1],userEmail:r[2],batch:r[4],testTitle:r[6],subject:r[7],
      obtainedMarks:Number(r[9])||0,totalMarks:Number(r[10])||0,percentage:Number(r[11])||0,
      correctAnswers:Number(r[12])||0,wrongAnswers:Number(r[13])||0,notAttempted:Number(r[14])||0,
      timeTaken:Number(r[15])||0,rank:Number(r[16])||null,batchRank:Number(r[17])||null,
      testId:r[18],userId:r[19]
    }));
  } catch(err) { console.error('[SHEETS] readUserResults:', err.message); return []; }
};


// Read results from sheet for leaderboard (used when MongoDB results are cleared)
exports.readResultsFromSheet = async function(testId) {
  try {
    const c = gc();
    const r = await c.spreadsheets.values.get({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A:T' });
    const rows = r.data.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    const idx = {
      studentName: headers.indexOf('StudentName'),
      email:       headers.indexOf('Email'),
      batch:       headers.indexOf('Batch'),
      coaching:    headers.indexOf('CoachingName'),
      obtained:    headers.indexOf('ObtainedMarks'),
      total:       headers.indexOf('TotalMarks'),
      time:        headers.indexOf('TimeSecs'),
      submitted:   headers.indexOf('SubmittedAt'),
      testId:      headers.indexOf('TestID'),
    };
    return rows.slice(1)
      .filter(row => !testId || row[idx.testId] === testId)
      .map(row => ({
        userName:     row[idx.studentName] || '',
        userEmail:    row[idx.email]       || '',
        batch:        row[idx.batch]       || '',
        coachingName: row[idx.coaching]    || '',
        obtainedMarks:parseFloat(row[idx.obtained]) || 0,
        totalMarks:   parseFloat(row[idx.total])    || 0,
        timeTaken:    parseInt(row[idx.time])        || 0,
        submittedAt:  row[idx.submitted]             || '',
        testId:       row[idx.testId]                || '',
        fromSheet:    true,
      }));
  } catch(err) {
    console.error('[SHEETS] readResultsFromSheet:', err.message);
    return [];
  }
};


// Archive rows for a specific test from Main Sheet → AIITS_Archive sheet,
// then delete those rows from the Main Sheet (frees row limit).
// Called by both delete buttons so neither accumulates rows in the main sheet.
exports.archiveTestResults = async function(testId, batch) {
  try {
    const c = gc();

    // 1. Read ALL rows from main Results tab
    const res = await c.spreadsheets.values.get({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A:T' });
    const allRows = res.data.values || [];
    if (allRows.length < 2) return { archived: 0 };

    const headers = allRows[0];
    const TEST_ID_COL = headers.indexOf('TestID');  // col 18
    const BATCH_COL   = headers.indexOf('Batch');   // col 4

    // 2. Separate rows: matching testId (and optionally batch) vs rest
    const toArchive = [];
    const toKeep    = [];
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      const rowTestId = row[TEST_ID_COL] || '';
      const rowBatch  = row[BATCH_COL]   || '';
      const matchTest  = rowTestId === String(testId);
      const matchBatch = !batch || batch === 'all' || rowBatch === batch;
      if (matchTest && matchBatch) {
        toArchive.push(row);
      } else {
        toKeep.push(row);
      }
    }

    if (!toArchive.length) return { archived: 0 };

    // 3. Get or create AIITS_Archive spreadsheet
    const d = gd();
    let archiveId;
    const search = await d.files.list({
      q: "name='AIITS_Archive' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'files(id)'
    });
    if (search.data.files && search.data.files.length) {
      archiveId = search.data.files[0].id;
    } else {
      const cr = await d.files.create({
        resource: { name: 'AIITS_Archive', mimeType: 'application/vnd.google-apps.spreadsheet' },
        fields: 'id'
      });
      archiveId = cr.data.id;
      if (process.env.ADMIN_EMAIL) {
        await d.permissions.create({
          fileId: archiveId,
          resource: { type: 'user', role: 'writer', emailAddress: process.env.ADMIN_EMAIL }
        }).catch(() => {});
      }
    }

    // 4. Write archived rows to AIITS_Archive
    const ac = gc();
    await initTab(ac, archiveId, 'Results', RESULTS_HEADERS);
    await ac.spreadsheets.values.append({
      spreadsheetId: archiveId,
      range: 'Results!A:T',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: toArchive }
    });

    // 5. Rewrite main sheet Results tab with only the kept rows
    //    (clear everything after header, then write kept rows back)
    const meta = await c.spreadsheets.get({ spreadsheetId: MAIN_SHEET_ID });
    const rs   = meta.data.sheets.find(s => s.properties.title === 'Results');
    if (rs) {
      const sheetId = rs.properties.sheetId;
      const totalRows = allRows.length; // includes header

      if (totalRows > 1) {
        // Clear data rows (keep header row 0)
        await c.spreadsheets.batchUpdate({
          spreadsheetId: MAIN_SHEET_ID,
          resource: {
            requests: [{
              deleteDimension: {
                range: {
                  sheetId: sheetId,
                  dimension: 'ROWS',
                  startIndex: 1,           // after header
                  endIndex: totalRows      // all data rows
                }
              }
            }]
          }
        });
      }

      // Write back the rows we want to keep
      if (toKeep.length) {
        await c.spreadsheets.values.append({
          spreadsheetId: MAIN_SHEET_ID,
          range: 'Results!A:T',
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: toKeep }
        });
      }
    }

    console.log('[SHEETS] archiveTestResults: archived', toArchive.length, 'rows for test', testId);
    return { archived: toArchive.length, archiveId };
  } catch(err) {
    console.error('[SHEETS] archiveTestResults:', err.message);
    throw err;
  }
};

// Read archived results for a specific test from AIITS_Archive
// Used for showing leaderboard after MongoDB results are cleared
exports.readArchivedResults = async function(testId, batch) {
  try {
    const d = gd();
    const search = await d.files.list({
      q: "name='AIITS_Archive' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'files(id)'
    });
    if (!search.data.files || !search.data.files.length) return [];
    const archiveId = search.data.files[0].id;

    const c = gc();
    const res = await c.spreadsheets.values.get({ spreadsheetId: archiveId, range: 'Results!A:T' });
    const rows = res.data.values || [];
    if (rows.length < 2) return [];

    const h = rows[0];
    const I = {
      name:     h.indexOf('StudentName'),
      email:    h.indexOf('Email'),
      batch:    h.indexOf('Batch'),
      coaching: h.indexOf('CoachingName'),
      obtained: h.indexOf('ObtainedMarks'),
      total:    h.indexOf('TotalMarks'),
      pct:      h.indexOf('Percentage'),
      time:     h.indexOf('TimeSecs'),
      date:     h.indexOf('SubmittedAt'),
      testId:   h.indexOf('TestID'),
      userId:   h.indexOf('UserID'),
      rank:     h.indexOf('OverallRank'),
      batchRank:h.indexOf('BatchRank'),
    };

    return rows.slice(1)
      .filter(r => {
        const tMatch = !testId || r[I.testId] === String(testId);
        const bMatch = !batch || batch === 'all' || r[I.batch] === batch;
        return tMatch && bMatch;
      })
      .map(r => ({
        userName:     r[I.name]     || '',
        userEmail:    r[I.email]    || '',
        batch:        r[I.batch]    || '',
        coachingName: r[I.coaching] || '',
        obtainedMarks:parseFloat(r[I.obtained]) || 0,
        totalMarks:   parseFloat(r[I.total])    || 0,
        percentage:   parseFloat(r[I.pct])      || 0,
        timeTaken:    parseInt(r[I.time])        || 0,
        submittedAt:  r[I.date]    || '',
        testId:       r[I.testId]  || '',
        userId:       r[I.userId]  || '',
        rank:         parseInt(r[I.rank])     || null,
        batchRank:    parseInt(r[I.batchRank])|| null,
        fromArchive:  true,
      }));
  } catch(err) {
    console.error('[SHEETS] readArchivedResults:', err.message);
    return [];
  }
};

exports.getSheetStats = async function() {
  try {
    const c = gc();
    const [rr,sr] = await Promise.all([rowCount(c,MAIN_SHEET_ID,'Results'),rowCount(c,MAIN_SHEET_ID,'Students')]);
    return { resultsRows: Math.max(0,rr-1), studentsRows: Math.max(0,sr-1), archiveTrigger: ARCHIVE_TRIGGER, mainSheetUrl: 'https://docs.google.com/spreadsheets/d/'+MAIN_SHEET_ID+'/edit' };
  } catch(err) { console.error('[SHEETS] getSheetStats:', err.message); return null; }
};

async function archiveIfNeeded(c) {
  const rows = await rowCount(c, MAIN_SHEET_ID, 'Results');
  if (rows < ARCHIVE_TRIGGER+1) return;
  const readRes = await c.spreadsheets.values.get({ spreadsheetId: MAIN_SHEET_ID, range: 'Results!A2:T'+(ARCHIVE_CHUNK+1) });
  const toArchive = readRes.data.values||[];
  if (!toArchive.length) return;
  const d = gd();
  let archiveId;
  const search = await d.files.list({ q: "name='AIITS_Archive' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", fields: 'files(id)' });
  if (search.data.files&&search.data.files.length) { archiveId = search.data.files[0].id; }
  else {
    const cr = await d.files.create({ resource: { name:'AIITS_Archive', mimeType:'application/vnd.google-apps.spreadsheet' }, fields:'id' });
    archiveId = cr.data.id;
    if (process.env.ADMIN_EMAIL) await d.permissions.create({ fileId:archiveId, resource:{ type:'user', role:'writer', emailAddress:process.env.ADMIN_EMAIL } });
  }
  const ac = gc();
  await initTab(ac, archiveId, 'Results', RESULTS_HEADERS);
  await ac.spreadsheets.values.append({ spreadsheetId:archiveId, range:'Results!A:T', valueInputOption:'RAW', insertDataOption:'INSERT_ROWS', resource:{ values:toArchive } });
  const meta = await c.spreadsheets.get({ spreadsheetId: MAIN_SHEET_ID });
  const rs = meta.data.sheets.find(s => s.properties.title==='Results');
  if (rs) await c.spreadsheets.batchUpdate({ spreadsheetId:MAIN_SHEET_ID, resource:{ requests:[{ deleteDimension:{ range:{ sheetId:rs.properties.sheetId, dimension:'ROWS', startIndex:1, endIndex:1+toArchive.length } } }] } });
  console.log('[SHEETS] Archived', toArchive.length, 'rows');
}

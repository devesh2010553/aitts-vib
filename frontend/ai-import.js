// frontend/ai-import.js — loaded on demand (see adminTab('ai-import') in
// adminvibacdonlineaiits.html), never on student pages, never on normal
// admin page load. Uses the existing api()/toast()/esc() helpers already
// defined globally by the admin page.
(function () {
  var pollTimer = null;
  var currentJobId = null;

  function shell() {
    return '' +
      '<div class="admin-card">' +
        '<h3><i class="fas fa-file-pdf"></i> AI PDF Test Import</h3>' +
        '<p style="color:var(--text-muted);font-size:13px;margin-bottom:14px">Upload an existing question-paper PDF. It gets reconstructed as a draft test — nothing is published automatically, and nothing new is invented; the PDF is the source of truth.</p>' +
        '<div id="ai-import-upload-box">' +
          '<input type="file" id="ai-pdf-file" accept="application/pdf" style="margin-bottom:10px;display:block">' +
          '<button class="btn btn-gold" onclick="AiImport.upload()"><i class="fas fa-upload"></i> Upload &amp; Analyze</button>' +
        '</div>' +
        '<div id="ai-import-progress" style="display:none;margin-top:18px"></div>' +
        '<div id="ai-import-review" style="display:none;margin-top:18px"></div>' +
      '</div>';
  }

  function init() {
    var c = document.getElementById('atab-ai-import');
    if (!c) return;
    c.innerHTML = shell();
  }

  function setProgress(html) {
    var p = document.getElementById('ai-import-progress');
    if (!p) return;
    p.style.display = 'block';
    p.innerHTML = html;
  }

  function stageRow(label, done) {
    return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">' +
      '<i class="fas ' + (done ? 'fa-check-circle' : 'fa-spinner fa-spin') + '" style="color:' + (done ? '#2f855a' : '#b8860b') + '"></i> ' + esc(label) + '</div>';
  }

  function upload(force) {
    var input = document.getElementById('ai-pdf-file');
    if (!input || !input.files || !input.files[0]) { toast('Choose a PDF first', 'error'); return; }
    if (!input.files[0].type || input.files[0].type !== 'application/pdf') { toast('Please choose a .pdf file', 'error'); return; }

    var fd = new FormData();
    fd.append('pdf', input.files[0]);

    document.getElementById('ai-import-review').style.display = 'none';
    setProgress(stageRow('Uploading PDF...', false));

    // Deliberately NOT using the shared api() helper here — it forces
    // Content-Type: application/json, which breaks a multipart FormData
    // upload (the browser needs to set its own boundary).
    fetch('/api/admin/ai/import-pdf' + (force ? '?force=true' : ''), {
      method: 'POST', credentials: 'include', body: fd,
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    }).then(function (r) {
      if (r.status === 409 && !force) {
        setProgress(
          '<div style="padding:12px;border:1px solid #d69e2e;border-radius:8px;background:#fffaf0">' +
          '<i class="fas fa-exclamation-triangle" style="color:#d69e2e"></i> This PDF appears to have already been imported (' + esc(r.data.existingFileName || '') + ', ' + esc(r.data.existingStatus || '') + ').' +
          (r.data.existingTestId ? ' <button class="btn btn-outline btn-sm" onclick="editTest(\'' + r.data.existingTestId + '\')">Open that draft</button>' : '') +
          ' <button class="btn btn-outline btn-sm" onclick="AiImport.upload(true)">Import anyway</button>' +
          '</div>'
        );
        return;
      }
      if (r.status === 503) { setProgress('<p style="color:#c53030">' + esc(r.data.error) + '</p>'); return; }
      if (!r.ok) { setProgress('<p style="color:#c53030">' + esc(r.data.error || 'Upload failed') + '</p>'); return; }

      currentJobId = r.data.jobId;
      startPolling(currentJobId);
    }).catch(function (err) { setProgress('<p style="color:#c53030">' + esc(err.message) + '</p>'); });
  }

  function startPolling(jobId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { poll(jobId); }, 2000);
    poll(jobId);
  }

  function poll(jobId) {
    api('/api/admin/ai/import-status/' + jobId).then(function (job) {
      if (job.status === 'failed') {
        clearInterval(pollTimer); pollTimer = null;
        setProgress('<p style="color:#c53030"><i class="fas fa-times-circle"></i> Import failed: ' + esc(job.error || 'Unknown error') + '</p>');
        return;
      }
      var lines = [
        stageRow('Uploading PDF', true),
        stageRow('Reading PDF (' + (job.pageCount || '...') + ' pages)', job.pageCount > 0),
        stageRow('Detecting questions... ' + (job.questionsDetected || 0) + (job.totalQuestionsGuess ? ' / ~' + job.totalQuestionsGuess + ' est.' : ''), job.status === 'done'),
      ];
      if (job.imagesDetected) lines.push(stageRow(job.imagesDetected + ' image(s) detected', true));
      if (job.tablesDetected) lines.push(stageRow(job.tablesDetected + ' table(s) detected', true));
      lines.push('<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">' + esc(job.stage || '') + '</div>');
      setProgress(lines.join(''));

      if (job.status === 'done') {
        clearInterval(pollTimer); pollTimer = null;
        loadReview(jobId);
      }
    }).catch(function () { /* transient poll failure — try again next tick */ });
  }

  function confidenceBadge(c) {
    var map = { high: ['#2f855a', 'High confidence'], review: ['#b8860b', 'Review recommended'], low: ['#c53030', 'Low confidence — check carefully'] };
    var v = map[c] || map.review;
    return '<span style="color:' + v[0] + ';font-weight:700;font-size:11px"><i class="fas fa-circle" style="font-size:7px"></i> ' + v[1] + '</span>';
  }

  function loadReview(jobId) {
    api('/api/admin/ai/import/' + jobId).then(function (job) {
      var box = document.getElementById('ai-import-review');
      box.style.display = 'block';
      var qs = job.questions || [];
      var html = '<h4>Review — ' + qs.length + ' question' + (qs.length === 1 ? '' : 's') + ' detected</h4>';
      html += '<div style="max-height:420px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin:10px 0">';
      qs.forEach(function (q, i) {
        html += '<div style="padding:10px 12px;border-bottom:1px solid var(--border)">';
        html += '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center">';
        html += '<strong>Q' + (q.number != null ? q.number : (i + 1)) + '</strong>' + confidenceBadge(q.confidence);
        html += '</div>';
        html += '<div style="font-size:13px;margin:4px 0;color:var(--text-sec)">' + esc((q.questionText || '').slice(0, 160)) + (q.questionText && q.questionText.length > 160 ? '…' : '') + '</div>';
        if (q.questionImage) html += '<img src="data:image/png;base64,' + q.questionImage + '" style="max-width:160px;max-height:100px;border-radius:6px;border:1px solid var(--border);margin:4px 0">';
        if (q.options && q.options.length) html += '<div style="font-size:12px;color:var(--text-muted)">' + q.options.map(function (o) { return esc(o.label) + '. ' + esc((o.text || '').slice(0, 40)) + (o.isCorrect ? ' ✓' : ''); }).join(' &nbsp; ') + '</div>';
        if (q.flags && q.flags.length) html += '<div style="font-size:11px;color:#b8860b;margin-top:3px"><i class="fas fa-flag"></i> ' + q.flags.map(esc).join('; ') + '</div>';
        html += '<button class="btn btn-outline btn-sm" style="margin-top:6px" onclick="AiImport.reprocess(\'' + jobId + '\',' + i + ')"><i class="fas fa-redo"></i> Reprocess this question</button>';
        html += '</div>';
      });
      html += '</div>';
      html += '<button class="btn btn-gold" onclick="AiImport.createDraft(\'' + jobId + '\')"><i class="fas fa-check"></i> Create Draft Test &amp; Open Editor</button> ';
      html += '<a href="/api/admin/ai/import/' + jobId + '/pdf" target="_blank" class="btn btn-outline btn-sm"><i class="fas fa-file-pdf"></i> View Original PDF</a>';
      box.innerHTML = html;
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function reprocess(jobId, index) {
    toast('Reprocessing question ' + (index + 1) + '...', 'info');
    api('/api/admin/ai/import/' + jobId + '/reprocess-question/' + index, { method: 'POST' })
      .then(function () { toast('Question reprocessed', 'success'); loadReview(jobId); })
      .catch(function (err) { toast(err.message, 'error'); });
  }

  function createDraft(jobId) {
    api('/api/admin/ai/import/' + jobId + '/create-draft', { method: 'POST', body: JSON.stringify({}) })
      .then(function (r) {
        toast('Draft created — opening editor...', 'success');
        editTest(r.testId); // existing test editor — no separate UI needed
      })
      .catch(function (err) { toast(err.message, 'error'); });
  }

  window.AiImport = { init: init, upload: upload, reprocess: reprocess, createDraft: createDraft };
})();

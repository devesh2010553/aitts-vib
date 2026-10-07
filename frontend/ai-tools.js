/*!
 * AITTS student tools — loaded ON DEMAND (never on first paint, never when the
 * admin has switched the Tools tab off).
 *
 *  1. Ask AI report   — shows the server-generated analysis of a result.
 *  2. Gemini chat     — talks to Google DIRECTLY from the student's browser
 *                       with the student's own free API key (kept only in
 *                       localStorage). Our server is not involved at all.
 *  3. 3D molecules    — 3Dmol.js (lazy-loaded from a CDN) + structure files
 *                       fetched straight from PubChem / RCSB by the browser.
 *
 * Only the Ask AI report touches our server (one small POST, cached).
 */
(function () {
  'use strict';

  var LS_KEY = 'aiits_gemini_key', LS_MODEL = 'aiits_gemini_model', LS_HIST = 'aiits_gemini_hist';
  var DEFAULT_MODEL = 'gemini-3.6-flash';
  var DMOL_URL = 'https://cdn.jsdelivr.net/npm/3dmol@2.5.5/build/3Dmol-min.js';
  var DMOL_SRI = 'sha384-OsczYbldvrHgslr9fFp/i4GiLSeuw9l+QIlv99ITw8soOwXcoGeflFMLg+CU/X1d';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function tst(m, t) { if (window.toast) window.toast(m, t || 'info'); }
  function userKey() { var u = window.S && window.S.user; return (u && (u.uid || u._id || u.email)) || 'anon'; }

  // ---------- styles (injected once, only when this file is used) ----------
  var css = '' +
    '.tl-seg{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}' +
    '.tl-seg button{flex:1;min-width:130px;padding:10px 12px;border-radius:var(--radius-sm);border:1.5px solid var(--border);background:var(--bg-card);color:var(--text-sec);font-weight:700;font-size:13px;cursor:pointer;font-family:var(--font)}' +
    '.tl-seg button.active{border-color:var(--gold);color:var(--gold);background:var(--gold-glow)}' +
    '.tl-card{background:var(--bg-card);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:12px}' +
    '.tl-note{font-size:12px;color:var(--text-muted);line-height:1.6}' +
    '.tl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.tl-row input,.tl-row select{flex:1;min-width:120px}' +
    '.tl-chips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}' +
    '.tl-chip{padding:5px 11px;border-radius:999px;border:1.5px solid var(--gold-border);background:var(--gold-pale);color:var(--gold);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font)}' +
    '#tl-viewer{position:relative;width:100%;height:340px;border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--bg-elevated)}' +
    '#gm-box{height:360px;overflow-y:auto;border:1.5px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--bg-elevated);display:flex;flex-direction:column;gap:8px;margin-bottom:10px}' +
    '.gm-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13.5px;line-height:1.6;word-wrap:break-word}' +
    '.gm-u{align-self:flex-end;background:var(--gold);color:#fff;border-bottom-right-radius:3px}' +
    '.gm-a{align-self:flex-start;background:var(--bg-card);border:1px solid var(--border);border-bottom-left-radius:3px}' +
    '.gm-a pre{background:var(--bg-elevated);padding:8px;border-radius:6px;overflow-x:auto;font-size:12px}' +
    '.gm-a code{background:var(--bg-elevated);padding:1px 4px;border-radius:4px;font-size:12px}' +
    '.air-sec{margin-bottom:14px}.air-h{font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--gold);margin-bottom:6px;display:flex;align-items:center;gap:6px}' +
    '.air-p{font-size:13.5px;line-height:1.65;color:var(--text)}' +
    '.air-weak{border:1px solid var(--border);border-left:3px solid var(--red,#c53030);border-radius:8px;padding:9px 12px;margin-bottom:8px;background:var(--bg-elevated)}' +
    '.air-weak b{font-size:13.5px}.air-weak div{font-size:12.5px;color:var(--text-sec);margin-top:2px}' +
    '.air-li{font-size:13.5px;line-height:1.6;padding:3px 0 3px 18px;position:relative}.air-li:before{content:"\\2022";position:absolute;left:4px;color:var(--gold);font-weight:900}' +
    '.air-dots span{display:inline-block;width:7px;height:7px;margin:0 3px;border-radius:50%;background:var(--gold);animation:airb 1s infinite ease-in-out}.air-dots span:nth-child(2){animation-delay:.15s}.air-dots span:nth-child(3){animation-delay:.3s}' +
    '@keyframes airb{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1.1)}}';
  var styled = false;
  function ensureStyle() { if (styled) return; styled = true; var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }

  // =====================================================================
  // 1. ASK AI REPORT (server-generated, cached in localStorage)
  // =====================================================================
  var RPT_PREFIX = 'aiits_ai_r_';
  function rptKey(testId, sig) { return RPT_PREFIX + userKey() + '_' + testId + '_' + sig; }
  function pruneReports() {
    try {
      var ks = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(RPT_PREFIX) === 0) ks.push(k); }
      if (ks.length <= 30) return;
      var withT = ks.map(function (k) { var t = 0; try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch (e) {} return { k: k, t: t }; }).sort(function (a, b) { return a.t - b.t; });
      withT.slice(0, ks.length - 30).forEach(function (x) { lsDel(x.k); });
    } catch (e) {}
  }

  function renderReport(r) {
    function list(a) { return (a || []).map(function (x) { return '<div class="air-li">' + esc(x) + '</div>'; }).join(''); }
    var h = '';
    h += '<div class="air-sec"><div class="air-h"><i class="fas fa-bullseye"></i> Overview</div><div class="air-p">' + esc(r.summary) + '</div></div>';
    h += '<div class="air-sec"><div class="air-h"><i class="fas fa-clock"></i> Time management</div><div class="air-p">' + esc(r.time) + '</div></div>';
    if (r.strengths && r.strengths.length) h += '<div class="air-sec"><div class="air-h"><i class="fas fa-thumbs-up"></i> What went well</div>' + list(r.strengths) + '</div>';
    if (r.weakAreas && r.weakAreas.length) h += '<div class="air-sec"><div class="air-h"><i class="fas fa-triangle-exclamation"></i> Weak areas</div>' +
      r.weakAreas.map(function (w) { return '<div class="air-weak"><b>' + esc(w.topic) + '</b><div>' + esc(w.why) + '</div></div>'; }).join('') + '</div>';
    if (r.focus && r.focus.length) h += '<div class="air-sec"><div class="air-h"><i class="fas fa-route"></i> Where to focus next</div>' + list(r.focus) + '</div>';
    h += '<p class="tl-note" style="margin-top:6px"><i class="fas fa-circle-info"></i> AI-generated from your answers &mdash; use it as a guide, not a verdict.</p>';
    return h;
  }

  function askAI(testId, sig) {
    ensureStyle();
    var old = $('ai-modal'); if (old) old.remove();
    var m = document.createElement('div');
    m.id = 'ai-modal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);z-index:1100;display:flex;align-items:center;justify-content:center;padding:16px';
    m.innerHTML = '<div style="background:var(--bg-card);border-radius:12px;padding:22px;max-width:640px;width:100%;max-height:86vh;overflow-y:auto;box-shadow:0 4px 24px rgba(0,0,0,0.25)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px"><h3 style="margin:0;font-size:16px"><i class="fas fa-wand-magic-sparkles" style="color:var(--gold)"></i> AI Result Analysis</h3>' +
      '<button id="ai-x" style="background:none;border:none;font-size:22px;cursor:pointer;color:#888;line-height:1">&times;</button></div>' +
      '<div id="ai-body"></div></div>';
    document.body.appendChild(m);
    m.onclick = function (e) { if (e.target === m) m.remove(); };
    $('ai-x').onclick = function () { m.remove(); };
    var body = $('ai-body');

    var key = rptKey(testId, sig || '0');
    var cached = null; try { cached = JSON.parse(lsGet(key) || 'null'); } catch (e) {}
    if (cached && cached.r) { body.innerHTML = renderReport(cached.r); return; }

    body.innerHTML = '<div style="text-align:center;padding:30px 10px;color:var(--text-muted)"><div class="air-dots"><span></span><span></span><span></span></div><p style="margin-top:12px;font-size:13px">Reading your answers and timing&hellip;</p></div>';
    var qt = null; try { qt = JSON.parse(lsGet('aiits_qt_' + userKey() + '_' + testId) || 'null'); } catch (e) {}
    window.api('/api/ai-analytics', { method: 'POST', body: JSON.stringify({ testId: testId, qTimes: qt || undefined }) })
      .then(function (d) {
        if (!$('ai-body')) return;
        lsSet(key, JSON.stringify({ t: Date.now(), r: d.report })); pruneReports();
        $('ai-body').innerHTML = renderReport(d.report);
      }).catch(function (e) {
        if (!$('ai-body')) return;
        $('ai-body').innerHTML = '<p style="color:var(--red);font-size:13.5px;line-height:1.6"><i class="fas fa-circle-exclamation"></i> ' + esc(e.message || 'Could not get AI analysis.') + '</p>' +
          '<button class="btn btn-outline btn-sm" onclick="askAI(\'' + esc(testId) + '\',\'' + esc(sig || '0') + '\')"><i class="fas fa-rotate"></i> Try again</button>';
      });
  }

  // =====================================================================
  // 2. GEMINI CHAT (browser -> Google, student's own key)
  // =====================================================================
  function fmt(t) {
    var s = esc(t);
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) { return '<pre>' + c.replace(/^\w*\n/, '') + '</pre>'; });
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^\s*[\*\-] /gm, '\u2022 ');
    return s.replace(/\n/g, '<br>').replace(/<pre>([\s\S]*?)<\/pre>/g, function (_, c) { return '<pre>' + c.replace(/<br>/g, '\n') + '</pre>'; });
  }
  function getHist() { try { var h = JSON.parse(lsGet(LS_HIST + '_' + userKey()) || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; } }
  function saveHist(h) {
    h = h.slice(-30);
    while (JSON.stringify(h).length > 40000 && h.length > 2) h.shift();
    lsSet(LS_HIST + '_' + userKey(), JSON.stringify(h));
  }

  var busy = false;
  function mountGemini(root) {
    var key = lsGet(LS_KEY);
    if (!key) {
      root.innerHTML = '<div class="tl-card"><h4 style="margin-bottom:8px"><i class="fas fa-key" style="color:var(--gold)"></i> Connect your free Gemini key</h4>' +
        '<p class="tl-note" style="margin-bottom:10px">This chat runs directly between <b>your browser and Google</b> &mdash; nothing goes through our server. Create a free key at ' +
        '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style="color:var(--gold)">aistudio.google.com/apikey</a>, paste it below. It is saved only in this browser (localStorage). Use a key just for this &mdash; do not share it.</p>' +
        '<div class="tl-row"><input type="password" id="gm-key" placeholder="Paste your Gemini API key" autocomplete="off"><button class="btn btn-gold" id="gm-save">Save</button></div></div>';
      $('gm-save').onclick = function () {
        var v = ($('gm-key').value || '').trim();
        if (v.length < 20 || /\s/.test(v)) { tst('That does not look like a valid key.', 'error'); return; }
        lsSet(LS_KEY, v); mountGemini(root);
      };
      return;
    }
    var model = lsGet(LS_MODEL) || DEFAULT_MODEL;
    root.innerHTML = '<div id="gm-box"></div>' +
      '<div class="tl-row"><input type="text" id="gm-in" placeholder="Ask a doubt, concept, or paste a question..." maxlength="2000"><button class="btn btn-gold" id="gm-send"><i class="fas fa-paper-plane"></i></button></div>' +
      '<details style="margin-top:12px"><summary class="tl-note" style="cursor:pointer">Settings</summary>' +
      '<div class="tl-row" style="margin-top:8px"><input type="text" id="gm-model" value="' + esc(model) + '" placeholder="Model id"><button class="btn btn-outline btn-sm" id="gm-msave">Save model</button></div>' +
      '<div class="tl-row" style="margin-top:8px"><button class="btn btn-outline btn-sm" id="gm-clear"><i class="fas fa-eraser"></i> Clear chat</button><button class="btn btn-outline btn-sm" id="gm-rmkey"><i class="fas fa-trash"></i> Remove my key</button></div></details>';
    var box = $('gm-box');
    function draw() {
      var h = getHist();
      box.innerHTML = h.length ? h.map(function (m) { return '<div class="gm-msg ' + (m.r === 'u' ? 'gm-u' : 'gm-a') + '">' + (m.r === 'u' ? esc(m.t) : fmt(m.t)) + '</div>'; }).join('')
        : '<p class="tl-note" style="margin:auto;text-align:center">Ask anything about Physics, Chemistry, Maths or Biology.<br>Your chat is stored only on this device.</p>';
      box.scrollTop = box.scrollHeight;
    }
    draw();
    $('gm-in').onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('gm-send').onclick = send;
    $('gm-msave').onclick = function () { var v = ($('gm-model').value || '').trim(); if (v) { lsSet(LS_MODEL, v); tst('Model saved', 'success'); } };
    $('gm-clear').onclick = function () { lsDel(LS_HIST + '_' + userKey()); draw(); };
    $('gm-rmkey').onclick = function () { if (confirm('Remove your Gemini key from this browser?')) { lsDel(LS_KEY); mountGemini(root); } };

    function send() {
      if (busy) return;
      var inp = $('gm-in'), text = (inp.value || '').trim();
      if (!text) return;
      var h = getHist(); h.push({ r: 'u', t: text }); saveHist(h); inp.value = ''; draw();
      busy = true; $('gm-send').disabled = true;
      var typing = document.createElement('div'); typing.className = 'gm-msg gm-a'; typing.innerHTML = '<span class="air-dots"><span></span><span></span><span></span></span>';
      box.appendChild(typing); box.scrollTop = box.scrollHeight;

      var contents = h.slice(-12).map(function (m) { return { role: m.r === 'u' ? 'user' : 'model', parts: [{ text: m.t }] }; });
      var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, 45000);
      fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(lsGet(LS_MODEL) || DEFAULT_MODEL) + ':generateContent', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': lsGet(LS_KEY) || '' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: 'You are a friendly, accurate tutor for Indian JEE/NEET students. Explain step by step, keep answers concise, and say so when you are unsure.' }] },
          contents: contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.5 }
        })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) {
            var msg = (d.error && d.error.message) || ('HTTP ' + res.status);
            if (res.status === 400 && /API key/i.test(msg)) msg = 'Your API key was rejected. Check it in Settings > Remove my key.';
            else if (res.status === 429) msg = 'Free quota reached. Wait a bit and try again.';
            else if (res.status === 404) msg = 'Model "' + (lsGet(LS_MODEL) || DEFAULT_MODEL) + '" not found. Change it in Settings.';
            throw new Error(msg);
          }
          var c = d.candidates && d.candidates[0];
          var out = c && c.content && c.content.parts && c.content.parts.map(function (p) { return p.text || ''; }).join('');
          if (!out) throw new Error('No answer returned' + (c && c.finishReason ? ' (' + c.finishReason + ')' : '') + '.');
          return out;
        });
      }).then(function (out) {
        var hh = getHist(); hh.push({ r: 'a', t: out }); saveHist(hh);
      }).catch(function (e) {
        var hh = getHist(); hh.push({ r: 'a', t: '\u26A0 ' + (e.name === 'AbortError' ? 'Request timed out. Try again.' : e.message) }); saveHist(hh);
      }).then(function () {
        clearTimeout(timer); busy = false;
        if ($('gm-send')) { $('gm-send').disabled = false; draw(); }
      });
    }
  }

  // =====================================================================
  // 3. 3D MOLECULES (3Dmol.js, lazy)
  // =====================================================================
  var libPromise = null, viewer = null, spinOn = false;
  var molCache = {};
  var PRESETS = ['Water', 'Methane', 'Ethanol', 'Benzene', 'Acetic acid', 'Cyclohexane', 'Aspirin', 'Caffeine', 'PDB:1CRN', 'PDB:2HHB'];

  function loadLib() {
    if (window.$3Dmol) return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise(function (ok, bad) {
      var s = document.createElement('script');
      s.src = DMOL_URL; s.integrity = DMOL_SRI; s.crossOrigin = 'anonymous';
      s.onload = function () { window.$3Dmol ? ok() : bad(new Error('3Dmol did not initialise')); };
      s.onerror = function () { libPromise = null; bad(new Error('Could not load the 3D library. Check your internet and try again.')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function fetchStructure(q) {
    q = q.trim();
    var pdb = /^pdb:\s*([0-9][A-Za-z0-9]{3})$/i.exec(q) || (/^[0-9][A-Za-z0-9]{3}$/.test(q) ? [0, q] : null);
    var ck = pdb ? 'pdb:' + pdb[1].toUpperCase() : 'cid:' + q.toLowerCase();
    if (molCache[ck]) return Promise.resolve(molCache[ck]);
    var url = pdb ? 'https://files.rcsb.org/download/' + pdb[1].toUpperCase() + '.pdb'
      : 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/' + encodeURIComponent(q) + '/SDF?record_type=3d';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(pdb ? 'PDB entry "' + pdb[1] + '" not found.' : 'No 3D structure found for "' + q + '". Try the common name (e.g. ethanol).');
      return r.text();
    }).then(function (t) {
      var o = { data: t, fmt: pdb ? 'pdb' : 'sdf', label: pdb ? 'PDB ' + pdb[1].toUpperCase() + ' (RCSB)' : q + ' (PubChem)' };
      molCache[ck] = o; return o;
    });
  }

  function applyStyle(style, fmtName) {
    if (!viewer) return;
    var st;
    if (style === 'cartoon' && fmtName === 'pdb') st = { cartoon: { color: 'spectrum' } };
    else if (style === 'sphere') st = { sphere: {} };
    else if (style === 'stick') st = { stick: { radius: 0.18 } };
    else st = { stick: { radius: 0.14 }, sphere: { scale: 0.28 } };
    viewer.setStyle({}, st);
    viewer.render();
  }

  function mountMol(root) {
    root.innerHTML = '<div class="tl-row"><input type="text" id="tl-q" placeholder="Molecule name (e.g. ethanol) or PDB id (e.g. PDB:1CRN)" maxlength="60"><button class="btn btn-gold" id="tl-go"><i class="fas fa-cube"></i> Show</button></div>' +
      '<div class="tl-chips">' + PRESETS.map(function (p) { return '<button class="tl-chip" data-q="' + esc(p) + '">' + esc(p.replace('PDB:', 'PDB ')) + '</button>'; }).join('') + '</div>' +
      '<div id="tl-viewer"></div>' +
      '<div class="tl-row" style="margin-top:10px"><select id="tl-style"><option value="ballstick">Ball &amp; stick</option><option value="stick">Stick</option><option value="sphere">Space-filling</option><option value="cartoon">Cartoon (proteins)</option></select>' +
      '<label class="tl-note" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="tl-spin" style="flex:none;min-width:0"> Auto-rotate</label></div>' +
      '<p class="tl-note" id="tl-info" style="margin-top:8px">Drag to rotate, scroll/pinch to zoom. Structures are fetched by your browser from PubChem / RCSB.</p>';
    var cur = null;
    function show(q) {
      if (!q) return;
      var info = $('tl-info'); info.textContent = 'Loading ' + q + '\u2026';
      Promise.all([loadLib(), fetchStructure(q)]).then(function (res) {
        var m = res[1], el = $('tl-viewer'); if (!el) return;
        if (!viewer) viewer = window.$3Dmol.createViewer(el, { backgroundColor: document.documentElement.getAttribute('data-theme') === 'dark' ? '#1c1c18' : '#ffffff' });
        viewer.clear(); viewer.addModel(m.data, m.fmt);
        cur = m;
        var sel = $('tl-style');
        if (m.fmt === 'pdb' && sel.value !== 'cartoon') sel.value = 'cartoon';
        else if (m.fmt === 'sdf' && sel.value === 'cartoon') sel.value = 'ballstick';
        applyStyle(sel.value, m.fmt);
        viewer.zoomTo(); viewer.resize(); viewer.render(); viewer.spin(!!$('tl-spin').checked);
        info.textContent = m.label + ' \u2014 drag to rotate, scroll/pinch to zoom.';
      }).catch(function (e) { info.textContent = '\u26A0 ' + e.message; });
    }
    $('tl-go').onclick = function () { show($('tl-q').value); };
    $('tl-q').onkeydown = function (e) { if (e.key === 'Enter') show(this.value); };
    Array.prototype.forEach.call(root.querySelectorAll('.tl-chip'), function (b) { b.onclick = function () { $('tl-q').value = b.getAttribute('data-q'); show(b.getAttribute('data-q')); }; });
    $('tl-style').onchange = function () { applyStyle(this.value, cur && cur.fmt); };
    $('tl-spin').onchange = function () { spinOn = this.checked; if (viewer) viewer.spin(spinOn); };
    viewer = null; // the old canvas was destroyed with the old DOM
    show('Ethanol');
  }

  // =====================================================================
  // Tools home
  // =====================================================================
  var which = 'gemini';
  function mount(root) {
    ensureStyle();
    root.innerHTML = '<div class="tl-seg"><button id="tl-t-gemini" class="active"><i class="fas fa-robot"></i> Gemini AI</button><button id="tl-t-mol"><i class="fas fa-atom"></i> 3D Molecules</button></div><div id="tl-pane"></div>';
    function pick(w) {
      which = w;
      $('tl-t-gemini').classList.toggle('active', w === 'gemini');
      $('tl-t-mol').classList.toggle('active', w === 'mol');
      if (viewer) { try { viewer.spin(false); } catch (e) {} viewer = null; }
      var p = $('tl-pane');
      if (w === 'gemini') mountGemini(p); else mountMol(p);
    }
    $('tl-t-gemini').onclick = function () { pick('gemini'); };
    $('tl-t-mol').onclick = function () { pick('mol'); };
    pick(which);
  }
  function pause() { if (viewer) { try { viewer.spin(false); } catch (e) {} } }
  window.addEventListener('resize', function () { if (viewer && $('tl-viewer')) { try { viewer.resize(); } catch (e) {} } });

  window.AIITSTools = { mount: mount, pause: pause, askAI: askAI };
})();

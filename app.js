/* ===== STATIC SITE OVERRIDES (injected by export_static.py) ===== */
window._staticMode = true;
window._isAdmin = false;
let _bakedAirtable = null;

window._loadSections = async function () {
  const d = await (await fetch('data.json')).json();   // gate decrypts
  _bakedAirtable = d.airtable;
  // Overlay LIVE notes + Modality Resolved from Airtable so edits show at once.
  // Keyed by "{term}|{crn}" since CRNs repeat across terms.
  try {
    const live = await _fetchAirtableNotes(d.airtable);
    const byId = {}; d.sections.forEach(s => byId[s.id] = s);
    Object.keys(live).forEach(k => { if (byId[k]) Object.assign(byId[k], live[k]); });
  } catch (e) { /* keep baked snapshot if Airtable read fails */ }
  return d;
};

async function _fetchAirtableNotes(a) {
  const out = {}; let offset = null;
  do {
    const url = `https://api.airtable.com/v0/${a.base}/${a.table}?pageSize=100` + (offset ? `&offset=${offset}` : '');
    const r = await fetch(url, {headers: {'Authorization': 'Bearer ' + a.token}});
    if (!r.ok) break;
    const d = await r.json();
    (d.records || []).forEach(rec => {
      const f = rec.fields || {}; const crn = String(f.CRN || '').trim(); if (!crn) return;
      const rv = f['Modality Resolved']; const term = f.Term || '';
      const key = term ? (term + '|' + crn) : crn;
      out[key] = { notes: f.Notes || '', updated_by: f['Updated By'] || '',
        modality_resolved: rv === true || String(rv).toLowerCase() === 'yes' };
    });
    offset = d.offset;
  } while (offset);
  return out;
}

window._saveNote = async function (s, notes) {
  const a = _bakedAirtable; if (!a) return {ok:false};
  if (!window._editor) {
    window._editor = (localStorage.getItem('sectrk-editor') || '').trim();
    if (!window._editor) { window._editor = (prompt('Your name or college (saved with your notes):') || '').trim(); if (window._editor) localStorage.setItem('sectrk-editor', window._editor); }
  }
  const body = {performUpsert:{fieldsToMergeOn:['CRN','Term']}, typecast:true,
    records:[{fields:{CRN:String(s.crn), Term:s.term, Notes:notes, Course:s.course_code, College:s.college, 'Updated By':(window._editor||'college')}}]};
  const r = await fetch(`https://api.airtable.com/v0/${a.base}/${a.table}`, {method:'PATCH',
    headers:{'Authorization':'Bearer '+a.token,'Content-Type':'application/json'}, body:JSON.stringify(body)});
  return {ok: r.ok, store:'airtable'};
};

window._saveResolved = async function () { return {ok:false}; };  // owner-only; not exposed here
window._staticConnect = function () { alert('Section data refreshes automatically each morning. Notes you enter save instantly.'); };
/* ===== end overrides ===== */

/* ============================================================================
   Left navigation rail — shared shell.  initTrackerShell(config)
   ----------------------------------------------------------------------------
   One reusable, config-driven left-rail shell for every tracker. Builds the
   #app-rail markup from `config`, owns the flag (body.shell-rail, ?shell=rail,
   localStorage), the drag-resize, and a generic scalable-filter engine
   (active-filters + searchable "＋ Add filter" picker) that reads an injected
   field registry — so it works over the program tracker's Set-globals AND the
   retention tracker's colFilters without knowing either.

   Consumed two ways: <script>-loaded (program/section) or inlined at build time
   (retention generate_dashboard.py). Pairs with rail.css. The rail is the DEFAULT
   layout everywhere (defaultShell:'rail'); ?shell=classic is an escape hatch. A
   tracker can opt back to classic-default via defaultShell:'classic'. See
   left-rail-redesign.md.

   config = {
     brand:   { label, logo },                 // logo = 1–2 char badge text
     persistPrefix: 'tracker',                  // localStorage key prefix
     defaultShell: 'rail',                      // DEFAULT: rail loads for everyone (?shell=classic escapes)
     classicToggle: false,                      // DEFAULT: no footer toggle; set true to show "↩ Classic layout"
     nav:     [ { label, items: [ { label, onSelect, isActive:()=>bool } ] } ],
     modes:   [ {                               // optional view-aware segmented
       label, enabled:()=>bool,                 //   toggles (a MODE, not a filter)
       options:()=>[{value,label}],
       active:()=>value, onSelect:(value)=>{},  //   radio; OR has:(value)=>bool for
       has?:(value)=>bool,                       //   multi-active (several lit at once)
       sub?: { enabled:()=>bool, placeholder,   //   optional dropdown under the toggle
         options:()=>[{value,label}], active:()=>value, onSelect:(value)=>{} } } ],
     scopesLabel: 'Focus',                      // optional heading over the scopes group
     scopes:  [ {                               // permanent top-level pickers under it
       label, enabled:()=>bool, placeholder,    //   default kind: single-select dropdown.
       options:()=>[{value,label}],             //   kind:'buttons' → segmented toggle
       active:()=>value, onSelect:(value)=>{},  //   (provide has:(value)=>bool for
       kind?:'buttons', has?:(value)=>bool } ], //   multi-active highlighting)
     scopeActions: [ { label, enabled:()=>bool, //   action links rendered under the
       onClick:()=>{} } ],                      //   scope pickers
     tools:   [ { label, onClick } ],           // optional admin buttons
     views:   {                                 // optional saved-views section
       enabled: ()=>bool, list: ()=>[{id,name,active}], apply:(id)=>{},
       onManage:()=>{}, manageLabel:'＋ Manage views…' },
     filters: {                                 // optional scalable filters
       enabled: ()=>bool, onChange: ()=>{},
       fields:  ()=>[ FieldDef ] },
     freshness: ()=>({ updated, build, connected })  // connected: 'green'|'amber'|'red'|null
   }

   FieldDef (all): { id, label, category, kind, active:()=>bool, clear:()=>{}, summary:()=>str }
     kind 'multi': options:()=>[v], has:(v)=>bool, toggle:(v)=>{}, labelFor?:(v)=>str, search?:bool
     kind 'bool' : get:()=>''|'Yes'|'No', set:(v)=>{}
     kind 'num'  : get:()=>({min,max}),   set:(min,max)=>{}
     kind 'text' : get:()=>str,           set:(v)=>{}
   ========================================================================== */
(function () {
  'use strict';

  var CFG = null;                 // active config
  var added = new Set();          // fields explicitly added but maybe empty
  var openGroups = new Set();     // expanded filter cards
  var addOpen = false;            // Add-filter picker open?
  var addQuery = '';
  var viewsCollapsed = true;      // Views / Filters / Tools sections collapse; CLOSED by default
  var filtersCollapsed = true;
  var toolsCollapsed = true;
  function loadCollapse() {
    try {
      viewsCollapsed   = localStorage.getItem(prefKey('views-open'))   !== 'true';
      filtersCollapsed = localStorage.getItem(prefKey('filters-open')) !== 'true';
      toolsCollapsed   = localStorage.getItem(prefKey('tools-open'))   !== 'true';
    } catch (_) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function prefKey(k) { return (CFG && CFG.persistPrefix ? CFG.persistPrefix : 'tracker') + '-' + k; }

  /* ---- flag + shell toggle ------------------------------------------------ */
  function applyShell(mode) {
    document.body.classList.toggle('shell-rail', mode === 'rail');
    try { localStorage.setItem(prefKey('shell'), mode); } catch (_) {}
    if (mode === 'rail') { ensureRail(); refresh(); }
    else if (CFG && CFG.onExitRail) { try { CFG.onExitRail(); } catch (_) {} }
  }
  function setShell(mode) { applyShell(mode); }

  /* ---- drag-resize -------------------------------------------------------- */
  function startRailResize(e) {
    e.preventDefault();
    var MIN = 176, MAX = 380;
    var setW = function (x) {
      document.documentElement.style.setProperty('--rail-w', Math.min(MAX, Math.max(MIN, Math.round(x))) + 'px');
    };
    var onMove = function (ev) { setW(ev.clientX); };
    var onUp = function (ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      var w = Math.min(MAX, Math.max(MIN, Math.round(ev.clientX)));
      try { localStorage.setItem(prefKey('rail-w'), String(w)); } catch (_) {}
      // When embedded in the console cockpit, tell the parent so it can keep the
      // grey-rail width consistent across every tracker (each tracker is a
      // different origin, so localStorage can't be shared — the parent brokers it).
      try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'railw', w: w }, '*'); } catch (_) {}
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function restoreRailWidth() {
    try {
      // A console-passed ?railw=<px> (cockpit embedding) wins over this tracker's
      // own saved width, so the grey rail is one consistent width across trackers.
      var m = /[?&]railw=(\d+)/.exec(location.search);
      var rw = m ? parseInt(m[1], 10) : parseInt(localStorage.getItem(prefKey('rail-w')) || '', 10);
      if (rw) document.documentElement.style.setProperty('--rail-w', rw + 'px');
    } catch (_) {}
  }

  /* ---- markup ------------------------------------------------------------- */
  function ensureRail() {
    if (document.getElementById('app-rail')) return;
    var nav = document.createElement('nav');
    nav.id = 'app-rail';
    nav.setAttribute('aria-label', 'Primary navigation');
    var b = CFG.brand || {};
    var navHtml = (CFG.nav || []).map(function (g, gi) {
      var items = (g.items || []).map(function (it, ii) {
        return '<button class="rail-item" data-nav="' + gi + '-' + ii + '">' + esc(it.label) + '</button>';
      }).join('');
      return '<div class="rail-group-label">' + esc(g.label) + '</div>' + items;
    }).join('');
    // Modes: view-aware segmented toggles (e.g. a Perspective switch) that are a
    // MODE, not a filter — rendered as their own labelled section under the nav,
    // separate from the Filters engine. Filled/synced by renderModes().
    var modesHtml = (CFG.modes || []).map(function (m, mi) {
      return '<div class="rail-modes-group" id="rail-modes-' + mi + '" style="display:none">' +
        '<div class="rail-group-label">' + esc(m.label) + '</div>' +
        '<div class="rail-modes" id="rail-modes-box-' + mi + '"></div>' +
        '<div class="rail-mode-sub-wrap" id="rail-modes-sub-' + mi + '"></div>' +
      '</div>';
    }).join('');
    // By default modes render under the nav; a tracker can pass
    // modesBelowFilters:true to place them beneath the Filters block instead.
    var modesTop    = CFG.modesBelowFilters ? '' : modesHtml;
    var modesBottom = CFG.modesBelowFilters ? modesHtml : '';
    // Scopes: permanent, view-aware single-select dropdowns pinned at the top
    // level (e.g. College / Campus / Credential) — the common "narrow to one X"
    // pickers, always visible, distinct from the collapsible Filters list.
    var scopesHtml = (CFG.scopes && CFG.scopes.length)
      ? (CFG.scopesLabel ? '<div class="rail-group-label" id="rail-scopes-label" style="display:none">' + esc(CFG.scopesLabel) + '</div>' : '') +
        '<div class="rail-scopes" id="rail-scopes" style="display:none"></div>'
      : '';
    var toolsHtml = (CFG.tools && CFG.tools.length)
      ? '<div class="rail-group-label rail-sec-toggle" id="rail-tools-label"><span class="rail-sec-caret" id="rail-tools-caret">▸</span>Tools</div>' +
        '<div class="rail-tools" id="rail-tools" style="display:none">' + CFG.tools.map(function (t, i) {
          return '<button class="rail-item" data-tool="' + i + '">' + esc(t.label) + '</button>';
        }).join('') + '</div>'
      : '';
    nav.innerHTML =
      '<div class="rail-brand"><span class="rail-logo">' + esc(b.logo || 'N') + '</span>' + esc(b.label || '') + '</div>' +
      '<div class="rail-scroll">' +
        navHtml +
        modesTop +
        scopesHtml +
        '<div class="rail-group-label rail-sec-toggle" id="rail-views-label" style="display:none"><span class="rail-sec-caret" id="rail-views-caret">▸</span>Views</div>' +
        '<div class="rail-views" id="rail-views" style="display:none"></div>' +
        '<div class="rail-filters-head" id="rail-filters-head" style="display:none">' +
          '<span class="rail-group-label rail-sec-toggle" id="rail-filters-toggle"><span class="rail-sec-caret" id="rail-filters-caret">▸</span>Filters<span class="rail-sec-count" id="rail-filters-count"></span></span>' +
          '<button class="rail-clear-filters" id="rail-clear-filters">Clear all</button></div>' +
        '<div class="rail-filters" id="rail-filters" style="display:none"></div>' +
        modesBottom +
        toolsHtml +
      '</div>' +
      '<div class="rail-footer">' +
        '<div class="rail-fresh" id="rail-updated"></div>' +
        '<div class="rail-fresh" id="rail-build"></div>' +
        (CFG.classicToggle === true ?
          '<button class="rail-shell-toggle" id="rail-classic-btn">↩ Classic layout</button>' : '') +
      '</div>' +
      '<div class="rail-resize" id="rail-resize"></div>';
    document.body.appendChild(nav);

    // wire events (no inline handlers → CSP-safe + works when inlined)
    nav.querySelectorAll('.rail-item[data-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.dataset.nav.split('-'), it = CFG.nav[+p[0]].items[+p[1]];
        if (it && it.onSelect) it.onSelect();
        syncNav();
      });
    });
    nav.querySelectorAll('.rail-item[data-tool]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = CFG.tools[+btn.dataset.tool]; if (t && t.onClick) t.onClick();
      });
    });
    var classicBtn = document.getElementById('rail-classic-btn');
    if (classicBtn) classicBtn.addEventListener('click', function () { setShell('classic'); });
    document.getElementById('rail-clear-filters').addEventListener('click', function (e) { e.stopPropagation(); clearFilters(); });
    document.getElementById('rail-views-label').addEventListener('click', function () {
      viewsCollapsed = !viewsCollapsed;
      try { localStorage.setItem(prefKey('views-open'), String(!viewsCollapsed)); } catch (_) {}
      renderViews();
    });
    document.getElementById('rail-filters-toggle').addEventListener('click', function () {
      filtersCollapsed = !filtersCollapsed;
      try { localStorage.setItem(prefKey('filters-open'), String(!filtersCollapsed)); } catch (_) {}
      renderFilters();
    });
    var toolsLabel = document.getElementById('rail-tools-label');
    if (toolsLabel) toolsLabel.addEventListener('click', function () {
      toolsCollapsed = !toolsCollapsed;
      try { localStorage.setItem(prefKey('tools-open'), String(!toolsCollapsed)); } catch (_) {}
      renderTools();
    });
    document.getElementById('rail-resize').addEventListener('mousedown', startRailResize);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && addOpen) { addOpen = false; renderFilters(); } });
  }

  /* ---- nav + footer sync -------------------------------------------------- */
  function syncNav() {
    (CFG.nav || []).forEach(function (g, gi) {
      (g.items || []).forEach(function (it, ii) {
        var btn = document.querySelector('#app-rail .rail-item[data-nav="' + gi + '-' + ii + '"]');
        if (btn) btn.classList.toggle('active', !!(it.isActive && it.isActive()));
      });
    });
    var f = (CFG.freshness && CFG.freshness()) || {};
    var up = document.getElementById('rail-updated'), bd = document.getElementById('rail-build');
    if (up) {
      var dot = f.connected ? '<span class="rail-dot ' + esc(f.connected) + '"></span>' : '';
      up.innerHTML = dot + esc(f.updated || '');
    }
    if (bd) bd.textContent = f.build || '';
  }

  /* ---- modes (view-aware segmented toggles; NOT filters) ------------------ */
  function renderModes() {
    (CFG.modes || []).forEach(function (m, mi) {
      var group = document.getElementById('rail-modes-' + mi);
      var box = document.getElementById('rail-modes-box-' + mi);
      if (!group || !box) return;
      var show = !m.enabled || m.enabled();
      group.style.display = show ? '' : 'none';
      if (!show) { box.innerHTML = ''; return; }
      var opts = (m.options && m.options()) || [];
      var cur = m.active && m.active();
      box.innerHTML = opts.map(function (o, oi) {
        // Multi-active modes provide has(value) (several buttons can be lit);
        // single-active (radio) modes fall back to matching active().
        var on = m.has ? m.has(o.value) : (String(o.value) === String(cur));
        return '<button class="rail-mode-btn' + (on ? ' active' : '') +
          '" data-mode="' + mi + '-' + oi + '">' + esc(o.label) + '</button>';
      }).join('');
      box.querySelectorAll('.rail-mode-btn[data-mode]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var p = btn.dataset.mode.split('-');
          var mm = CFG.modes[+p[0]];
          var oo = ((mm.options && mm.options()) || [])[+p[1]];
          if (mm && oo && mm.onSelect) mm.onSelect(oo.value);
          refresh();   // reflect new active + downstream (e.g. filters that depend on the mode)
        });
      });
      // Optional sub-picker: a dropdown shown under the toggle (e.g. the college
      // picker for the College perspective), only when m.sub.enabled() is true.
      var subWrap = document.getElementById('rail-modes-sub-' + mi);
      if (subWrap) {
        var sub = m.sub;
        if (!sub || (sub.enabled && !sub.enabled())) { subWrap.innerHTML = ''; }
        else {
          var sopts = (sub.options && sub.options()) || [];
          var scur = (sub.active && sub.active()) || '';
          subWrap.innerHTML = '<select class="rail-mode-sub">' +
            (sub.placeholder ? '<option value="">' + esc(sub.placeholder) + '</option>' : '') +
            sopts.map(function (o) {
              return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(scur) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
            }).join('') + '</select>';
          var selEl = subWrap.querySelector('select');
          selEl.addEventListener('change', function () { if (sub.onSelect) sub.onSelect(selEl.value); refresh(); });
        }
      }
    });
  }

  /* ---- scopes (permanent view-aware single-select pickers) ---------------- */
  function renderScopes() {
    var box = document.getElementById('rail-scopes');
    if (!box) return;
    var label = document.getElementById('rail-scopes-label');
    var S = CFG.scopes || [];
    var vis = [];
    S.forEach(function (s, si) { if (!s.enabled || s.enabled()) vis.push(si); });
    var acts = (CFG.scopeActions || []).map(function (a, ai) { return { a: a, ai: ai }; })
      .filter(function (x) { return !x.a.enabled || x.a.enabled(); });
    if (!vis.length && !acts.length) {
      box.style.display = 'none'; box.innerHTML = '';
      if (label) label.style.display = 'none';
      return;
    }
    box.style.display = '';
    if (label) label.style.display = vis.length ? '' : 'none';
    var scopesHtml = vis.map(function (si) {
      var s = S[si];
      var opts = (s.options && s.options()) || [];
      var body;
      if (s.kind === 'buttons') {   // segmented toggle inside the scopes group
        body = '<div class="rail-modes">' + opts.map(function (o, oi) {
          var on = s.has ? s.has(o.value) : (String(o.value) === String((s.active && s.active()) || ''));
          return '<button class="rail-mode-btn' + (on ? ' active' : '') + '" data-scopebtn="' + si + '-' + oi + '">' + esc(o.label) + '</button>';
        }).join('') + '</div>';
      } else {
        var cur = (s.active && s.active()) || '';
        body = '<select class="rail-scope-sel" data-scope="' + si + '">' +
          '<option value="">' + esc(s.placeholder || ('All ' + String(s.label).toLowerCase())) + '</option>' +
          opts.map(function (o) {
            return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(cur) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
          }).join('') + '</select>';
      }
      return '<div class="rail-scope"><label class="rail-scope-label">' + esc(s.label) + '</label>' + body + '</div>';
    }).join('');
    var actsHtml = acts.map(function (x) {
      return '<button class="rail-scope-action" data-scope-action="' + x.ai + '">' + esc(x.a.label) + '</button>';
    }).join('');
    box.innerHTML = scopesHtml + actsHtml;
    box.querySelectorAll('.rail-scope-sel[data-scope]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var s = CFG.scopes[+sel.dataset.scope];
        if (s && s.onSelect) s.onSelect(sel.value);
        refresh();
      });
    });
    box.querySelectorAll('.rail-mode-btn[data-scopebtn]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var p = btn.dataset.scopebtn.split('-'), s = CFG.scopes[+p[0]];
        var o = ((s.options && s.options()) || [])[+p[1]];
        if (s && o && s.onSelect) s.onSelect(o.value);
        refresh();
      });
    });
    box.querySelectorAll('.rail-scope-action[data-scope-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var a = CFG.scopeActions[+btn.dataset.scopeAction];
        if (a && a.onClick) a.onClick();
      });
    });
  }

  /* ---- views -------------------------------------------------------------- */
  function renderViews() {
    var box = document.getElementById('rail-views'), label = document.getElementById('rail-views-label');
    var V = CFG.views;
    var show = !!(V && (!V.enabled || V.enabled()));
    if (label) label.style.display = show ? '' : 'none';
    var vcaret = document.getElementById('rail-views-caret');
    if (vcaret) vcaret.textContent = viewsCollapsed ? '▸' : '▾';
    if (!box) return;
    box.style.display = (show && !viewsCollapsed) ? '' : 'none';
    if (!show || viewsCollapsed) { if (!show) box.innerHTML = ''; return; }
    var list = (V.list && V.list()) || [];
    box.innerHTML = list.map(function (v, i) {
      return '<button class="rail-view' + (v.active ? ' active' : '') + '" data-view="' + i + '" title="' + esc(v.name) + '">' + esc(v.name) + '</button>';
    }).join('') + (V.onManage ? '<button class="rail-view rail-view-manage" id="rail-view-manage">' + esc(V.manageLabel || '＋ Manage views…') + '</button>' : '');
    box.querySelectorAll('.rail-view[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () { var v = list[+btn.dataset.view]; if (v && V.apply) V.apply(v.id); });
    });
    var mg = document.getElementById('rail-view-manage');
    if (mg) mg.addEventListener('click', function () { V.onManage(); });
  }

  /* ---- filters engine ----------------------------------------------------- */
  function fields() { return (CFG.filters && CFG.filters.fields && CFG.filters.fields()) || []; }
  function fieldsEnabled() { return !!(CFG.filters && (!CFG.filters.enabled || CFG.filters.enabled())); }
  function filtersChanged() { if (CFG.filters && CFG.filters.onChange) CFG.filters.onChange(); renderFilters(); }

  function toggleGroup(id) { if (openGroups.has(id)) openGroups.delete(id); else openGroups.add(id); renderFilters(); }
  function removeFilter(f) { f.clear(); added.delete(f.id); openGroups.delete(f.id); filtersChanged(); }
  function clearFilters() {
    fields().forEach(function (f) { if (f.active()) f.clear(); });
    added.clear(); openGroups.clear(); addOpen = false; filtersChanged();
  }
  function addField(id) { added.add(id); openGroups.add(id); addOpen = false; addQuery = ''; renderFilters(); }

  function addListHtml() {
    var shown = fields().filter(function (f) {
      return !f.active() && !added.has(f.id) && (!addQuery || f.label.toLowerCase().indexOf(addQuery) > -1);
    });
    if (!shown.length) return '<div class="rail-add-empty">No matching field</div>';
    // group by category
    var cats = {}, order = [];
    shown.forEach(function (f) { var c = f.category || ''; if (!cats[c]) { cats[c] = []; order.push(c); } cats[c].push(f); });
    return order.map(function (c) {
      return (c ? '<div class="rail-add-cat">' + esc(c) + '</div>' : '') +
        cats[c].map(function (f) { return '<button class="rail-add-item" data-add="' + esc(f.id) + '">' + esc(f.label) + '</button>'; }).join('');
    }).join('');
  }

  function fieldBody(f) {
    if (f.kind === 'bool') {
      return ['', 'Yes', 'No'].map(function (v) {
        return '<label class="rail-f-opt"><input type="radio" name="railb-' + esc(f.id) + '" ' + (f.get() === v ? 'checked' : '') +
          ' data-bool="' + esc(v) + '"> ' + (v === '' ? 'Any' : v) + '</label>';
      }).join('');
    }
    if (f.kind === 'num') {
      var r = f.get() || {};
      return '<div class="rail-f-range"><input type="number" class="rail-f-min" placeholder="min" value="' + esc(r.min == null ? '' : r.min) + '">' +
        '<span>–</span><input type="number" class="rail-f-max" placeholder="max" value="' + esc(r.max == null ? '' : r.max) + '"></div>';
    }
    if (f.kind === 'text') {
      return '<input type="text" class="rail-f-text" placeholder="contains…" value="' + esc(f.get() || '') + '">';
    }
    // multi
    var opts = (f.options && f.options()) || [];
    if (!opts.length) return '<div class="rail-add-empty">No values</div>';
    return opts.map(function (v) {
      var lbl = f.labelFor ? f.labelFor(v) : v;
      return '<label class="rail-f-opt"><input type="checkbox" ' + (f.has(v) ? 'checked' : '') +
        ' data-v="' + esc(String(v)) + '"> ' + esc(String(lbl)) + '</label>';
    }).join('');
  }

  function renderFilters() {
    var box = document.getElementById('rail-filters'), head = document.getElementById('rail-filters-head'),
        clear = document.getElementById('rail-clear-filters');
    var show = fieldsEnabled();
    if (head) head.style.display = show ? 'flex' : 'none';
    var fcaret = document.getElementById('rail-filters-caret');
    if (fcaret) fcaret.textContent = filtersCollapsed ? '▸' : '▾';
    if (!box) return;
    var fs = show ? fields() : [];
    var activeCount = fs.filter(function (f) { return f.active(); }).length;
    var cnt = document.getElementById('rail-filters-count');
    if (cnt) cnt.textContent = activeCount ? (' (' + activeCount + ')') : '';
    if (clear) clear.style.display = (show && activeCount) ? '' : 'none';
    box.style.display = (show && !filtersCollapsed) ? 'flex' : 'none';
    if (!show || filtersCollapsed) { if (!show) box.innerHTML = ''; return; }

    var active = fs.filter(function (f) { return f.active() || added.has(f.id); });

    var html = active.map(function (f) {
      var open = openGroups.has(f.id);
      var dot = f.active() ? '<span class="rail-f-dot"></span>' : '';
      return '<div class="rail-f-group" data-fid="' + esc(f.id) + '">' +
        '<div class="rail-f-head" data-toggle="' + esc(f.id) + '">' + dot +
          '<span class="rail-f-label">' + esc(f.label) + '</span>' +
          '<span class="rail-f-summary">' + esc(f.summary() || '') + '</span>' +
          '<span class="rail-f-x" data-remove="' + esc(f.id) + '" title="Remove filter">&times;</span>' +
          '<span class="rail-f-caret">' + (open ? '▾' : '▸') + '</span></div>' +
        (open ? '<div class="rail-f-body">' + fieldBody(f) + '</div>' : '') + '</div>';
    }).join('');

    html += addOpen
      ? '<div class="rail-addfilter"><input id="rail-addfilter-search" class="rail-addfilter-search" placeholder="Search fields…" autocomplete="off">' +
        '<div id="rail-addfilter-list" class="rail-addfilter-list">' + addListHtml() + '</div></div>'
      : '<button class="rail-addfilter-btn" id="rail-add-btn">＋ Add filter</button>';
    box.innerHTML = html;
    wireFilterEvents(box);
    if (addOpen) { var inp = document.getElementById('rail-addfilter-search'); if (inp) inp.focus(); }
  }

  function wireFilterEvents(box) {
    var byId = {}; fields().forEach(function (f) { byId[f.id] = f; });
    box.querySelectorAll('[data-toggle]').forEach(function (h) {
      h.addEventListener('click', function () { toggleGroup(h.dataset.toggle); });
    });
    box.querySelectorAll('[data-remove]').forEach(function (x) {
      x.addEventListener('click', function (e) { e.stopPropagation(); removeFilter(byId[x.dataset.remove]); });
    });
    box.querySelectorAll('.rail-f-group').forEach(function (g) {
      var f = byId[g.dataset.fid]; if (!f) return;
      g.querySelectorAll('input[data-v]').forEach(function (cb) {
        cb.addEventListener('change', function () { f.toggle(cb.getAttribute('data-v')); filtersChanged(); });
      });
      g.querySelectorAll('input[data-bool]').forEach(function (rb) {
        rb.addEventListener('change', function () { if (rb.checked) { f.set(rb.getAttribute('data-bool')); filtersChanged(); } });
      });
      var mn = g.querySelector('.rail-f-min'), mx = g.querySelector('.rail-f-max');
      if (mn && mx) {
        var commit = function () {
          f.set(mn.value === '' ? null : +mn.value, mx.value === '' ? null : +mx.value); filtersChanged();
        };
        mn.addEventListener('change', commit); mx.addEventListener('change', commit);
      }
      var tx = g.querySelector('.rail-f-text');
      if (tx) tx.addEventListener('change', function () { f.set(tx.value); filtersChanged(); });
    });
    var addBtn = document.getElementById('rail-add-btn');
    if (addBtn) addBtn.addEventListener('click', function () { addOpen = true; addQuery = ''; renderFilters(); });
    var srch = document.getElementById('rail-addfilter-search');
    if (srch) srch.addEventListener('input', function () {
      addQuery = (srch.value || '').toLowerCase();
      var list = document.getElementById('rail-addfilter-list'); if (list) { list.innerHTML = addListHtml(); wireAddList(list); }
    });
    wireAddList(document.getElementById('rail-addfilter-list'));
  }
  function wireAddList(list) {
    if (!list) return;
    list.querySelectorAll('[data-add]').forEach(function (b) {
      b.addEventListener('click', function () { addField(b.dataset.add); });
    });
  }

  function renderTools() {
    var box = document.getElementById('rail-tools'), caret = document.getElementById('rail-tools-caret');
    if (caret) caret.textContent = toolsCollapsed ? '▸' : '▾';
    if (box) box.style.display = toolsCollapsed ? 'none' : '';
  }

  /* ---- public refresh ----------------------------------------------------- */
  function refresh() { if (!document.body.classList.contains('shell-rail')) return; syncNav(); renderModes(); renderScopes(); renderViews(); renderFilters(); renderTools(); }

  function initTrackerShell(config) {
    CFG = config || {};
    restoreRailWidth();
    loadCollapse();
    // Layout resolution: the rail is the default everywhere. An explicit ?shell=
    // URL param always wins (an escape hatch, e.g. ?shell=classic); then
    // CFG.defaultShell if a tracker sets one; otherwise 'rail'. The persisted
    // choice is deliberately NOT consulted, so a stale 'classic' can't stick and
    // a per-page ?shell=classic never persists past the next load.
    var urlMode = null;
    try { urlMode = new URLSearchParams(location.search).get('shell'); } catch (_) {}
    var mode = urlMode || CFG.defaultShell || 'rail';
    if (mode === 'rail') {
      applyShell('rail');
      setTimeout(refresh, 800);   // let freshness stamps populate
      setTimeout(refresh, 2500);
    }
    window.trackerShell = { refresh: refresh, setShell: setShell, syncNav: syncNav, applyShell: applyShell };
    return window.trackerShell;
  }

  window.initTrackerShell = initTrackerShell;
  window.setShell = window.setShell || setShell;   // programmatic shell toggle (rail entry via ?shell=rail)
})();

/* Fall 2026 Section Tracker — frontend (matches the Program tracker UI) */
(function () {
'use strict';

const API = window._apiBase || '';
const ADMIN = !!window._isAdmin;
const STATIC = !!window._staticMode;

let allSections = [];
let lastFetch = '', refreshDate = '';
let bakedPerTerm = null;     // per-term counts from the static payload (Console)
// term is MULTI-select: an array of selected terms; [] means "all terms".
// college/campus/modality/subject are MULTI-select. Tri-state: null = ALL (every box
// checked, no filter — the default "start with all"); [] = NONE (nothing checked → shows
// nothing); [a,b] = only those. term is multi ([] = all). resolved/level/special/priorTerms/
// search stay single (mode/threshold/text controls).
const filters = { term:['Fall 2026'], college:null, campus:null, subject:null, modality:null, resolved:'', level:'', special:'', priorTerms:'', search:'' };
let sort = { key:'course_code', dir:1 };
let drawerId = null;   // id of the section whose detail drawer is open (null = closed)
// Chronological term rank (ascending: Winter<Spring<Summer<Fall within a year),
// so term buttons / groupings read oldest→newest (Spring 2026 before Fall 2026).
const _SEASON_RANK = { winter:0, spring:1, summer:2, fall:3 };
function termRank(t){
  const s=String(t||''); const m=s.match(/(19|20)\d{2}/); if(!m) return 1e9;
  const seas=Object.keys(_SEASON_RANK).find(k=>s.toLowerCase().includes(k));
  return (+m[0])*10 + (seas?_SEASON_RANK[seas]:0);
}

const COLLEGE_ABBREV = {
  'College of Science':'COS', 'College of Engineering':'COE',
  'Bouve College of Hlth Sciences':'Bouvé', 'Coll of Soc Sci & Humanities':'CSSH',
  'Coll of Professional Studies':'CPS', 'Khoury Coll of Comp Sciences':'Khoury',
  'Coll of Arts, Media & Design':'CAMD', 'Office of the Provost':'Provost',
  "D'Amore-McKim School Business":'DMSB', 'School of Law':'Law',
  'Mills College at Northeastern':'Mills'
};
const abbr = c => COLLEGE_ABBREV[c] || c || '—';

const MOD_CLASS = { 'Online':'online', 'Hybrid':'hybrid', 'Traditional':'traditional',
  'Live Cast':'livecast', 'Video Streaming':'livecast' };
const modClass = m => 'pill ' + (MOD_CLASS[m] || '');
// row left-border marker class by modality
const ROW_MOD = { 'Online':'mod-online', 'Hybrid':'mod-hybrid', 'Live Cast':'mod-livecast',
  'Video Streaming':'mod-livecast', 'Traditional':'mod-traditional' };
const rowModClass = m => ROW_MOD[m] || '';

const MOD_ORDER = ['Traditional','Online','Hybrid','Live Cast','Video Streaming',
  'One-On-One','Cooperative Education','Study Abroad'];
const MOD_SHORT = { 'Traditional':'On-ground','Cooperative Education':'Co-op',
  'Video Streaming':'Video Stream','One-On-One':'One-on-One','Study Abroad':'Study Abroad' };
const modShort = m => MOD_SHORT[m] || m;

// ── Column registry (defaultHidden cols off until toggled in the picker) ──────
const SECTION_COLUMNS = [
  { key:'course_code', label:'Course' },
  { key:'section',     label:'Sec' },
  { key:'title',       label:'Title' },
  { key:'term',        label:'Term' },
  { key:'college',     label:'College', fmt:abbr },
  { key:'campus',      label:'Campus' },
  { key:'instructional_method', label:'Modality' },
  { key:'level',       label:'Level' },
  { key:'total_enrolled', label:'Enr', num:true },
  { key:'faculty_name', label:'Faculty' },
  { key:'modality_resolved', label:'Resolved' },
  { key:'notes',       label:'Notes' },
  { key:'special_topics', label:'Special Topics', defaultHidden:true },
  { key:'times_offered',  label:'Prior Terms', num:true, defaultHidden:true },
  { key:'topic_class',  label:'Topic Type',    defaultHidden:true },
  { key:'crn',          label:'CRN',           defaultHidden:true },
  { key:'schedule',     label:'Schedule',      defaultHidden:true },
  { key:'meeting_time', label:'Meeting Time',  defaultHidden:true },
  { key:'location',     label:'Location',      defaultHidden:true },
  { key:'faculty_email',label:'Faculty Email', defaultHidden:true },
];

const $ = s => document.querySelector(s);
const el = (t,c,h) => { const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e; };
const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// How "special topics" is defined — shown in the info-"i" bubble on the Special
// Topics filter and view. (Definition + source only, per the info-bubble convention.)
const ST_DEF = "A variable-content course whose specific topic changes each term — flagged when its catalog (shell) title is “Special Topics” / “Topics” (incl. Selected/Advanced Topics), or a section is titled “ST: …”. Source: the Registrar’s Historical Courses titles.";
// Floating hover tooltip for .info-i superscripts (matches the student/program trackers).
(function(){
  const tip=()=>{ let t=document.getElementById('info-tip'); if(!t){ t=document.createElement('div'); t.id='info-tip'; document.body.appendChild(t); } return t; };
  document.addEventListener('mouseover', e=>{ const el=e.target.closest&&e.target.closest('.info-i'); if(!el) return; const t=tip(); t.textContent=el.getAttribute('data-info')||''; t.style.display='block'; });
  document.addEventListener('mousemove', e=>{ const t=document.getElementById('info-tip'); if(!t||t.style.display!=='block') return; const pad=14,w=t.offsetWidth,h=t.offsetHeight; let x=e.clientX+pad,y=e.clientY+pad; if(x+w>window.innerWidth-8)x=e.clientX-w-pad; if(y+h>window.innerHeight-8)y=e.clientY-h-pad; t.style.left=x+'px'; t.style.top=y+'px'; });
  document.addEventListener('mouseout', e=>{ const el=e.target.closest&&e.target.closest('.info-i'); if(!el) return; const t=document.getElementById('info-tip'); if(t) t.style.display='none'; });
})();

// ── Visible-columns set (persisted; new cols default to visible unless hidden)
const _COLS_LS = 'sectrk-cols', _COLS_KNOWN_LS = 'sectrk-cols-known';
function _loadSectionCols(){
  let stored=null, known=[];
  try { stored = JSON.parse(localStorage.getItem(_COLS_LS) || 'null'); } catch(e){}
  try { known  = JSON.parse(localStorage.getItem(_COLS_KNOWN_LS) || '[]'); } catch(e){}
  const knownSet = new Set(known);
  const visible = Array.isArray(stored) ? new Set(stored)
    : new Set(SECTION_COLUMNS.filter(c=>!c.defaultHidden).map(c=>c.key));
  SECTION_COLUMNS.forEach(c=>{ if(!knownSet.has(c.key) && !c.defaultHidden) visible.add(c.key); });
  return visible;
}
let sectionVisibleCols = _loadSectionCols();
function _saveSectionCols(){
  try {
    localStorage.setItem(_COLS_LS, JSON.stringify([...sectionVisibleCols]));
    localStorage.setItem(_COLS_KNOWN_LS, JSON.stringify(SECTION_COLUMNS.map(c=>c.key)));
  } catch(e){}
}
// ---- column ORDER (drag-to-reorder in the ⊞ Columns picker; persisted per
// active view, like the student tracker). Order is applied at the single choke
// point visibleColumns(), so head + table + CSV export all honor it. ----
const _COL_ORDER_LS = 'sectrk-col-order-v1';
function _secColOrderMap(){ try { return JSON.parse(localStorage.getItem(_COL_ORDER_LS)||'{}')||{}; } catch(_){ return {}; } }
function _secColOrderScope(){ return activeViewId || '__default__'; }   // activeViewId defined later; resolved at call time
function _getSecColOrder(){ const a=_secColOrderMap()[_secColOrderScope()]; return Array.isArray(a)?a:null; }
function _setSecColOrder(arr){ const m=_secColOrderMap(); m[_secColOrderScope()]=arr; try{ localStorage.setItem(_COL_ORDER_LS, JSON.stringify(m)); }catch(_){} }
function _clearSecColOrder(){ const m=_secColOrderMap(), k=_secColOrderScope(); if(k in m){ delete m[k]; try{ localStorage.setItem(_COL_ORDER_LS, JSON.stringify(m)); }catch(_){} } }
// SECTION_COLUMNS reordered by the saved order for the active scope; any column
// not in the saved order (e.g. a newly-added one) is appended in definition
// order so nothing ever vanishes.
function orderedSectionCols(){
  const order=_getSecColOrder();
  if(!order) return SECTION_COLUMNS.slice();
  const byKey=new Map(SECTION_COLUMNS.map(c=>[c.key,c])); const out=[];
  order.forEach(k=>{ if(byKey.has(k)){ out.push(byKey.get(k)); byKey.delete(k); } });
  SECTION_COLUMNS.forEach(c=>{ if(byKey.has(c.key)) out.push(c); });
  return out;
}
function visibleColumns(){ return orderedSectionCols().filter(c=>sectionVisibleCols.has(c.key)); }

// ---------- load ----------
async function load() {
  let data;
  if (window._loadSections) { data = await window._loadSections(); }
  else { data = await (await fetch(API + '/api/sections')).json(); }
  allSections = data.sections || [];
  lastFetch = data.last_fetch || '';
  refreshDate = data.refresh_date || '';
  bakedPerTerm = data.per_term || null;
  // keep only selected terms that exist; if none remain, default to Fall 2026 (or the first)
  const terms = availableTerms();
  if (!Array.isArray(filters.term)) filters.term = filters.term ? [filters.term] : [];
  filters.term = filters.term.filter(t => terms.includes(t));
  if (!filters.term.length && terms.length) filters.term = [terms.includes('Fall 2026') ? 'Fall 2026' : terms[0]];
  // Always-visible (everyone), same location/format as the program & student trackers:
  // "Updated: <mon d> at <time> ET" + "Build: <mon d, yyyy, time> ET".
  $('#last-updated').textContent = lastFetch ? ('Updated: ' +
    new Date(lastFetch).toLocaleDateString('en-US', {month:'short', day:'numeric', timeZone:'America/New_York'}) + ' at ' +
    new Date(lastFetch).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', timeZone:'America/New_York'}) + ' ET') : '';
  const _buildEl = $('#app-build');
  if (_buildEl) _buildEl.textContent = data.built_at ? ('Build: ' +
    new Date(data.built_at).toLocaleString('en-US', {timeZone:'America/New_York', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'}) + ' ET') : '';
  // Tableau/Airtable connection dots moved to the shared login console
  // (console/app.py :5099) — the check functions were removed.
  // Staleness banner is a LOCAL-app feature only (owner). On the shared static
  // site, the always-visible refresh/build times above are the staleness signal.
  if (!STATIC) renderSourceHealthBanner(data.source_health);
  // hydrate team views (static: baked; local: API)
  await hydrateTeamViews(data);
  initStarredIfNeeded();   // seed tiles from shipped starred:true views
  hideStaticOnlyHeader();
  applyFiltersState();     // filters start collapsed on every load
  populateFilters();
  { const fi=$('#f-special-info'); if(fi) fi.dataset.info=ST_DEF; }  // info-"i" bubble on the Special Topics filter
  // Deep-link: ?view=<saved-view name> (from the console's Needs You pane) opens
  // straight to that view; else restore the last active view.
  let _dqv = null;
  try { _dqv = new URLSearchParams(location.search).get('view'); } catch(_){}
  const _named = _dqv && getAllViews().find(v => v.name === _dqv);
  let restore = null;
  try { restore = localStorage.getItem(_ACTIVE_LS); } catch(_){}
  if (_named) applyView(_named.id);
  else if (restore && getViewById(restore)) applyView(restore);
  else renderAll();
}
function fmtTime(iso){ try { return new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET'; } catch(e){ return iso; } }
// Source-data staleness banner — amber, dismissible, top of every view. Warns when
// a batch input's last successful read is older than stale_days (default 3). Driven
// by the baked/served `source_health` payload, so it works on both the local app and
// the shared static site (if the daily scan stalls, the baked timestamp freezes and
// the client sees it as stale). Airtable notes are live-read, so not a source here.
function renderSourceHealthBanner(sh){
  const box=$('#source-banner'); if(!box) return;
  box.innerHTML='';
  if(!sh || !Array.isArray(sh.sources)) return;
  const days=sh.stale_days||3, now=Date.now(), stale=[];
  sh.sources.forEach(s=>{
    if(!s.last_success){ stale.push({name:s.name, age:null}); return; }
    const t=Date.parse(s.last_success); if(isNaN(t)) return;
    const age=Math.floor((now-t)/86400000);
    if(age>=days) stale.push({name:s.name, age});
  });
  if(!stale.length) return;
  // dismissal keyed by the stale signature, so a new/worse staleness re-appears
  const sig=stale.map(s=>s.name+':'+(s.age==null?'never':s.age)).join('|');
  try{ if(localStorage.getItem('sectrk-srcbanner-dismissed')===sig) return; }catch(_){}
  const parts=stale.map(s=> s.age==null ? `${esc(s.name)} — never loaded`
    : `${esc(s.name)} — last updated ${s.age} day${s.age===1?'':'s'} ago`);
  const div=el('div','source-banner-inner');
  div.innerHTML=`<span class="sb-icon">⚠</span><span class="sb-text"><strong>Source data may be stale.</strong> ${parts.join(' · ')} (alerts after ${days} days).</span>`;
  const x=el('button','sb-dismiss','✕'); x.title='Dismiss';
  x.onclick=()=>{ try{ localStorage.setItem('sectrk-srcbanner-dismissed', sig); }catch(_){}; box.innerHTML=''; };
  div.appendChild(x); box.appendChild(div);
}

// Collapsible top filter panel — session-only, ALWAYS collapsed on page load
// (not remembered across reloads), so the page always opens with filters hidden.
// Copied from the student tracker's ▸ Filters toggle.
let _filtersOpen = false;
function applyFiltersState(){
  document.body.classList.toggle('filters-collapsed', !_filtersOpen);
  const btn = document.getElementById('filter-toggle-btn');
  if (btn) btn.textContent = _filtersOpen ? '▾ Filters' : '▸ Filters';
}
function toggleFilters(){ _filtersOpen = !_filtersOpen; applyFiltersState(); }

// On the static site there's no local server — hide Console + Update controls.
function hideStaticOnlyHeader(){
  if(!STATIC) return;
  ['#console-btn'].forEach(sel=>{ const e=$(sel); if(e) e.style.display='none'; });
}

function uniq(key){ return [...new Set(allSections.map(s=>s[key]).filter(Boolean))].sort(); }
function populateFilters(){
  populateTermButtons();
  MS_KEYS.forEach(renderMulti);
}

// ---------- checkbox multi-select filters (College / Campus / Modality / Subject) ----------
// Empty selection = ALL (no filter), so each "starts with all". Panel opens on click; each
// option shows a cross-filtered count. Label: "All" / the single value / "N selected".
const MS_KEYS = ['college', 'campus', 'modality', 'subject'];
const _MS = {
  college:  { field: 'college',              order: null,      opt: v => abbr(v) + ' — ' + v, short: abbr },
  campus:   { field: 'campus',               order: null,      opt: v => v,                   short: v => v },
  modality: { field: 'instructional_method', order: MOD_ORDER, opt: v => modShort(v),         short: modShort },
  subject:  { field: 'subject',              order: null,      opt: v => v,                   short: v => v },
};
function msValues(key){
  const cfg = _MS[key];
  const vals = [...new Set(allSections.map(s => s[cfg.field]).filter(Boolean))];
  if (cfg.order) {
    const o = cfg.order;
    vals.sort((a, b) => ((o.indexOf(a) < 0 ? 99 : o.indexOf(a)) - (o.indexOf(b) < 0 ? 99 : o.indexOf(b))) || a.localeCompare(b));
  } else {
    vals.sort((a, b) => a.localeCompare(b));
  }
  return vals;
}
function msCounts(key){
  const cfg = _MS[key], m = {};
  baseFiltered(key).forEach(s => { const v = s[cfg.field]; if (v) m[v] = (m[v] || 0) + 1; });
  return m;
}
function msLabel(key){
  const a = filters[key];
  if (a === null) return 'All';
  if (a.length === 0) return 'None';
  if (a.length === 1) return _MS[key].short(a[0]);
  return a.length + ' selected';
}
function renderMulti(key){
  const host = $('#ms-' + key); if (!host) return;
  host.innerHTML =
    `<button type="button" class="ms-btn" onclick="toggleMsPanel('${key}',event)">` +
      `<span class="ms-label" id="ms-label-${key}">${esc(msLabel(key))}</span><span class="ms-caret">▾</span></button>` +
    `<div class="ms-panel" id="ms-panel-${key}" hidden></div>`;
}
// A value is checked when the filter is "all" (null) or the value is in the chosen set.
function msChecked(key, v){ const a = filters[key]; return a === null || a.includes(v); }
function msRenderPanel(key){
  const cfg = _MS[key], panel = $('#ms-panel-' + key); if (!panel) return;
  const counts = msCounts(key);
  const rows = msValues(key).map(v =>
    `<label><input type="checkbox" ${msChecked(key, v) ? 'checked' : ''} ` +
    `onchange="toggleMsValue('${key}','${_escJs(v)}')"><span class="ms-opt">${esc(cfg.opt(v))}</span>` +
    `<span class="ms-count">${counts[v] || 0}</span></label>`).join('');
  panel.innerHTML =
    `<label class="ms-all"><input type="checkbox" id="ms-all-${key}" onchange="msAll('${key}')"> All</label>${rows}`;
  msSyncAllCb(key);
}
// The header "All" checkbox: checked when all (null), unchecked when none ([]),
// indeterminate when a partial subset is chosen.
function msSyncAllCb(key){
  const cb = $('#ms-all-' + key); if (!cb) return;
  const a = filters[key], n = msValues(key).length;
  cb.checked = (a === null);
  cb.indeterminate = (a !== null && a.length > 0 && a.length < n);
}
function msSyncLabels(){ MS_KEYS.forEach(k => { const el = $('#ms-label-' + k); if (el) el.textContent = msLabel(k); }); }
function closeAllMsPanels(){ document.querySelectorAll('.ms-panel').forEach(p => p.hidden = true); }
window.toggleMsPanel = (key, ev) => {
  if (ev) ev.stopPropagation();
  const p = $('#ms-panel-' + key); if (!p) return;
  const wasHidden = p.hidden; closeAllMsPanels();
  if (wasHidden) { msRenderPanel(key); p.hidden = false; }
};
window.toggleMsValue = (key, v) => {
  // Native checkbox already toggled. Expand null (all) to a concrete list on first uncheck;
  // collapse back to null when every value ends up checked. No list rebuild (keeps scroll).
  let a = filters[key];
  if (a === null) a = msValues(key).slice();
  const i = a.indexOf(v);
  if (i >= 0) a.splice(i, 1); else a.push(v);
  if (a.length === msValues(key).length) a = null;
  filters[key] = a;
  msSyncAllCb(key);   // header All box: all/none/indeterminate
  renderAll();
};
// "All" toggle: select-all when not currently all, else unselect-all. Update the option
// checkboxes IN PLACE (no innerHTML rebuild — rebuilding would detach the just-clicked
// checkbox mid-event and trip the outside-click close handler).
window.msAll = (key) => {
  const cb = $('#ms-all-' + key);
  const selectAll = !!(cb && cb.checked);
  filters[key] = selectAll ? null : [];
  const panel = $('#ms-panel-' + key);
  if (panel) panel.querySelectorAll('label:not(.ms-all) input').forEach(inp => { inp.checked = selectAll; });
  msSyncAllCb(key);
  renderAll();
};

// Per-filter clear (the superscript × shown on each active filter's label).
window.clearOneFilter = (key) => {
  if (MS_KEYS.includes(key)) filters[key] = null;
  else if (key === 'special') filters.special = '';
  else if (key === 'prior') filters.priorTerms = '';
  syncFilterControls(); renderAll();
};
// Show a filter's × only when it's active (a subset/none for multis; a set value for the
// single selects). null (all) / '' (any) = inactive = hidden ×.
function syncFilterX(){
  const active = { college: filters.college!==null, campus: filters.campus!==null,
    modality: filters.modality!==null, subject: filters.subject!==null,
    special: filters.special!=='', prior: filters.priorTerms!=='' };
  Object.keys(active).forEach(k => { const el=$('#fx-'+k); if(el) el.hidden = !active[k]; });
}

// Render the multi-select Term button row (All + one toggle per available term).
function populateTermButtons(){
  const row=$('#term-row'); if(!row) return;
  const terms=availableTerms();
  row.innerHTML='<span class="row-label">Term</span>'+
    `<button class="proposal-btn" data-term="" onclick="setTerm('')">All terms</button>`+
    terms.map(t=>`<button class="proposal-btn" data-term="${esc(t)}" onclick="setTerm('${esc(t).replace(/'/g,"\\'")}')">${esc(t)}</button>`).join('');
}

// ---------- filtering ----------
function availableTerms(){
  return [...new Set(allSections.map(s=>s.term).filter(Boolean))].sort((a,b)=>termRank(a)-termRank(b));
}
function baseFiltered(skip){
  return allSections.filter(s=>{
    if(skip!=='term' && filters.term.length && !filters.term.includes(s.term)) return false;
    if(skip!=='college' && filters.college!==null && !filters.college.includes(s.college)) return false;
    if(skip!=='campus' && filters.campus!==null && !filters.campus.includes(s.campus)) return false;
    if(skip!=='subject' && filters.subject!==null && !filters.subject.includes(s.subject)) return false;
    if(skip!=='modality' && filters.modality!==null && !filters.modality.includes(s.instructional_method)) return false;
    if(skip!=='level' && filters.level && s.level!==filters.level) return false;
    if(skip!=='special' && filters.special){
      if(filters.special==='Y' && s.special_topics!=='Yes') return false;
      if(filters.special==='N' && s.special_topics==='Yes') return false;
    }
    if(skip!=='prior' && filters.priorTerms!==''){
      // Two models: the classic control sets a single min threshold (a string
      // number); the left-rail `num` field sets a {min,max} range. Honor both so
      // a filter set in one layout still reads in the other (adoption brief §4).
      const to=(+s.times_offered||0), pt=filters.priorTerms;
      if(pt && typeof pt==='object'){
        if(pt.min!=null && to<pt.min) return false;
        if(pt.max!=null && to>pt.max) return false;
      } else if(to < +pt) return false;
    }
    if(skip!=='resolved' && filters.resolved){
      if(filters.resolved==='yes' && !s.modality_resolved) return false;
      if(filters.resolved==='no' && s.modality_resolved) return false;
      if(filters.resolved==='notes' && !(s.notes&&s.notes.trim())) return false;
    }
    if(skip!=='search' && filters.search){
      const q=filters.search.toLowerCase();
      if(!((s.course_code+' '+s.title+' '+s.crn+' '+s.faculty_name+' '+s.section).toLowerCase().includes(q))) return false;
    }
    return true;
  });
}
// getFiltered = top-bar filters AND the applied advanced view tree.
const getFiltered = () => baseFiltered(null).filter(s => evalNode(s, appliedTree));

// ---------- render ----------
function renderAll(){ renderViewTiles(); syncButtonRows(); msSyncLabels(); syncFilterX(); renderHead(); renderTable();
  if(window.trackerShell) window.trackerShell.refresh(); }   // keep the left-rail shell in sync (no-op in classic)

// button-row active-state sync
function syncButtonRows(){
  const rmap={'':'active-all','yes':'active-yes','no':'active-no','notes':'active-notes'};
  document.querySelectorAll('#resolved-row .proposal-btn').forEach(b=>{
    b.classList.remove('active-all','active-yes','active-no','active-notes');
    if(b.dataset.v===filters.resolved) b.classList.add(rmap[filters.resolved]);
  });
  document.querySelectorAll('#level-row .proposal-btn').forEach(b=>{
    b.classList.toggle('active-all', b.dataset.v===(filters.level||''));
  });
  document.querySelectorAll('#term-row .proposal-btn').forEach(b=>{
    const t=b.dataset.term;
    const on = t==='' ? filters.term.length===0 : filters.term.includes(t);
    b.classList.toggle('active-all', on);
  });
}

function renderHead(){
  const tr=$('#thead-row'); tr.innerHTML='';
  visibleColumns().forEach(c=>{
    const th=el('th',null,esc(c.label)+(sort.key===c.key?` <span class="arrow">${sort.dir>0?'▲':'▼'}</span>`:''));
    th.onclick=()=>{ if(sort.key===c.key)sort.dir*=-1; else {sort.key=c.key;sort.dir=1;} renderHead(); renderTable(); };
    tr.appendChild(th);
  });
}

// Plain-text value for one section column (used by table render + CSV export).
function colText(s, key){
  const c = SECTION_COLUMNS.find(x=>x.key===key);
  if(key==='modality_resolved') return s.modality_resolved ? 'Yes' : 'No';
  if(key==='notes')            return (s.notes||'');
  let v = s[key];
  if(c && c.fmt) v = c.fmt(v);
  return (v==null?'':String(v));
}
// HTML cell for one section column.
function colCell(s, key){
  if(key==='course_code') return `<td class="code"><button class="code-open" onclick="openSectionDrawer('${_escJs(s.id)}')" title="Open section detail">${esc(s.course_code)}</button></td>`;
  if(key==='college')     return `<td title="${esc(s.college)}">${esc(abbr(s.college))}</td>`;
  if(key==='campus')      return `<td class="muted">${esc(s.campus)}</td>`;
  if(key==='instructional_method') return `<td><span class="${modClass(s.instructional_method)}">${esc(s.instructional_method||'—')}</span></td>`;
  if(key==='level')       return `<td><span class="pill lvl">${esc(s.level||'—')}</span></td>`;
  if(key==='total_enrolled') return `<td class="enr">${(+s.total_enrolled||0)}</td>`;
  if(key==='faculty_name') return `<td class="muted">${esc(s.faculty_name||'—')}</td>`;
  if(key==='modality_resolved'){
    if(ADMIN) return `<td><button class="res-toggle ${s.modality_resolved?'res-yes':'res-no'}" onclick="toggleResolvedInline('${_escJs(s.id)}',event)" title="Click to toggle Modality Resolved">${s.modality_resolved?'Yes':'No'}</button></td>`;
    return `<td>${s.modality_resolved?'<span class="resolved-yes">Yes</span>':'<span class="resolved-no">No</span>'}</td>`;
  }
  if(key==='notes')       return `<td>${s.notes&&s.notes.trim()?'<span class="has-note">📝</span>':''}</td>`;
  if(key==='faculty_email') return `<td class="muted">${esc(s.faculty_email||'—')}</td>`;
  if(key==='special_topics') return `<td>${s.special_topics==='Yes'?'<span class="pill" style="background:#ede9fe;color:#6d28d9">ST</span>':''}</td>`;
  if(key==='times_offered')  return `<td class="enr">${(s.times_offered==null||s.times_offered==='')?'<span class="muted">—</span>':(+s.times_offered)}</td>`;
  return `<td>${esc(s[key]||'')}</td>`;
}

function renderTable(){
  const rows=sortedFiltered();
  $('#summary').innerHTML = `<b>${rows.length.toLocaleString()}</b> of ${allSections.length.toLocaleString()} sections`+
    ` · <b>${rows.reduce((n,s)=>n+(+s.total_enrolled||0),0).toLocaleString()}</b> seats enrolled`;
  const cols=visibleColumns(), ncol=cols.length;
  const tb=$('#tbody'); tb.innerHTML='';
  rows.slice(0,2000).forEach(s=>{
    const tr=el('tr','program-row '+rowModClass(s.instructional_method)+(drawerId===s.id?' expanded':''));
    tr.dataset.id = s.id;
    tr.innerHTML = cols.map(c=>colCell(s,c.key)).join('');
    tb.appendChild(tr);
  });
  if(rows.length>2000){ const tr=el('tr'); tr.innerHTML=`<td colspan="${ncol}" class="muted" style="text-align:center;padding:12px">Showing first 2,000 of ${rows.length.toLocaleString()} — narrow filters to see the rest.</td>`; tb.appendChild(tr); }
}

// Apply the active sort to the filtered rows (shared by render + CSV export).
function sortedFiltered(){
  const rows=getFiltered();
  rows.sort((a,b)=>{
    const col=SECTION_COLUMNS.find(c=>c.key===sort.key);
    let x=a[sort.key], y=b[sort.key];
    if(col&&col.num){ return ((+x||0)-(+y||0))*sort.dir; }
    x=(x==null?'':String(x)).toLowerCase(); y=(y==null?'':String(y)).toLowerCase();
    return x<y?-sort.dir:x>y?sort.dir:0;
  });
  return rows;
}

// ── Section detail drawer (right-side panel; replaces inline row expansion) ──
// Ported from the grad tracker's student drawer: clicking a course opens a
// sliding panel hosting renderDetail(s); the open row gets a `.expanded` marker
// applied WITHOUT a full re-render (a re-render on every click loses scroll and
// rebuilds up to 2,000 rows).
function _ensureSectionDrawer(){
  let d=document.getElementById('section-drawer');
  if(d) return d;
  d=document.createElement('div');
  d.id='section-drawer';
  d.innerHTML=`<div class="sd-backdrop" onclick="closeSectionDrawer()"></div>
     <div class="sd-panel" role="dialog" aria-label="Section record">
        <div class="sd-head">
          <span id="sd-title" class="sd-title"></span>
          <button class="sd-close" title="Close (Esc)" onclick="closeSectionDrawer()">&times;</button>
        </div>
        <div id="sd-body" class="sd-body"></div>
     </div>`;
  document.body.appendChild(d);
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeSectionDrawer(); });
  return d;
}
// Move the `.expanded` highlight to one row without a full table re-render.
function _markExpandedRow(id){
  document.querySelectorAll('#tbody tr.program-row.expanded').forEach(r=>r.classList.remove('expanded'));
  if(id){ const r=document.querySelector('#tbody tr.program-row[data-id="'+_cssAttr(id)+'"]'); if(r) r.classList.add('expanded'); }
}
function _cssAttr(v){ return String(v==null?'':v).replace(/"/g,'\\"'); }
function openSectionDrawer(id){
  const s=allSections.find(x=>x.id===id); if(!s) return;
  drawerId=id;
  const d=_ensureSectionDrawer();
  document.getElementById('sd-title').innerHTML=esc(s.course_code)+(s.title?' <span class="sd-sub">'+esc(s.title)+'</span>':'');
  const body=document.getElementById('sd-body'); body.innerHTML='';
  body.appendChild(renderDetail(s));      // renderDetail returns a DOM node → handlers preserved
  d.classList.add('open');
  _markExpandedRow(id);                    // lightweight marker, not a full re-render
}
function closeSectionDrawer(){
  const d=document.getElementById('section-drawer');
  if(d) d.classList.remove('open');
  drawerId=null;
  _markExpandedRow(null);
}
window.openSectionDrawer=openSectionDrawer;
window.closeSectionDrawer=closeSectionDrawer;

function renderDetail(s){
  const d=el('div','detail-doc');
  const val=v=>(v==null||v==='')?'—':esc(v);
  const df=(label,v)=>`<div class="df"><span class="lbl">${esc(label)}</span><span class="val">${val(v)}</span></div>`;
  const dsec=(title,fieldsHtml)=>{ const sec=el('div','dsec');
    sec.innerHTML='<h4>'+title+'</h4><div class="dfields">'+fieldsHtml+'</div>'; return sec; };

  d.appendChild(dsec('Section', [
    df('CRN', s.crn), df('Course', s.course_code),
    df('Course title', s.course_title || s.title),
    df('Section', s.section), df('Section title', s.title),
    df('College', s.college), df('Campus', s.campus), df('Level', s.level),
    df('Schedule', s.schedule), df('Enrolled', s.total_enrolled), df('Honors', s.honors_ind),
    df('Special topics', s.special_topics==='Yes' ? 'Yes' : 'No'),
    df('Prior terms offered', (s.times_offered==null||s.times_offered==='') ? '—' : s.times_offered),
  ].join('')));

  d.appendChild(dsec('Modality &amp; logistics', [
    df('Instructional method', s.instructional_method), df('Meeting time', s.meeting_time),
    df('Location', s.location), df('Faculty', s.faculty_name), df('Faculty email', s.faculty_email),
    df('Faculty type', s.faculty_type), df('Attributes', s.attributes),
  ].join('')));

  // Previous offerings of this special-topics course's topic (earlier terms only).
  if(s.special_topics==='Yes'){
    let prev=s.previous_offerings;
    if(typeof prev==='string'){ try{ prev=JSON.parse(prev||'[]'); }catch(_){ prev=[]; } }
    if(!Array.isArray(prev)) prev=[];
    const po=el('div','dsec');
    po.innerHTML='<h4>Previous offerings'+(prev.length?` (${prev.length})`:'')+'</h4>';
    if(prev.length){
      po.innerHTML+='<div class="dlist">'+prev.map(o=>{
        const term=(o.term||'').replace(/\s+Semester$/,'');
        const parts=[o.title||'', o.instructor||''];
        if(o.sections>1) parts.push(o.sections+' sections');
        if(o.enrolled!=null&&o.enrolled!=='') parts.push(o.enrolled+' enrolled');
        return '<div><b>'+esc(term)+'</b> — '+esc(parts.filter(Boolean).join(' · ')||'—')+'</div>';
      }).join('')+'</div>';
    } else {
      po.innerHTML+='<div class="muted">No previous offerings on record.</div>';
    }
    d.appendChild(po);
  }

  const resWrap=el('div','dsec'); resWrap.innerHTML='<h4>Modality Resolved</h4>';
  const tog=el('button','switch'+(s.modality_resolved?' on':'')); tog.innerHTML='<span class="knob"></span>';
  const tl=el('span',null,s.modality_resolved?'Yes':'No');
  const wrap=el('div','toggle'); wrap.appendChild(tog); wrap.appendChild(tl);
  if(ADMIN){
    tog.onclick=async()=>{ const nv=!s.modality_resolved; tog.disabled=true;
      const r=await saveResolvedField(s,nv); tog.disabled=false;
      if(r&&r.ok){ s.modality_resolved=nv; tog.className='switch'+(nv?' on':''); tl.textContent=nv?'Yes':'No'; toast('Modality Resolved → '+(nv?'Yes':'No')); renderViewTiles(); }
      else toast('Save failed'); };
  } else { tog.disabled=true; wrap.appendChild(el('span','readonly-note','  (set by the Graduate Dean’s office)')); }
  resWrap.appendChild(wrap); d.appendChild(resWrap);

  const isLC=['Live Cast','Video Streaming'].includes(s.instructional_method);
  const noteWrap=el('div','dsec'); noteWrap.innerHTML='<h4>'+(isLC?'Live Cast justification':'College notes')+'</h4>';
  const ta=el('textarea','note-box'); ta.value=s.notes||'';
  ta.placeholder=isLC?'Why is this section offered via Live Cast? (college justification)…':'Add a note about this section…';
  const actions=el('div','note-actions');
  const save=el('button','header-secondary-btn','Save note'); save.style.cssText='border-color:var(--accent);color:var(--accent)';
  const saved=el('span','note-saved'); saved.style.display='none'; saved.textContent='Saved ✓';
  const who=s.updated_by?el('span','muted','last edited by '+esc(s.updated_by)):el('span');
  save.onclick=async()=>{ save.disabled=true; const r=await saveNoteField(s,ta.value); save.disabled=false;
    if(r&&r.ok){ s.notes=ta.value; saved.style.display=''; setTimeout(()=>saved.style.display='none',2000); renderViewTiles(); }
    else toast('Save failed'); };
  actions.appendChild(save); actions.appendChild(saved); actions.appendChild(who);
  noteWrap.appendChild(ta); noteWrap.appendChild(actions); d.appendChild(noteWrap);
  return d;
}

// ---------- saves (overridable for static/Airtable-direct) ----------
async function saveNoteField(s, notes){
  if(window._saveNote) return window._saveNote(s, notes);
  return (await fetch(API+`/api/section/${encodeURIComponent(s.crn)}/note`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notes, term:s.term, course:s.course_code, college:s.college, updated_by:window._editor||''})})).json();
}
async function saveResolvedField(s, val){
  if(window._saveResolved) return window._saveResolved(s, val);
  return (await fetch(API+`/api/section/${encodeURIComponent(s.crn)}/resolved`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({resolved:val, term:s.term, course:s.course_code, college:s.college, updated_by:'owner'})})).json();
}
// Inline toggle from the course-list Resolved cell (admin only).
async function toggleResolvedInline(id, event){
  if(event) event.stopPropagation();
  const s = allSections.find(x=>x.id===id); if(!s) return;
  const btn = event && event.currentTarget;
  const nv = !s.modality_resolved;
  if(btn) btn.disabled = true;
  const r = await saveResolvedField(s, nv);
  if(btn) btn.disabled = false;
  if(r && r.ok){
    s.modality_resolved = nv;
    if(btn){ btn.textContent = nv?'Yes':'No'; btn.className = 'res-toggle '+(nv?'res-yes':'res-no'); }
    toast('Modality Resolved → '+(nv?'Yes':'No'));
    renderViewTiles();
  } else { toast('Save failed'); }
}
window.toggleResolvedInline = toggleResolvedInline;

// ══════════════════════════════════════════════════════════════════════════
// Columns picker
// ══════════════════════════════════════════════════════════════════════════
let _colPickerQuery='';
function toggleSectionColPicker(e){
  e.stopPropagation();
  const dd=$('#section-col-dropdown'); if(!dd) return;
  if(dd.classList.contains('open')){ dd.classList.remove('open'); return; }
  _colPickerQuery='';           // fresh search each time it opens
  _rebuildColDropdown(dd);
  dd.classList.add('open');
  const s=$('#col-picker-search'); if(s) s.focus();
}
function _rebuildColDropdown(dd){
  const rows = orderedSectionCols().map(c=>`
      <label class="portfolio-col-check col-drag-row" draggable="true" data-key="${c.key}"
             data-label="${esc(c.label.toLowerCase())}"
             ondragstart="_secColDragStart(event)" ondragover="_secColDragOver(event)"
             ondrop="_secColDrop(event)" ondragend="_secColDragEnd(event)">
        <input type="checkbox" ${sectionVisibleCols.has(c.key)?'checked':''}
               onchange="toggleSectionCol('${c.key}',this.checked)" onclick="event.stopPropagation()">
        <span class="col-item-lbl">${esc(c.label)}</span>
        <span class="col-drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
      </label>`).join('');
  dd.innerHTML =
    `<input type="text" class="portfolio-col-search" id="col-picker-search" placeholder="Search columns…"
            value="${esc(_colPickerQuery)}" oninput="filterColPicker(this.value)"
            onclick="event.stopPropagation()">
     <div class="col-pick-hint">Drag <span aria-hidden="true">⠿</span> to reorder</div>
     <div class="portfolio-col-selectall">
        <button onclick="toggleAllSectionCols(true)">Select All</button>
        <button onclick="toggleAllSectionCols(false)">Unselect All</button>
        <button onclick="resetSectionColOrder()">Reset order</button>
     </div>` + rows;
  if(_colPickerQuery) _applyColFilter();
}
window.filterColPicker=(q)=>{ _colPickerQuery=q||''; _applyColFilter(); };
function _applyColFilter(){
  const q=_colPickerQuery.trim().toLowerCase();
  document.querySelectorAll('#section-col-dropdown .portfolio-col-check').forEach(el=>{
    el.style.display = (!q || (el.getAttribute('data-label')||'').includes(q)) ? '' : 'none';
  });
}
function toggleSectionCol(key, vis){
  if(vis) sectionVisibleCols.add(key); else sectionVisibleCols.delete(key);
  _saveSectionCols();
  renderHead(); renderTable();
}
function toggleAllSectionCols(vis){
  if(vis) SECTION_COLUMNS.forEach(c=>sectionVisibleCols.add(c.key));
  else sectionVisibleCols.clear();
  _saveSectionCols();
  const dd=$('#section-col-dropdown'); if(dd&&dd.classList.contains('open')) _rebuildColDropdown(dd);
  renderHead(); renderTable();
}
// ---- drag-to-reorder for the column picker (ported from the student tracker):
// hide the dragged row, slide a dashed placeholder to the landing slot (with a
// FLIP animation on the other rows), then persist the new order on drop. ----
let _secColDragEl=null, _secColPh=null;
function _secColDragStart(ev){
  _secColDragEl=ev.currentTarget;
  ev.dataTransfer.effectAllowed='move';
  try{ ev.dataTransfer.setData('text/plain', _secColDragEl.dataset.key||''); }catch(_){}
  const ph=document.createElement('div');
  ph.className='portfolio-col-check col-placeholder';
  ph.style.height=_secColDragEl.offsetHeight+'px';
  _secColPh=ph;
  setTimeout(()=>{ if(!_secColDragEl)return; _secColDragEl.parentNode.insertBefore(ph,_secColDragEl.nextSibling); _secColDragEl.style.display='none'; },0);
}
function _secColFlip(container, ref, node){
  const items=[...container.querySelectorAll('.portfolio-col-check')].filter(el=>el!==_secColDragEl && el!==node);
  const firstTop=new Map(); items.forEach(el=>firstTop.set(el, el.getBoundingClientRect().top));
  container.insertBefore(node, ref);
  items.forEach(el=>{ const prev=firstTop.get(el); if(prev==null)return; const dy=prev-el.getBoundingClientRect().top; if(!dy)return;
    el.style.transition='none'; el.style.transform='translateY('+dy+'px)'; el.getBoundingClientRect();
    el.style.transition='transform 140ms ease'; el.style.transform=''; });
}
function _secColDragOver(ev){
  ev.preventDefault(); ev.dataTransfer.dropEffect='move';
  const over=ev.currentTarget, ph=_secColPh;
  if(!ph||over===ph)return;
  const r=over.getBoundingClientRect(); const after=(ev.clientY-r.top)>r.height/2;
  const ref=after?over.nextSibling:over;
  if(ref===ph||ph.nextSibling===ref)return;
  _secColFlip(over.parentNode, ref, ph);
}
function _secColDrop(ev){ ev.preventDefault(); }
function _secColDragEnd(){
  const drag=_secColDragEl, ph=_secColPh; _secColDragEl=null; _secColPh=null;
  if(drag&&ph&&ph.parentNode) ph.parentNode.insertBefore(drag, ph);
  if(ph) ph.remove(); if(drag) drag.style.display='';
  const dd=$('#section-col-dropdown'); if(!dd)return;
  const keys=[...dd.querySelectorAll('.portfolio-col-check')]
    .filter(d=>!d.classList.contains('col-placeholder')).map(d=>d.dataset.key).filter(Boolean);
  _setSecColOrder(keys);
  renderHead(); renderTable();
}
function resetSectionColOrder(){ _clearSecColOrder(); const dd=$('#section-col-dropdown'); if(dd) _rebuildColDropdown(dd); renderHead(); renderTable(); }
document.addEventListener('click', e=>{
  const picker=$('#section-col-picker');
  if(picker && !picker.contains(e.target)){
    const dd=$('#section-col-dropdown'); if(dd) dd.classList.remove('open');
  }
});

// ══════════════════════════════════════════════════════════════════════════
// Views — filter-tree engine + modal (ported from the program tracker)
// ══════════════════════════════════════════════════════════════════════════
const SECTION_FILTER_FIELDS = [
  {key:'term',        label:'Term',             type:'select', value:s=>s.term||''},
  {key:'college',     label:'College',          type:'select', value:s=>s.college||''},
  {key:'campus',      label:'Campus',           type:'select', value:s=>s.campus||''},
  {key:'subject',     label:'Subject',          type:'select', value:s=>s.subject||''},
  {key:'course',      label:'Course',           type:'text',   value:s=>s.course_code||''},
  {key:'title',       label:'Title',            type:'text',   value:s=>s.title||''},
  {key:'modality',    label:'Modality',         type:'select', value:s=>s.instructional_method||''},
  {key:'level',       label:'Level',            type:'select', value:s=>s.level||''},
  {key:'schedule',    label:'Schedule',         type:'select', value:s=>s.schedule||''},
  {key:'meeting_time',label:'Meeting Time',     type:'text',   value:s=>s.meeting_time||''},
  {key:'faculty',     label:'Faculty',          type:'text',   value:s=>s.faculty_name||''},
  {key:'faculty_type',label:'Faculty Type',     type:'select', value:s=>s.faculty_type||''},
  {key:'enrolled',    label:'Enrolled',         type:'text',   value:s=>String(s.total_enrolled==null?'':s.total_enrolled)},
  {key:'resolved',    label:'Modality Resolved',type:'boolean',value:s=>s.modality_resolved?'Y':'N'},
  {key:'has_notes',   label:'Has Notes',        type:'boolean',value:s=>(s.notes&&s.notes.trim())?'Y':'N'},
  {key:'special_topics',label:'Special Topics', type:'boolean',value:s=>s.special_topics==='Yes'?'Y':'N'},
  {key:'times_offered',label:'Prior Terms',      type:'number', value:s=>s.times_offered},
  {key:'topic_class', label:'Topic Type',        type:'select', value:s=>s.topic_class||''},
  {key:'updated_by',  label:'Updated By',       type:'text',   value:s=>s.updated_by||''},
];
function _svField(key){ return SECTION_FILTER_FIELDS.find(f=>f.key===key); }
function getFieldValues(key){
  const f=_svField(key); if(!f) return [];
  const set=new Set();
  allSections.forEach(s=>set.add(f.value(s)));
  return [...set].sort((a,b)=>String(a).localeCompare(String(b)));
}

let appliedTree = null;   // currently-applied advanced filter (or null)
function makeEmptyGroup(conj){ return {type:'group', conj:conj||'all', children:[]}; }

function evalNode(s, node){
  if(!node) return true;
  if(node.type==='group'){
    const kids=node.children||[];
    if(!kids.length) return true;
    return node.conj==='any' ? kids.some(c=>evalNode(s,c)) : kids.every(c=>evalNode(s,c));
  }
  if(node.type==='rule') return evalRule(s, node);
  return true;
}
function evalRule(s, rule){
  const f=_svField(rule.field); if(!f) return true;
  let v=String(f.value(s)==null?'':f.value(s));
  const op=rule.op||'';
  if(op==='is_set')   return v!=='';
  if(op==='is_empty') return v==='';
  if(f.type==='number'){
    if(v==='') return false;               // blank never satisfies a comparison
    const n=parseFloat(v), q=parseFloat(rule.value);
    if(isNaN(q)) return true;              // threshold not set yet → don't restrict
    if(op==='>=') return n>=q;
    if(op==='<=') return n<=q;
    if(op==='=')  return n===q;
    return true;
  }
  if(f.type==='text'){
    if(!rule.value) return true;
    const q=String(rule.value).toLowerCase(), hay=v.toLowerCase();
    if(op==='equals')      return hay===q;
    if(op==='starts_with') return hay.startsWith(q);
    return hay.includes(q);
  }
  const arr=Array.isArray(rule.value)?rule.value:(rule.value?[rule.value]:[]);
  if(!arr.length) return true;
  const hit=new Set(arr).has(v);
  return op==='not_in' ? !hit : hit;
}
function _opsForType(t){
  if(t==='text')    return [['contains','contains'],['equals','equals'],['starts_with','starts with'],['is_set','is set'],['is_empty','is not set']];
  if(t==='boolean') return [['in','is']];
  if(t==='number')  return [['>=','at least'],['<=','at most'],['=','equals'],['is_set','is set'],['is_empty','is not set']];
  return [['in','is one of'],['not_in','is not one of'],['is_set','is set'],['is_empty','is not set']];
}
function _defaultRule(key){
  const f=_svField(key)||SECTION_FILTER_FIELDS[0];
  if(f.type==='text')    return {type:'rule', field:f.key, op:'contains', value:''};
  if(f.type==='boolean') return {type:'rule', field:f.key, op:'in', value:['Y']};
  if(f.type==='number')  return {type:'rule', field:f.key, op:'>=', value:''};
  return {type:'rule', field:f.key, op:'in', value:[]};
}

// ── View model ──────────────────────────────────────────────────────────────
const _VIEWS_LS = 'sectrk-views-v1', _ACTIVE_LS = 'sectrk-active-view', _STARS_LS = 'sectrk-starred-v1';
const _STARS_SEEN_LS = 'sectrk-starred-seen-v1';
const SECTION_ALL_VIEW = { id:'all', name:'All sections', team:true, system:true,
  state:{ visibleCols:null, filters:{}, tree:null } };

let activeViewId = null;
let sectionTeamViews = [];

function getPersonalViews(){ try { return JSON.parse(localStorage.getItem(_VIEWS_LS)||'[]'); } catch(_){ return []; } }
function setPersonalViews(v){ try { localStorage.setItem(_VIEWS_LS, JSON.stringify(v)); } catch(_){} }
function getTeamViews(){ return sectionTeamViews; }
function getAllViews(){ return [SECTION_ALL_VIEW, ...getTeamViews(), ...getPersonalViews()]; }
function getViewById(id){ return getAllViews().find(v=>v.id===id) || null; }

function getStarredIds(){ try { return new Set(JSON.parse(localStorage.getItem(_STARS_LS)||'[]')); } catch(_){ return new Set(); } }
function setStarredIds(set){ try { localStorage.setItem(_STARS_LS, JSON.stringify([...set])); } catch(_){} }
function toggleStar(id){ const s=getStarredIds(); s.has(id)?s.delete(id):s.add(id); setStarredIds(s); }
// Seed stars from views shipped with `starred:true` (team views in the shared
// file, baked into the static build) — so an admin-starred view appears as a
// tile for EVERYONE on first sight. Tracked per-browser so a user's later
// un-star sticks and isn't re-seeded on the next load.
function initStarredIfNeeded(){
  let seen; try { seen=new Set(JSON.parse(localStorage.getItem(_STARS_SEEN_LS)||'[]')); } catch(_){ seen=new Set(); }
  const stars=getStarredIds(); let changed=false;
  [...getTeamViews(), ...getPersonalViews()].forEach(v=>{
    if(!v||!v.id||seen.has(v.id)) return;
    if(v.starred) stars.add(v.id);
    seen.add(v.id); changed=true;
  });
  if(changed){ setStarredIds(stars); try { localStorage.setItem(_STARS_SEEN_LS, JSON.stringify([...seen])); } catch(_){} }
}

function _isAdmin(){ return !STATIC; }

async function hydrateTeamViews(data){
  try {
    if(STATIC){ sectionTeamViews = (data && data.team_views) || []; return; }
    const r=await fetch(API+'/api/views');
    if(r.ok){ const d=await r.json(); sectionTeamViews = Array.isArray(d) ? d : (d.views||[]); }
  } catch(e){ sectionTeamViews = sectionTeamViews||[]; }
}
async function persistTeamViews(){
  if(STATIC) return;
  try {
    await fetch(API+'/api/views', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(sectionTeamViews)});
  } catch(e){ console.error('team view persist failed', e); }
}

// Snapshot / restore the top-bar filters (term is a real axis here, so it's in).
function _snapshotFilters(){
  const s=Object.assign({}, filters); s.term=filters.term.slice();
  MS_KEYS.forEach(k=>{ s[k]=filters[k]===null?null:filters[k].slice(); });
  return s;
}
function _applyFilters(f, silent){
  f=f||{};
  ['resolved','level','special','priorTerms','search'].forEach(k=>{ filters[k]=f[k]||''; });
  // multi-selects: null/''/absent = ALL; a string value = that one; an array = as-is.
  const msVal = v => (v===''||v==null) ? null : (Array.isArray(v)?v.slice():[v]);
  MS_KEYS.forEach(k=>{ filters[k]=msVal(f[k]); });
  filters.term = Array.isArray(f.term) ? f.term.slice() : (f.term ? [f.term] : []);
  // silent = don't touch the DOM controls (used by tile-count save/apply/restore, which
  // must not rebuild the multi-select panels and close an open one).
  if(!silent) syncFilterControls();
}
function _resolveViewCols(state){
  if(!state) return null;
  return state.visibleCols || null;   // null = all
}

// Apply a named view: restore columns + top-bar filters + advanced tree.
function applyView(id){
  const view=getViewById(id); if(!view) return;
  activeViewId=id;
  try { localStorage.setItem(_ACTIVE_LS, id); } catch(_){}
  const cols=_resolveViewCols(view.state);
  if(cols===null){ sectionVisibleCols = new Set(SECTION_COLUMNS.filter(c=>!c.defaultHidden).map(c=>c.key)); }
  else { sectionVisibleCols = new Set(cols); }
  _saveSectionCols();
  _applyFilters(view.state.filters||{});
  appliedTree = view.state.tree ? JSON.parse(JSON.stringify(view.state.tree)) : null;
  renderViewTiles();
  renderAll();
}

// ── Modal state + open/close ──────────────────────────────────────────────
let _pvDraftTree=null, _pvLoadedViewId=null, _pvMultiOpen=null, _pvSavingScope=null;

function openViewsModal(){
  const bd=$('#pv-modal-backdrop'); if(!bd) return;
  _pvDraftTree = appliedTree ? JSON.parse(JSON.stringify(appliedTree)) : makeEmptyGroup('all');
  _pvLoadedViewId = activeViewId;
  _pvMultiOpen = null; _pvSavingScope = null;
  bd.classList.add('open');
  renderPvModal();
}
function closeViewsModal(){ const bd=$('#pv-modal-backdrop'); if(bd) bd.classList.remove('open'); _pvMultiOpen=null; }

function renderPvModal(){ _renderPvSidebar(); _renderPvBuilder(); _renderPvFooter(); _renderPvCount(); renderViewTiles(); }

function _pvPreviewCount(){
  const saved=appliedTree;
  appliedTree = (_pvDraftTree && (_pvDraftTree.children||[]).length) ? _pvDraftTree : null;
  let n; try { n=getFiltered().length; } finally { appliedTree=saved; }
  return n;
}
function _renderPvCount(){
  const e=$('#pv-modal-count'); if(!e) return;
  const n=_pvPreviewCount();
  e.textContent = `${n.toLocaleString()} section${n===1?'':'s'} match`;
}

function _renderPvSidebar(){
  const host=$('#pv-modal-sidebar'); if(!host) return;
  const personal=getPersonalViews(), team=getTeamViews(), stars=getStarredIds();
  const item=(v)=>{
    const sel=v.id===_pvLoadedViewId, isStar=stars.has(v.id);
    if(v.system){
      return `<div class="pv-side-item pv-side-system${sel?' selected':''}" onclick="pvLoadView('${v.id}')">
        <span class="pv-side-name">${esc(v.name)}</span>
        <span class="pv-side-acts"><span class="pv-side-star on" title="Always shown">★</span></span></div>`;
    }
    const canModify = v.team ? _isAdmin() : true;
    let acts='';
    if(canModify){
      acts += `<button class="pv-side-act" title="Move up" onclick="pvMoveById('${v.id}',-1,event)">↑</button>`;
      acts += `<button class="pv-side-act" title="Move down" onclick="pvMoveById('${v.id}',1,event)">↓</button>`;
      acts += `<button class="pv-side-act pv-side-act-del" title="Delete view" onclick="pvDeleteById('${v.id}',event)">✕</button>`;
    }
    acts += `<button class="pv-side-act pv-side-act-star${isStar?' on':''}" title="${isStar?'Unstar':'Star — show as a top tile'}" onclick="pvStarById('${v.id}',event)">${isStar?'★':'☆'}</button>`;
    return `<div class="pv-side-item${sel?' selected':''}" onclick="pvLoadView('${v.id}')">
      <span class="pv-side-name">${esc(v.name)}</span>
      <span class="pv-side-acts">${acts}</span></div>`;
  };
  let html = `<button class="pv-side-newbtn" onclick="pvNewView()">+ New view</button>`;
  html += `<div class="pv-side-section">Team ${_isAdmin()?'<span class="pv-admin-pill">ADMIN</span>':''}</div>`;
  html += item(SECTION_ALL_VIEW);
  html += team.length ? team.map(item).join('') : '';
  html += `<div class="pv-side-section">Personal</div>`;
  html += personal.length ? personal.map(item).join('') : '<div class="pv-side-empty">None saved yet</div>';
  host.innerHTML = html;
}

function _renderPvBuilder(){ const host=$('#pv-modal-main'); if(!host) return; host.innerHTML=_renderPvGroup(_pvDraftTree,''); }
function _renderPvGroup(group, path){
  const kids=group.children||[];
  const conjSel=`<select class="pv-conj" onchange="pvbSetConj('${path}', this.value)">
    <option value="all"${group.conj==='all'?' selected':''}>all</option>
    <option value="any"${group.conj==='any'?' selected':''}>any</option></select>`;
  const head=`<div class="pvb-group-head">Match ${conjSel} of the following:
    ${path?`<button class="pvb-iconbtn" title="Remove group" onclick="pvbRemove('${path}')">✕</button>`:''}</div>`;
  const body=kids.map((c,i)=>{
    const childPath=path?`${path}.${i}`:`${i}`;
    return c.type==='group' ? `<div class="pvb-group">${_renderPvGroup(c,childPath)}</div>` : _renderPvRule(c,childPath);
  }).join('');
  const add=`<div class="pvb-add-row">
    <button onclick="pvbAddRule('${path}')">+ Add rule</button>
    <button onclick="pvbAddGroup('${path}')">⊕ Add nested group</button></div>`;
  return head+body+add;
}
function _renderPvRule(rule, path){
  const f=_svField(rule.field)||SECTION_FILTER_FIELDS[0];
  const fieldSel=`<select onchange="pvbSetField('${path}', this.value)">${
    SECTION_FILTER_FIELDS.map(x=>`<option value="${x.key}"${x.key===rule.field?' selected':''}>${esc(x.label)}</option>`).join('')}</select>`;
  const opSel=`<select onchange="pvbSetOp('${path}', this.value)">${
    _opsForType(f.type).map(([op,lbl])=>`<option value="${op}"${op===rule.op?' selected':''}>${lbl}</option>`).join('')}</select>`;
  return `<div class="pvb-rule">${fieldSel}${opSel}${_renderPvRuleValue(rule,f,path)}
    <button class="pvb-iconbtn" title="Remove rule" onclick="pvbRemove('${path}')">✕</button></div>`;
}
function _renderPvRuleValue(rule, f, path){
  if(rule.op==='is_set'||rule.op==='is_empty') return '';
  if(f.type==='text'){
    return `<input type="text" class="pvb-text" value="${esc(rule.value||'')}" oninput="pvbSetValue('${path}', this.value)" placeholder="search…">`;
  }
  if(f.type==='number'){
    return `<input type="number" min="0" class="pvb-text" style="width:90px" value="${esc(rule.value||'')}" oninput="pvbSetValue('${path}', this.value)" placeholder="count">`;
  }
  if(f.type==='boolean'){
    const vals=Array.isArray(rule.value)?rule.value:(rule.value?[rule.value]:[]);
    return `<label class="pvb-bool"><input type="checkbox" ${vals.includes('Y')?'checked':''} onchange="pvbToggleMulti('${path}','Y')"> Yes</label>
            <label class="pvb-bool"><input type="checkbox" ${vals.includes('N')?'checked':''} onchange="pvbToggleMulti('${path}','N')"> No</label>`;
  }
  const vals=Array.isArray(rule.value)?rule.value:[];
  const chips=vals.length ? vals.map(v=>`<span class="pvb-chip">${esc(v||'(blank)')}</span>`).join('') : '<span class="pvb-values-empty">choose values…</span>';
  let pop='';
  if(_pvMultiOpen===path){
    const all=getFieldValues(rule.field);
    pop=`<div class="pvb-multi-pop" onclick="event.stopPropagation()">${
      all.map(v=>`<label><input type="checkbox" ${vals.includes(v)?'checked':''} onchange="pvbToggleMulti('${path}','${_escJs(v)}')"> ${esc(v||'(blank)')}</label>`).join('')}</div>`;
  }
  return `<span class="pvb-valwrap"><span class="pvb-values" onclick="pvbOpenMulti('${path}', event)">${chips}</span>${pop}</span>`;
}
function _escJs(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }

function _renderPvFooter(){
  const host=$('#pv-modal-footer'); if(!host) return;
  if(_pvSavingScope){
    host.innerHTML=`<span class="pv-save-form">
      <input id="pv-name-input" class="pv-name-input" type="text" maxlength="60" placeholder="Name this view…"
             onkeydown="if(event.key==='Enter')pvConfirmSave();else if(event.key==='Escape')pvCancelSave()">
      <button class="pv-btn pv-btn-primary" onclick="pvConfirmSave()">Save ${_pvSavingScope==='team'?'as Team View':'as My View'}</button>
      <button class="pv-btn pv-btn-ghost" onclick="pvCancelSave()">Cancel</button></span>`;
    setTimeout(()=>{ const i=$('#pv-name-input'); if(i)i.focus(); }, 30);
    return;
  }
  const loaded=_pvLoadedViewId ? getViewById(_pvLoadedViewId) : null;
  const canEdit = loaded && !loaded.system && (loaded.team ? _isAdmin() : true);
  const left=`<button class="pv-btn pv-btn-ghost" onclick="closeViewsModal()">Close</button>`;
  let acts='';
  acts += `<button class="pv-btn pv-btn-ghost" onclick="pvStartSave('personal')" title="Save as a new personal view">Save as My View</button>`;
  if(_isAdmin()) acts += `<button class="pv-btn pv-btn-ghost" onclick="pvStartSave('team')" title="Save as a new team view">Save as Team View</button>`;
  if(canEdit) acts += `<button class="pv-btn pv-btn-ghost" onclick="pvUpdateLoaded()" title="Save current columns, filters & rules to this view">↻ Update</button>`;
  acts += `<button class="pv-btn pv-btn-primary" onclick="pvApplyDraft()" title="Apply to the table">Apply</button>`;
  host.innerHTML = `${left}<span style="flex:1"></span><span class="pv-footer-actions">${acts}</span>`;
}

function pvApplyDraft(){
  if(_pvLoadedViewId && getViewById(_pvLoadedViewId)){
    applyView(_pvLoadedViewId);
  } else {
    activeViewId=null;
    try { localStorage.setItem(_ACTIVE_LS,''); } catch(_){}
  }
  appliedTree = (_pvDraftTree && (_pvDraftTree.children||[]).length) ? JSON.parse(JSON.stringify(_pvDraftTree)) : null;
  closeViewsModal();
  renderViewTiles();
  renderAll();
}

function pvStarById(id, ev){
  if(ev)ev.stopPropagation(); if(id==='all')return;
  toggleStar(id);
  // An admin's star on a TEAM view is the ship-default for everyone — persist it
  // to the shared file so it seeds as a tile for all users on their next load.
  if(_isAdmin() && id.startsWith('team_')){
    const v=sectionTeamViews.find(x=>x.id===id);
    if(v){ v.starred = getStarredIds().has(id); persistTeamViews(); }
  }
  renderPvModal();
}
function pvDeleteById(id, ev){ if(ev)ev.stopPropagation(); if(id==='all')return; pvDeleteView(id); }
function pvMoveById(id, dir, ev){
  if(ev)ev.stopPropagation(); if(id==='all')return;
  const view=getViewById(id); if(!view) return;
  if(view.team){
    if(!_isAdmin()) return;
    const arr=sectionTeamViews, i=arr.findIndex(v=>v.id===id), j=i+dir;
    if(i<0||j<0||j>=arr.length) return;
    [arr[i],arr[j]]=[arr[j],arr[i]]; persistTeamViews();
  } else {
    const arr=getPersonalViews(), i=arr.findIndex(v=>v.id===id), j=i+dir;
    if(i<0||j<0||j>=arr.length) return;
    [arr[i],arr[j]]=[arr[j],arr[i]]; setPersonalViews(arr);
  }
  renderPvModal();
}

// Tree mutators (path = child indices like "0.2.1"; "" = root)
function _pvWalk(path){
  if(!_pvDraftTree) return null;
  if(!path) return {node:_pvDraftTree, parent:null, index:-1};
  const parts=path.split('.').map(n=>parseInt(n,10));
  let node=_pvDraftTree, parent=null, idx=-1;
  for(const i of parts){ if(!node||node.type!=='group') return null; parent=node; idx=i; node=(node.children||[])[i]; }
  return {node, parent, index:idx};
}
function pvbAddRule(path){ const w=_pvWalk(path); if(w&&w.node.type==='group'){ w.node.children.push(_defaultRule(SECTION_FILTER_FIELDS[0].key)); renderPvModal(); } }
function pvbAddGroup(path){ const w=_pvWalk(path); if(w&&w.node.type==='group'){ w.node.children.push(makeEmptyGroup(w.node.conj==='all'?'any':'all')); renderPvModal(); } }
function pvbRemove(path){ const w=_pvWalk(path); if(w&&w.parent){ w.parent.children.splice(w.index,1); renderPvModal(); } }
function pvbSetConj(path, conj){ const w=_pvWalk(path); if(w&&w.node.type==='group'){ w.node.conj=conj==='any'?'any':'all'; renderPvModal(); } }
function pvbSetField(path, key){ const w=_pvWalk(path); if(w&&w.node.type==='rule'&&w.node.field!==key){ Object.assign(w.node,_defaultRule(key)); renderPvModal(); } }
function pvbSetOp(path, op){ const w=_pvWalk(path); if(w&&w.node.type==='rule'){ w.node.op=op; const t=(_svField(w.node.field)||{}).type; if(op==='is_set'||op==='is_empty') w.node.value=null; else if(!w.node.value||(Array.isArray(w.node.value)&&!w.node.value.length)) w.node.value=(t==='text')?'':[]; renderPvModal(); } }
function pvbSetValue(path, val){ const w=_pvWalk(path); if(w&&w.node.type==='rule'){ w.node.value=val; _renderPvCount(); } }
function pvbToggleMulti(path, v){ const w=_pvWalk(path); if(w&&w.node.type==='rule'){ const a=Array.isArray(w.node.value)?w.node.value.slice():[]; const i=a.indexOf(v); i===-1?a.push(v):a.splice(i,1); w.node.value=a; renderPvModal(); } }
function pvbOpenMulti(path, ev){ ev&&ev.stopPropagation(); _pvMultiOpen=(_pvMultiOpen===path?null:path); _renderPvBuilder(); }
document.addEventListener('click', e=>{
  if(!_pvMultiOpen) return;
  if(!e.target.closest('.pvb-multi-pop') && !e.target.closest('.pvb-values')){ _pvMultiOpen=null; _renderPvBuilder(); }
});

function pvNewView(){ _pvDraftTree=makeEmptyGroup('all'); _pvLoadedViewId=null; _pvSavingScope=null; renderPvModal(); }
function pvLoadView(id){
  const view=getViewById(id); if(!view) return;
  _pvDraftTree=(view.state&&view.state.tree)?JSON.parse(JSON.stringify(view.state.tree)):makeEmptyGroup('all');
  _pvLoadedViewId=id; _pvSavingScope=null; _pvMultiOpen=null;
  renderPvModal();
}
function pvDeleteView(id, ev){
  ev&&ev.stopPropagation();
  if(id.startsWith('team_')){ sectionTeamViews=sectionTeamViews.filter(v=>v.id!==id); persistTeamViews(); }
  else { setPersonalViews(getPersonalViews().filter(v=>v.id!==id)); }
  if(activeViewId===id) activeViewId=null;
  if(_pvLoadedViewId===id) _pvLoadedViewId=null;
  renderPvModal();
}
function pvStartSave(scope){ _pvSavingScope=scope; _renderPvFooter(); }
function pvCancelSave(){ _pvSavingScope=null; _renderPvFooter(); }
function _currentViewState(){
  return {
    visibleCols:[...sectionVisibleCols],
    filters:_snapshotFilters(),
    tree:(_pvDraftTree&&(_pvDraftTree.children||[]).length)?JSON.parse(JSON.stringify(_pvDraftTree)):null,
  };
}
function pvConfirmSave(){
  const inp=$('#pv-name-input'); const name=(inp&&inp.value||'').trim();
  if(!name){ inp&&inp.focus(); return; }
  const scope=_pvSavingScope||'personal';
  const state=_currentViewState();
  let id;
  if(scope==='team'){ id='team_'+Date.now(); sectionTeamViews.push({id, name, team:true, state}); persistTeamViews(); }
  else { id='personal_'+Date.now(); const views=getPersonalViews(); views.push({id, name, team:false, state}); setPersonalViews(views); }
  _pvLoadedViewId=id; _pvSavingScope=null;
  pvApplyDraft();
}
function pvUpdateLoaded(){
  const id=_pvLoadedViewId; if(!id) return;
  const state=_currentViewState();
  if(id.startsWith('team_')){ const v=sectionTeamViews.find(x=>x.id===id); if(v){ v.state=state; persistTeamViews(); } }
  else { const views=getPersonalViews(); const v=views.find(x=>x.id===id); if(v){ v.state=state; setPersonalViews(views); } }
  pvApplyDraft();
}

// Views button label + starred-view tile bar.
function renderViewTiles(){
  const bar=$('#view-tiles'); if(!bar) return;
  const stars=getStarredIds();
  const starredViews=[...getTeamViews(), ...getPersonalViews()].filter(v=>stars.has(v.id));
  const tileViews=[SECTION_ALL_VIEW, ...starredViews];
  bar.style.display='flex';
  function countForView(v){
    try {
      const savedSnap=_snapshotFilters(), savedTree=appliedTree;
      _applyFilters((v&&v.state&&v.state.filters)||{}, true);
      appliedTree=(v&&v.state&&v.state.tree)?v.state.tree:null;
      const n=getFiltered().length;
      _applyFilters(savedSnap, true); appliedTree=savedTree;
      return n;
    } catch(_){ return '—'; }
  }
  const label = `<button class="view-tiles-label" onclick="openViewsModal()" title="Open saved views — switch, star, or build a filter">★ Views${_isAdmin()?' <span class="pv-admin-pill">ADMIN</span>':''}</button>`;
  bar.innerHTML = label + tileViews.map(v=>{
    const cnt=countForView(v);
    const active=(v.id==='all')?(!activeViewId||activeViewId==='all'):(v.id===activeViewId);
    const info = /special topics/i.test(v.name) ? `<sup class="info-i" data-info="${esc(ST_DEF)}" onclick="event.stopPropagation()">i</sup>` : '';
    return `<button class="pv-tile${active?' active':''}" onclick="applyView('${v.id}')" title="${esc(v.name)}">
      <span class="pv-tile-count">${typeof cnt==='number'?cnt.toLocaleString():cnt}</span>
      <span class="pv-tile-label">${esc(v.name)}${info}</span></button>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// Console
// ══════════════════════════════════════════════════════════════════════════
function openConsoleModal(){ const m=$('#console-modal'); if(!m) return; m.style.display='flex'; loadConsoleData(); }
function closeConsoleModal(){ const m=$('#console-modal'); if(m) m.style.display='none'; }
function closeConsoleModalIfBackdrop(event){ if(event.target.id==='console-modal') closeConsoleModal(); }
async function loadConsoleData(){
  const body=$('#console-modal-body'); body.innerHTML='Loading…';
  try {
    let data;
    if(STATIC){
      data = { last_fetch:lastFetch, refresh_date:refreshDate, section_count:allSections.length,
        per_term: bakedPerTerm || _computePerTerm(), airtable:true, notes_count:null, connect:null };
    } else {
      const r=await fetch(API+'/api/console'); if(!r.ok) throw new Error('HTTP '+r.status);
      data=await r.json();
    }
    body.innerHTML=renderConsoleContent(data);
  } catch(e){ body.innerHTML=`<p style="color:#b91c1c">Could not load console data: ${esc(e.message)}</p>`; }
}
function _computePerTerm(){ const m={}; allSections.forEach(s=>{ const t=s.term||'(none)'; m[t]=(m[t]||0)+1; }); return m; }
function _consoleTs(s){ try { return new Date(s).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' ET'; } catch(_){ return s||'—'; } }
function renderConsoleContent(d){
  const row=(k,v)=>`<tr style="border-top:1px solid #e2e8f0"><td style="padding:6px 8px;color:#64748b;white-space:nowrap">${esc(k)}</td><td style="padding:6px 8px">${v}</td></tr>`;
  let html='<h3 style="margin:0 0 10px">Data status</h3>';
  html+='<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html+=row('Last pull', d.last_fetch?_consoleTs(d.last_fetch):'<span style="color:#94a3b8">—</span>');
  html+=row('Registrar refresh', esc(d.refresh_date||'—'));
  html+=row('Total sections', `<b>${(d.section_count||0).toLocaleString()}</b>`);
  html+='</table>';

  const pt=d.per_term||{};
  const terms=Object.keys(pt).sort((a,b)=>termRank(a)-termRank(b));
  if(terms.length){
    html+='<h3 style="margin:18px 0 10px">Sections per term</h3>';
    html+='<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9;text-align:left">'
      +'<th style="padding:5px 8px">Term</th><th style="padding:5px 8px">Sections</th></tr></thead><tbody>';
    terms.forEach(t=>{ html+=`<tr style="border-top:1px solid #e2e8f0"><td style="padding:5px 8px">${esc(t)}</td><td style="padding:5px 8px">${(pt[t]||0).toLocaleString()}</td></tr>`; });
    html+='</tbody></table>';
  }

  html+='<h3 style="margin:18px 0 10px">Notes store</h3>';
  html+='<table style="width:100%;border-collapse:collapse;font-size:13px">';
  html+=row('Airtable connected', d.airtable?'<span style="color:#15803d">✓ Yes</span>':'<span style="color:#b45309">No (local fallback)</span>');
  if(d.notes_count!=null) html+=row('Notes on file', (d.notes_count||0).toLocaleString());
  html+='</table>';

  const c=d.connect;
  if(c){
    html+='<h3 style="margin:18px 0 10px">Last update</h3>';
    html+='<table style="width:100%;border-collapse:collapse;font-size:13px">';
    if(c.running) html+=row('Status', '<span style="color:#2563eb">Running…</span>');
    else if(c.ok===true) html+=row('Status', `<span style="color:#15803d">✓ OK — ${(c.count||0).toLocaleString()} sections</span>`);
    else if(c.ok===false) html+=row('Status', `<span style="color:#b91c1c">✗ ${esc(c.error||'failed')}</span>`);
    else html+=row('Status', '<span style="color:#94a3b8">No update this session</span>');
    if(c.finished) html+=row('Finished', _consoleTs(c.finished));
    html+='</table>';
  }
  return html;
}

// ══════════════════════════════════════════════════════════════════════════
// Export
// ══════════════════════════════════════════════════════════════════════════
function exportSectionsCsv(){
  const rows=sortedFiltered();
  const cols=visibleColumns();
  const headers=cols.map(c=>c.label);
  const csvRows=rows.map(s=>cols.map(c=>colText(s,c.key)));
  const csv=[headers,...csvRows].map(r=>r.map(cell=>{
    const v=String(cell==null?'':cell);
    return /[",\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:v;
  }).join(',')).join('\n');
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const term=(filters.term.length?filters.term.join('-'):'all').replace(/\s+/g,'_');
  const date=new Date().toISOString().slice(0,10);
  const fname=`sections_${term}_${date}.csv`;
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


// ---------- button-row + filter handlers ----------
window.setResolved=v=>{ filters.resolved=(filters.resolved===v?'':v); renderAll(); };
window.setLevel=v=>{ filters.level=(filters.level===v?'':v); renderAll(); };
// Multi-select term: '' = All (clears to every term); a term toggles its membership.
window.setTerm=v=>{
  if(v===''){ filters.term=[]; }
  else { const i=filters.term.indexOf(v); if(i>=0) filters.term.splice(i,1); else filters.term.push(v); }
  renderAll();
};
function bindControls(){
  $('#f-special').onchange=e=>{filters.special=e.target.value;renderAll();};
  $('#f-prior').onchange=e=>{filters.priorTerms=e.target.value;renderAll();};
  $('#f-search').oninput=e=>{filters.search=e.target.value;renderTable();};
  document.addEventListener('click', e=>{ if(!document.contains(e.target)) return; if(!e.target.closest('.ms')) closeAllMsPanels(); });
}
function syncFilterControls(){
  MS_KEYS.forEach(renderMulti);
  const sp=$('#f-special'); if(sp) sp.value=filters.special;
  const pr=$('#f-prior'); if(pr) pr.value=filters.priorTerms;
  const se=$('#f-search'); if(se) se.value=filters.search;
}
window.clearFilters=()=>{ const term=filters.term.slice();
  Object.keys(filters).forEach(k=>{ filters[k]=''; }); filters.term=term;
  MS_KEYS.forEach(k=>{ filters[k]=null; });   // null = all
  syncFilterControls(); renderAll(); };

function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2600); }

function boot(){ bindControls(); load(); }
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

// ══════════════════════════════════════════════════════════════════════════
//  Left-rail shell (shared/web/rail.js) — opt-in via ?shell=rail; default OFF.
//  Section's filters are a flat object of differently-shaped named filters, so
//  each FieldDef is hand-written to that filter's real shape (adoption brief §3;
//  no generic map). Coded-value order uses MOD_ORDER (modality) + termRank
//  (term), never a plain lexical .sort() (§8.2). Nav is omitted — section has no
//  population tabs, so there are no dead nav items to force-flip (§2, §8.1).
// ══════════════════════════════════════════════════════════════════════════

// null-as-all checkbox multi (College/Campus/Modality/Subject) → FieldDef.
function _railMs(id, label, category, key, optsFn, labelForFn, search){
  return {
    id, label, category, kind:'multi', search:!!search, labelFor:labelForFn,
    options: optsFn,
    has: v => { const a=filters[key]; return a===null || a.includes(v); },
    toggle: v => {
      let a=filters[key]; const all=optsFn();
      if(a===null) a=all.slice();
      const i=a.indexOf(v); if(i>=0) a.splice(i,1); else a.push(v);
      filters[key]=(a.length===all.length)?null:a;
    },
    active: () => filters[key]!==null,
    clear:  () => { filters[key]=null; },
    summary:() => { const a=filters[key]; if(a===null) return '';
      if(!a.length) return 'None';
      if(a.length===1) return labelForFn?labelForFn(a[0]):String(a[0]);
      return a.length+' selected'; },
  };
}
// single-select-as-multi (Level, Modality Resolved): holds one value or ''.
function _railSingle(id, label, category, key, options, labelForFn){
  return {
    id, label, category, kind:'multi', labelFor:labelForFn,
    options: () => options,
    has: v => filters[key]===v,
    toggle: v => { filters[key]=(filters[key]===v?'':v); },
    active: () => filters[key]!=='',
    clear:  () => { filters[key]=''; },
    summary:() => filters[key] ? (labelForFn?labelForFn(filters[key]):filters[key]) : '',
  };
}
function _sectionRailFields(){
  const _lvl={UG:'Undergraduate', GR:'Graduate'};
  const _res={yes:'Resolved', no:'Unresolved', notes:'Has notes'};
  return [
    // Course
    _railMs('college','College','Course','college', ()=>msValues('college'), v=>abbr(v), true),
    _railMs('campus', 'Campus', 'Course','campus',  ()=>msValues('campus'),  v=>v),
    _railMs('subject','Subject','Course','subject', ()=>msValues('subject'), v=>v, true),
    _railSingle('level','Level','Course','level', ['UG','GR'], v=>_lvl[v]||v),
    // Offering
    { id:'term', label:'Term', category:'Offering', kind:'multi',
      options: () => availableTerms(),                 // already ordered by termRank
      has: v => filters.term.includes(v),
      toggle: v => { const i=filters.term.indexOf(v); if(i>=0) filters.term.splice(i,1); else filters.term.push(v); },
      active: () => filters.term.length>0,
      clear:  () => { filters.term=[]; },              // [] = all terms (no filter)
      summary:() => filters.term.length===1 ? filters.term[0] : (filters.term.length ? filters.term.length+' selected' : '') },
    _railMs('modality','Modality','Offering','modality', ()=>msValues('modality'), v=>modShort(v)),  // MOD_ORDER via msValues
    { id:'special', label:'Special topics', category:'Offering', kind:'bool',
      get: () => filters.special==='Y'?'Yes':(filters.special==='N'?'No':''),
      set: v => { filters.special = v==='Yes'?'Y':(v==='No'?'N':''); },
      active: () => filters.special!=='', clear: () => { filters.special=''; },
      summary:() => filters.special==='Y'?'Yes':(filters.special==='N'?'No':'') },
    { id:'prior', label:'Prior terms', category:'Offering', kind:'num',
      get: () => { const pt=filters.priorTerms;
        if(pt && typeof pt==='object') return {min:pt.min, max:pt.max};
        if(pt!=='') return {min:+pt, max:null};
        return {min:null, max:null}; },
      set: (mn,mx) => { filters.priorTerms=(mn==null && mx==null)?'':{min:mn, max:mx}; },
      active: () => filters.priorTerms!=='', clear: () => { filters.priorTerms=''; },
      summary:() => { const r=filters.priorTerms; if(r==='') return '';
        if(typeof r==='object'){ const {min,max}=r;
          if(min!=null && max!=null) return min+'–'+max;
          if(min!=null) return '≥'+min; if(max!=null) return '≤'+max; return ''; }
        return '≥'+r; } },
    // Review
    _railSingle('resolved','Modality Resolved','Review','resolved', ['yes','no','notes'], v=>_res[v]||v),
  ];
}

// For THIS tracker, default the rail's Views + Filters sections OPEN (the shared
// shell defaults every section closed). Seed the shell's own collapse-state keys
// on first sight only — a later collapse by the user writes 'false' and sticks.
// Must run BEFORE initTrackerShell (it reads these in loadCollapse()).
try {
  ['sectrk-views-open','sectrk-filters-open'].forEach(k => {
    if (localStorage.getItem(k) === null) localStorage.setItem(k, 'true');
  });
} catch(_) {}

// Mount the shared shell. Runs at the END of app.js so every referenced global
// exists; initTrackerShell reads the ?shell=rail / localStorage['sectrk-shell']
// flag itself (default OFF — the classic header is the fallback).
if (typeof initTrackerShell === 'function') initTrackerShell({
  brand: { label: 'Section Tracker', logo: '§' },
  persistPrefix: 'sectrk',
  tools: [ { label: 'Console', onClick: () => openConsoleModal() } ],
  views: {
    enabled: () => true,
    list: () => [...getTeamViews(), ...getPersonalViews()]
                 .map(v => ({ id:v.id, name:v.name, active:v.id===activeViewId })),
    apply: id => applyView(id),
    onManage: () => openViewsModal(),
  },
  filters: {
    enabled: () => true,
    fields: () => _sectionRailFields(),
    onChange: () => renderAll(),
  },
  freshness: () => ({
    updated: (document.getElementById('last-updated') || {}).textContent || '',
    build:   (document.getElementById('app-build')   || {}).textContent || '',
  }),
  onExitRail: () => { syncFilterControls(); renderAll(); },
});

// ---------- expose inline-handler globals ----------
window.openViewsModal=openViewsModal;
window.closeViewsModal=closeViewsModal;
window.applyView=applyView;
window.pvNewView=pvNewView;
window.pvLoadView=pvLoadView;
window.pvStarById=pvStarById;
window.pvMoveById=pvMoveById;
window.pvDeleteById=pvDeleteById;
window.pvbAddRule=pvbAddRule;
window.pvbAddGroup=pvbAddGroup;
window.pvbRemove=pvbRemove;
window.pvbSetConj=pvbSetConj;
window.pvbSetField=pvbSetField;
window.pvbSetOp=pvbSetOp;
window.pvbSetValue=pvbSetValue;
window.pvbToggleMulti=pvbToggleMulti;
window.pvbOpenMulti=pvbOpenMulti;
window.pvStartSave=pvStartSave;
window.pvCancelSave=pvCancelSave;
window.pvConfirmSave=pvConfirmSave;
window.pvUpdateLoaded=pvUpdateLoaded;
window.pvApplyDraft=pvApplyDraft;
window.toggleSectionColPicker=toggleSectionColPicker;
window.toggleFilters=toggleFilters;
window.toggleSectionCol=toggleSectionCol;
window.toggleAllSectionCols=toggleAllSectionCols;
window._secColDragStart=_secColDragStart;
window._secColDragOver=_secColDragOver;
window._secColDrop=_secColDrop;
window._secColDragEnd=_secColDragEnd;
window.resetSectionColOrder=resetSectionColOrder;
window.exportSectionsCsv=exportSectionsCsv;
window.openConsoleModal=openConsoleModal;
window.closeConsoleModal=closeConsoleModal;
window.closeConsoleModalIfBackdrop=closeConsoleModalIfBackdrop;
})();

/* Fall 2026 Section Tracker — frontend (matches the Program tracker UI) */
(function () {
'use strict';

const API = window._apiBase || '';
const ADMIN = !!window._isAdmin;
const STATIC = !!window._staticMode;

let allSections = [];
let lastFetch = '', refreshDate = '';
let bakedPerTerm = null;     // per-term counts from the static payload (Console)
const filters = { term:'Fall 2026', college:'', campus:'', subject:'', modality:'', resolved:'', level:'', special:'', search:'' };
let sort = { key:'course_code', dir:1 };
const expanded = new Set();
const TERM_ORDER = ['Fall 2026','Spring 2026','Summer 2026'];

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
  { key:'term',         label:'Term',          defaultHidden:true },
  { key:'crn',          label:'CRN',           defaultHidden:true },
  { key:'schedule',     label:'Schedule',      defaultHidden:true },
  { key:'meeting_time', label:'Meeting Time',  defaultHidden:true },
  { key:'location',     label:'Location',      defaultHidden:true },
  { key:'faculty_email',label:'Faculty Email', defaultHidden:true },
];

const $ = s => document.querySelector(s);
const el = (t,c,h) => { const e=document.createElement(t); if(c)e.className=c; if(h!=null)e.innerHTML=h; return e; };
const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

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
function visibleColumns(){ return SECTION_COLUMNS.filter(c=>sectionVisibleCols.has(c.key)); }

// ---------- load ----------
async function load() {
  let data;
  if (window._loadSections) { data = await window._loadSections(); }
  else { data = await (await fetch(API + '/api/sections')).json(); }
  allSections = data.sections || [];
  lastFetch = data.last_fetch || '';
  refreshDate = data.refresh_date || '';
  bakedPerTerm = data.per_term || null;
  // default to the first available term if the saved default isn't present
  const terms = availableTerms();
  if (filters.term && !terms.includes(filters.term)) filters.term = terms[0] || '';
  $('#subtitle').textContent = allSections.length.toLocaleString() + ' sections · ' + terms.length + ' terms · registrar refresh ' + (refreshDate || '—');
  // Always-visible (everyone) — data refresh time + site build time.
  const parts = [];
  if (lastFetch) parts.push('Data refreshed ' + fmtTime(lastFetch));
  if (data.built_at) parts.push('Site built ' + fmtTime(data.built_at));
  $('#last-updated').textContent = parts.join('  ·  ');
  setStoreBadge(data.airtable);
  // Staleness banner is a LOCAL-app feature only (owner). On the shared static
  // site, the always-visible refresh/build times above are the staleness signal.
  if (!STATIC) renderSourceHealthBanner(data.source_health);
  // hydrate team views (static: baked; local: API)
  await hydrateTeamViews(data);
  initStarredIfNeeded();   // seed tiles from shipped starred:true views
  hideStaticOnlyHeader();
  populateFilters();
  // restore the last active view (if it still exists)
  let restore = null;
  try { restore = localStorage.getItem(_ACTIVE_LS); } catch(_){}
  if (restore && getViewById(restore)) applyView(restore);
  else renderAll();
}
function fmtTime(iso){ try { return new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET'; } catch(e){ return iso; } }
function setStoreBadge(airtable){
  const b=$('#store-badge'), l=$('#store-label');
  if(STATIC){ b.style.display='none'; return; }
  b.className='badge-dot '+(airtable?'ok':'bad');
  l.textContent = airtable ? 'Airtable notes' : 'local notes';
}
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

// On the static site there's no local server — hide Console + Update controls.
function hideStaticOnlyHeader(){
  if(!STATIC) return;
  ['#console-btn','#connect-btn','#scan-status'].forEach(sel=>{ const e=$(sel); if(e) e.style.display='none'; });
}

function uniq(key){ return [...new Set(allSections.map(s=>s[key]).filter(Boolean))].sort(); }
function populateFilters(){
  const te=$('#f-term');
  if(te){ te.innerHTML=availableTerms().map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')+'<option value="">All terms</option>'; te.value=filters.term; }
  const me=$('#f-modality');
  if(me){
    const present=uniq('instructional_method');
    const ordered=MOD_ORDER.filter(m=>present.includes(m)).concat(present.filter(m=>!MOD_ORDER.includes(m)));
    me.innerHTML='<option value="">All</option>'+ordered.map(m=>`<option value="${esc(m)}">${esc(modShort(m))}</option>`).join('');
    me.value=filters.modality;
  }
  fillSelect('#f-college', uniq('college'), abbr);
  fillSelect('#f-campus', uniq('campus'));
  fillSelect('#f-subject', uniq('subject'));
}
function fillSelect(sel, vals, labelFn){
  const e=$(sel), cur=e.value;
  e.innerHTML='<option value="">All</option>'+vals.map(v=>`<option value="${esc(v)}">${esc(labelFn?labelFn(v)+' — '+v:v)}</option>`).join('');
  e.value=cur;
}

// ---------- filtering ----------
function availableTerms(){
  const present=new Set(allSections.map(s=>s.term));
  return TERM_ORDER.filter(t=>present.has(t)).concat([...present].filter(t=>!TERM_ORDER.includes(t)).sort());
}
function baseFiltered(skip){
  return allSections.filter(s=>{
    if(skip!=='term' && filters.term && s.term!==filters.term) return false;
    if(skip!=='college' && filters.college && s.college!==filters.college) return false;
    if(skip!=='campus' && filters.campus && s.campus!==filters.campus) return false;
    if(skip!=='subject' && filters.subject && s.subject!==filters.subject) return false;
    if(skip!=='modality' && filters.modality && s.instructional_method!==filters.modality) return false;
    if(skip!=='level' && filters.level && s.level!==filters.level) return false;
    if(skip!=='special' && filters.special){
      if(filters.special==='Y' && s.special_topics!=='Yes') return false;
      if(filters.special==='N' && s.special_topics==='Yes') return false;
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
function renderAll(){ renderViewTiles(); syncButtonRows(); renderHead(); renderTable(); }

// button-row active-state sync
function syncButtonRows(){
  const rmap={'':'active-all','yes':'active-yes','no':'active-no','notes':'active-notes'};
  document.querySelectorAll('#resolved-row .proposal-btn').forEach(b=>{
    b.classList.remove('active-all','active-yes','active-no','active-notes');
    if(b.dataset.v===filters.resolved) b.classList.add(rmap[filters.resolved]);
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
  if(key==='modality_resolved') return s.modality_resolved ? 'Yes' : '';
  if(key==='notes')            return (s.notes||'');
  let v = s[key];
  if(c && c.fmt) v = c.fmt(v);
  return (v==null?'':String(v));
}
// HTML cell for one section column.
function colCell(s, key){
  if(key==='course_code') return `<td class="code">${esc(s.course_code)}</td>`;
  if(key==='college')     return `<td title="${esc(s.college)}">${esc(abbr(s.college))}</td>`;
  if(key==='campus')      return `<td class="muted">${esc(s.campus)}</td>`;
  if(key==='instructional_method') return `<td><span class="${modClass(s.instructional_method)}">${esc(s.instructional_method||'—')}</span></td>`;
  if(key==='level')       return `<td><span class="pill lvl">${esc(s.level||'—')}</span></td>`;
  if(key==='total_enrolled') return `<td class="enr">${(+s.total_enrolled||0)}</td>`;
  if(key==='faculty_name') return `<td class="muted">${esc(s.faculty_name||'—')}</td>`;
  if(key==='modality_resolved') return `<td>${s.modality_resolved?'<span class="resolved-yes">✓ Yes</span>':'<span class="resolved-no">—</span>'}</td>`;
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
    const tr=el('tr','program-row '+rowModClass(s.instructional_method)+(expanded.has(s.id)?' open':''));
    tr.onclick=(e)=>{ if(e.target.tagName!=='A') toggleRow(s.id); };
    tr.innerHTML = cols.map(c=>colCell(s,c.key)).join('');
    tb.appendChild(tr);
    if(expanded.has(s.id)){
      const dr=el('tr','detail-row'); const td=el('td'); td.colSpan=ncol;
      td.appendChild(renderDetail(s)); dr.appendChild(td); tb.appendChild(dr);
    }
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

function toggleRow(id){ if(expanded.has(id))expanded.delete(id); else {expanded.clear(); expanded.add(id);} renderTable(); }

function renderDetail(s){
  const d=el('div','detail');
  const kv=rows=>'<div class="kv">'+rows.map(([k,v])=>`<div class="k">${esc(k)}</div><div>${v==null||v===''?'—':esc(v)}</div>`).join('')+'</div>';
  const left=el('div'); left.innerHTML='<h4>Section</h4>'+kv([
    ['CRN',s.crn],['Course',s.course_code],['Section',s.section],['Title',s.title],
    ['College',s.college],['Campus',s.campus],['Level',s.level],['Schedule',s.schedule],
    ['Enrolled',s.total_enrolled],['Honors',s.honors_ind],
    ['Special topics', s.special_topics==='Yes' ? 'Yes' : 'No'],
    ['Prior terms offered', (s.times_offered==null||s.times_offered==='') ? '—' : s.times_offered]]);
  const right=el('div'); right.innerHTML='<h4>Modality &amp; logistics</h4>'+kv([
    ['Instructional Method',s.instructional_method],['Meeting Time',s.meeting_time],
    ['Location',s.location],['Faculty',s.faculty_name],['Faculty Email',s.faculty_email],
    ['Faculty Type',s.faculty_type],['Attributes',s.attributes]]);
  d.appendChild(left); d.appendChild(right);

  // Previous offerings of this special-topics course's topic (earlier terms only).
  if(s.special_topics==='Yes'){
    let prev=s.previous_offerings;
    if(typeof prev==='string'){ try{ prev=JSON.parse(prev||'[]'); }catch(_){ prev=[]; } }
    if(!Array.isArray(prev)) prev=[];
    const po=el('div','full');
    po.innerHTML='<h4>Previous offerings'+(prev.length?` (${prev.length})`:'')+'</h4>';
    if(prev.length){
      po.innerHTML+=kv(prev.map(o=>{
        const term=(o.term||'').replace(/\s+Semester$/,'');
        const parts=[o.instructor||''];
        if(o.sections>1) parts.push(o.sections+' sections');
        if(o.enrolled!=null&&o.enrolled!=='') parts.push(o.enrolled+' enrolled');
        return [term, parts.filter(Boolean).join(' · ')||'—'];
      }));
    } else {
      po.innerHTML+='<div class="muted">No previous offerings on record.</div>';
    }
    d.appendChild(po);
  }

  const resWrap=el('div','full'); resWrap.innerHTML='<h4>Modality Resolved</h4>';
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
  const noteWrap=el('div','full'); noteWrap.innerHTML='<h4>'+(isLC?'Live Cast justification':'College notes')+'</h4>';
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

// ══════════════════════════════════════════════════════════════════════════
// Columns picker
// ══════════════════════════════════════════════════════════════════════════
function toggleSectionColPicker(e){
  e.stopPropagation();
  const dd=$('#section-col-dropdown'); if(!dd) return;
  if(dd.classList.contains('open')){ dd.classList.remove('open'); return; }
  _rebuildColDropdown(dd);
  dd.classList.add('open');
}
function _rebuildColDropdown(dd){
  dd.innerHTML =
    `<div class="portfolio-col-selectall">
        <button onclick="toggleAllSectionCols(true)">Select All</button>
        <button onclick="toggleAllSectionCols(false)">Unselect All</button>
     </div>` +
    SECTION_COLUMNS.map(c=>`
      <label class="portfolio-col-check">
        <input type="checkbox" ${sectionVisibleCols.has(c.key)?'checked':''}
               onchange="toggleSectionCol('${c.key}',this.checked)">
        ${esc(c.label)}
      </label>`).join('');
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
  if(t==='boolean') return [['in','is'],['is_set','is set'],['is_empty','is not set']];
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
function _snapshotFilters(){ return Object.assign({}, filters); }
function _applyFilters(f){
  f=f||{};
  ['term','college','campus','subject','modality','resolved','level','special','search'].forEach(k=>{ filters[k]=f[k]||''; });
  syncFilterControls();
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
  const btn=$('#views-btn');
  if(btn) btn.innerHTML = '★ Views' + (_isAdmin()?' <span class="pv-admin-pill">ADMIN</span>':'');
  const bar=$('#view-tiles'); if(!bar) return;
  const stars=getStarredIds();
  const starredViews=[...getTeamViews(), ...getPersonalViews()].filter(v=>stars.has(v.id));
  const tileViews=[SECTION_ALL_VIEW, ...starredViews];
  bar.style.display='flex';
  function countForView(v){
    try {
      const savedSnap=_snapshotFilters(), savedTree=appliedTree;
      _applyFilters((v&&v.state&&v.state.filters)||{});
      appliedTree=(v&&v.state&&v.state.tree)?v.state.tree:null;
      const n=getFiltered().length;
      _applyFilters(savedSnap); appliedTree=savedTree;
      return n;
    } catch(_){ return '—'; }
  }
  bar.innerHTML = tileViews.map(v=>{
    const cnt=countForView(v);
    const active=(v.id==='all')?(!activeViewId||activeViewId==='all'):(v.id===activeViewId);
    return `<button class="pv-tile${active?' active':''}" onclick="applyView('${v.id}')" title="${esc(v.name)}">
      <span class="pv-tile-count">${typeof cnt==='number'?cnt.toLocaleString():cnt}</span>
      <span class="pv-tile-label">${esc(v.name)}</span></button>`;
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
  const terms=Object.keys(pt).sort((a,b)=>{ const ia=TERM_ORDER.indexOf(a), ib=TERM_ORDER.indexOf(b); if(ia!==-1||ib!==-1) return (ia===-1?99:ia)-(ib===-1?99:ib); return a.localeCompare(b); });
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
  const term=(filters.term||'all').replace(/\s+/g,'_');
  const date=new Date().toISOString().slice(0,10);
  const fname=`sections_${term}_${date}.csv`;
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- connection button ----------
function setScanStatus(html, running){
  const e=$('#scan-status'); if(!e) return;
  e.innerHTML=html||''; e.classList.toggle('running', !!running);
}
async function connectNow(){
  const btn=$('#connect-btn'); if(!btn||btn.disabled)return;
  if(STATIC){ window._staticConnect&&window._staticConnect(); return; }
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Updating…';
  setScanStatus('<span class="spin"></span> Updating…', true);
  try{
    await fetch(API+'/api/connect',{method:'POST'});
    const poll=async()=>{ const st=await (await fetch(API+'/api/status')).json();
      if(st.running){ setTimeout(poll,2500); return; }
      btn.disabled=false; btn.innerHTML='↻ Update data';
      if(st.ok){ setScanStatus('Updated '+(st.count||'?').toLocaleString()+' sections · '+fmtTime(st.finished||new Date().toISOString()), false); toast('Updated — '+(st.count||'?')+' sections'); await load(); }
      else { setScanStatus('Update failed: '+esc(st.error||''), false); toast('Update failed: '+(st.error||'')); } };
    setTimeout(poll,2500);
  }catch(e){ btn.disabled=false; btn.innerHTML='↻ Update data'; setScanStatus('Cannot reach local server', false); toast('Cannot reach local server'); }
}

// ---------- button-row + filter handlers ----------
window.setResolved=v=>{ filters.resolved=(filters.resolved===v?'':v); renderAll(); };
function bindControls(){
  $('#f-term').onchange=e=>{filters.term=e.target.value;renderAll();};
  $('#f-level').onchange=e=>{filters.level=e.target.value;renderAll();};
  $('#f-modality').onchange=e=>{filters.modality=e.target.value;renderAll();};
  $('#f-special').onchange=e=>{filters.special=e.target.value;renderAll();};
  $('#f-college').onchange=e=>{filters.college=e.target.value;renderAll();};
  $('#f-campus').onchange=e=>{filters.campus=e.target.value;renderAll();};
  $('#f-subject').onchange=e=>{filters.subject=e.target.value;renderAll();};
  $('#f-search').oninput=e=>{filters.search=e.target.value;renderTable();};
}
function syncFilterControls(){
  const te=$('#f-term'), lv=$('#f-level'), md=$('#f-modality'), cs=$('#f-college'), ca=$('#f-campus'), su=$('#f-subject'), se=$('#f-search');
  if(te) te.value=filters.term;
  if(lv) lv.value=filters.level;
  if(md) md.value=filters.modality;
  const sp=$('#f-special'); if(sp) sp.value=filters.special;
  if(cs) cs.value=filters.college; if(ca) ca.value=filters.campus;
  if(su) su.value=filters.subject; if(se) se.value=filters.search;
}
window.clearFilters=()=>{ const term=filters.term; Object.keys(filters).forEach(k=>filters[k]=''); filters.term=term; syncFilterControls(); renderAll(); };

function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2600); }

function boot(){ bindControls(); load(); }
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

// ---------- expose inline-handler globals ----------
window.connectNow=connectNow;
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
window.toggleSectionCol=toggleSectionCol;
window.toggleAllSectionCols=toggleAllSectionCols;
window.exportSectionsCsv=exportSectionsCsv;
window.openConsoleModal=openConsoleModal;
window.closeConsoleModal=closeConsoleModal;
window.closeConsoleModalIfBackdrop=closeConsoleModalIfBackdrop;
})();

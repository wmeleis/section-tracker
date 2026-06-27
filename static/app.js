/* Fall 2026 Section Tracker — frontend */
(function () {
'use strict';

const API = window._apiBase || '';
const ADMIN = !!window._isAdmin;
const STATIC = !!window._staticMode;

let allSections = [];
let lastFetch = '', refreshDate = '';
const filters = { college:'', campus:'', subject:'', modality:'', resolved:'', level:'', search:'' };
let sort = { key:'course_code', dir:1 };
const expanded = new Set();
let activeViewId = 'all';

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
const modClass = m => 'pill mod ' + (MOD_CLASS[m] || '');

// Preferred modality ordering for tiles
const MOD_ORDER = ['Traditional','Online','Hybrid','Live Cast','Video Streaming',
  'One-On-One','Cooperative Education','Study Abroad'];

const BUILTIN_VIEWS = [
  { id:'all',        label:'All sections',     f:{} },
  { id:'online',     label:'Online',           f:{modality:'Online'} },
  { id:'hybrid',     label:'Hybrid',           f:{modality:'Hybrid'} },
  { id:'livecast',   label:'Live Cast',        f:{modality:'Live Cast'} },
  { id:'video',      label:'Video Streaming',  f:{modality:'Video Streaming'} },
  { id:'unresolved', label:'Modality unresolved', f:{resolved:'no'} },
  { id:'resolved',   label:'Modality resolved',   f:{resolved:'yes'} },
  { id:'notes',      label:'Has notes',        f:{resolved:'notes'} },
];

const COLUMNS = [
  { key:'course_code', label:'Course' },
  { key:'section',     label:'Sec' },
  { key:'title',       label:'Title' },
  { key:'college',     label:'College', fmt:abbr },
  { key:'campus',      label:'Campus' },
  { key:'instructional_method', label:'Modality' },
  { key:'level',       label:'Lvl' },
  { key:'total_enrolled', label:'Enr', num:true },
  { key:'faculty_name', label:'Faculty' },
  { key:'modality_resolved', label:'Resolved' },
  { key:'notes',       label:'Notes' },
];

const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; };
const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---------- load ----------
async function load() {
  let data;
  if (window._loadSections) { data = await window._loadSections(); }
  else { data = await (await fetch(API + '/api/sections')).json(); }
  allSections = data.sections || [];
  lastFetch = data.last_fetch || '';
  refreshDate = data.refresh_date || '';
  $('#subtitle').textContent = allSections.length.toLocaleString() + ' sections · refreshed ' + (refreshDate || '—');
  $('#last-updated').textContent = lastFetch ? ('pulled ' + fmtTime(lastFetch)) : '';
  setStoreBadge(data.airtable);
  populateFilters();
  renderAll();
}

function fmtTime(iso){ try { return new Date(iso).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET'; } catch(e){ return iso; } }

function setStoreBadge(airtable){
  const b=$('#store-badge'), l=$('#store-label');
  if(STATIC){ b.style.display='none'; return; }
  b.className='badge-dot '+(airtable?'ok':'bad');
  l.textContent = airtable ? 'Airtable notes' : 'local notes (Airtable not connected)';
}

function uniqueSorted(key){ return [...new Set(allSections.map(s=>s[key]).filter(Boolean))].sort(); }

function populateFilters(){
  fillSelect('#f-college', uniqueSorted('college'), abbr);
  fillSelect('#f-campus', uniqueSorted('campus'));
  fillSelect('#f-subject', uniqueSorted('subject'));
  fillSelect('#f-modality', MOD_ORDER.filter(m=>allSections.some(s=>s.instructional_method===m))
                            .concat(uniqueSorted('instructional_method').filter(m=>!MOD_ORDER.includes(m))));
}
function fillSelect(sel, vals, labelFn){
  const e=$(sel); const cur=e.value;
  e.innerHTML='<option value="">All</option>'+vals.map(v=>`<option value="${esc(v)}">${esc(labelFn?labelFn(v)+' — '+v:v)}</option>`).join('');
  e.value=cur;
}

// ---------- filtering ----------
function baseFiltered(skip){
  return allSections.filter(s=>{
    if(skip!=='college' && filters.college && s.college!==filters.college) return false;
    if(skip!=='campus' && filters.campus && s.campus!==filters.campus) return false;
    if(skip!=='subject' && filters.subject && s.subject!==filters.subject) return false;
    if(skip!=='modality' && filters.modality && s.instructional_method!==filters.modality) return false;
    if(skip!=='level' && filters.level && s.level!==filters.level) return false;
    if(skip!=='resolved' && filters.resolved){
      if(filters.resolved==='yes' && !s.modality_resolved) return false;
      if(filters.resolved==='no' && s.modality_resolved) return false;
      if(filters.resolved==='notes' && !(s.notes&&s.notes.trim())) return false;
    }
    if(skip!=='search' && filters.search){
      const q=filters.search.toLowerCase();
      const hay=(s.course_code+' '+s.title+' '+s.crn+' '+s.faculty_name+' '+s.section).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}
const getFiltered = () => baseFiltered(null);

// ---------- render ----------
function renderAll(){ renderModalityBar(); renderViewTiles(); renderHead(); renderTable(); }

function renderModalityBar(){
  const bar=$('#modality-bar'); bar.innerHTML='';
  const rows=baseFiltered('modality');
  const counts={}; rows.forEach(s=>counts[s.instructional_method]=(counts[s.instructional_method]||0)+1);
  const total=rows.length;
  const mk=(label,val,count,activeWhen)=>{
    const t=el('div','mod-tile'+(activeWhen?' active':''));
    t.innerHTML=`<div class="count">${count.toLocaleString()}</div><div class="label">${esc(label)}</div>`;
    t.onclick=()=>{ filters.modality = (filters.modality===val?'':val); $('#f-modality').value=filters.modality; syncViewSelection(); renderAll(); };
    return t;
  };
  bar.appendChild(mk('All', '', total, !filters.modality));
  MOD_ORDER.concat(Object.keys(counts).filter(m=>!MOD_ORDER.includes(m)))
    .filter(m=>counts[m]).forEach(m=>bar.appendChild(mk(m,m,counts[m],filters.modality===m)));
}

function renderViewTiles(){
  const wrap=$('#view-tiles'); wrap.innerHTML='';
  const views=BUILTIN_VIEWS.concat(savedViews());
  views.forEach(v=>{
    const n=countForView(v);
    const c=el('div','view-chip'+(activeViewId===v.id?' active':''));
    c.innerHTML=esc(v.label)+`<span class="n">${n.toLocaleString()}</span>`;
    c.onclick=()=>applyView(v);
    if(v.custom){ const x=el('span',null,' ✕'); x.style.cursor='pointer'; x.onclick=(e)=>{e.stopPropagation();deleteView(v.id);}; c.appendChild(x); }
    wrap.appendChild(c);
  });
  const add=el('div','view-chip','+ Save view'); add.onclick=saveCurrentView; wrap.appendChild(add);
}
function countForView(v){
  const f=Object.assign({college:'',campus:'',subject:'',modality:'',resolved:'',level:'',search:''}, v.f||{});
  return allSections.filter(s=>{
    if(f.college&&s.college!==f.college)return false;
    if(f.campus&&s.campus!==f.campus)return false;
    if(f.subject&&s.subject!==f.subject)return false;
    if(f.modality&&s.instructional_method!==f.modality)return false;
    if(f.level&&s.level!==f.level)return false;
    if(f.resolved==='yes'&&!s.modality_resolved)return false;
    if(f.resolved==='no'&&s.modality_resolved)return false;
    if(f.resolved==='notes'&&!(s.notes&&s.notes.trim()))return false;
    return true;
  }).length;
}
function applyView(v){
  activeViewId=v.id;
  Object.assign(filters,{college:'',campus:'',subject:'',modality:'',resolved:'',level:'',search:''},v.f||{});
  syncFilterControls(); renderAll();
}
function syncViewSelection(){ activeViewId = (BUILTIN_VIEWS.concat(savedViews())).find(v=>sameFilters(v.f||{}))?.id || null; renderViewTiles(); }
function sameFilters(f){
  const d={college:'',campus:'',subject:'',modality:'',resolved:'',level:'',search:''};
  const full=Object.assign({},d,f);
  return ['college','campus','subject','modality','resolved','level'].every(k=>full[k]===filters[k]) && !filters.search;
}

function savedViews(){ try{return JSON.parse(localStorage.getItem('sectrk-views')||'[]');}catch(e){return[];} }
function saveCurrentView(){
  const name=prompt('Name this view:'); if(!name)return;
  const v={id:'custom_'+Date.now(),label:name,custom:true,f:{
    college:filters.college,campus:filters.campus,subject:filters.subject,
    modality:filters.modality,resolved:filters.resolved,level:filters.level}};
  const arr=savedViews(); arr.push(v); localStorage.setItem('sectrk-views',JSON.stringify(arr));
  activeViewId=v.id; renderViewTiles();
}
function deleteView(id){ localStorage.setItem('sectrk-views',JSON.stringify(savedViews().filter(v=>v.id!==id))); renderViewTiles(); }

function renderHead(){
  const tr=$('#thead-row'); tr.innerHTML='';
  COLUMNS.forEach(c=>{
    const th=el('th',null,esc(c.label)+(sort.key===c.key?` <span class="arrow">${sort.dir>0?'▲':'▼'}</span>`:''));
    th.onclick=()=>{ if(sort.key===c.key)sort.dir*=-1; else {sort.key=c.key;sort.dir=1;} renderTable(); renderHead(); };
    tr.appendChild(th);
  });
}

function renderTable(){
  const rows=getFiltered();
  rows.sort((a,b)=>{
    let x=a[sort.key], y=b[sort.key];
    const col=COLUMNS.find(c=>c.key===sort.key);
    if(col&&col.num){ x=+x||0; y=+y||0; return (x-y)*sort.dir; }
    x=(x==null?'':String(x)).toLowerCase(); y=(y==null?'':String(y)).toLowerCase();
    return x<y?-sort.dir:x>y?sort.dir:0;
  });
  $('#summary').innerHTML = `<b>${rows.length.toLocaleString()}</b> of ${allSections.length.toLocaleString()} sections`+
    ` · <b>${rows.reduce((n,s)=>n+(+s.total_enrolled||0),0).toLocaleString()}</b> seats enrolled`;
  const tb=$('#tbody'); tb.innerHTML='';
  rows.slice(0,2000).forEach(s=>{
    const tr=el('tr','section-row'+(expanded.has(s.crn)?' open':''));
    tr.onclick=(e)=>{ if(e.target.tagName!=='A') toggleRow(s.crn); };
    tr.innerHTML =
      `<td class="code">${esc(s.course_code)}</td>`+
      `<td>${esc(s.section)}</td>`+
      `<td>${esc(s.title)}</td>`+
      `<td title="${esc(s.college)}">${esc(abbr(s.college))}</td>`+
      `<td class="muted">${esc(s.campus)}</td>`+
      `<td><span class="${modClass(s.instructional_method)}">${esc(s.instructional_method||'—')}</span></td>`+
      `<td><span class="pill lvl">${esc(s.level||'—')}</span></td>`+
      `<td class="enr">${(+s.total_enrolled||0)}</td>`+
      `<td class="muted">${esc(s.faculty_name||'—')}</td>`+
      `<td>${s.modality_resolved?'<span class="resolved-yes">✓ Yes</span>':'<span class="resolved-no">—</span>'}</td>`+
      `<td>${s.notes&&s.notes.trim()?'<span class="has-note">📝</span>':''}</td>`;
    tb.appendChild(tr);
    if(expanded.has(s.crn)){
      const dr=el('tr','detail-row'); const td=el('td'); td.colSpan=COLUMNS.length;
      td.appendChild(renderDetail(s)); dr.appendChild(td); tb.appendChild(dr);
    }
  });
  if(rows.length>2000){ const tr=el('tr'); tr.innerHTML=`<td colspan="${COLUMNS.length}" class="muted" style="text-align:center;padding:12px">Showing first 2,000 of ${rows.length.toLocaleString()} — narrow filters to see the rest.</td>`; tb.appendChild(tr); }
}

function toggleRow(crn){ if(expanded.has(crn))expanded.delete(crn); else {expanded.clear(); expanded.add(crn);} renderTable(); }

function renderDetail(s){
  const d=el('div','detail');
  const kv=(rows)=>'<div class="kv">'+rows.map(([k,v])=>`<div class="k">${esc(k)}</div><div>${v==null?'—':esc(v)||'—'}</div>`).join('')+'</div>';
  const left=el('div'); left.innerHTML='<h4>Section</h4>'+kv([
    ['CRN',s.crn],['Course',s.course_code],['Section',s.section],['Title',s.title],
    ['College',s.college],['Campus',s.campus],['Level',s.level],['Schedule',s.schedule],
    ['Enrolled',s.total_enrolled],['Honors',s.honors_ind]]);
  const right=el('div'); right.innerHTML='<h4>Modality &amp; logistics</h4>'+kv([
    ['Instructional Method',s.instructional_method],['Meeting Time',s.meeting_time],
    ['Location',s.location],['Faculty',s.faculty_name],['Faculty Email',s.faculty_email],
    ['Faculty Type',s.faculty_type],['Attributes',s.attributes]]);
  d.appendChild(left); d.appendChild(right);

  // Modality Resolved (owner-only)
  const resWrap=el('div','full'); resWrap.innerHTML='<h4>Modality Resolved</h4>';
  const tog=el('button','switch'+(s.modality_resolved?' on':''));
  tog.innerHTML='<span class="knob"></span>';
  const tl=el('span',null,s.modality_resolved?'Yes':'No');
  const wrap=el('div','toggle'); wrap.appendChild(tog); wrap.appendChild(tl);
  if(ADMIN){
    tog.onclick=async()=>{ const nv=!s.modality_resolved; tog.disabled=true;
      const r=await saveResolved(s,nv); tog.disabled=false;
      if(r&&r.ok){ s.modality_resolved=nv; tog.className='switch'+(nv?' on':''); tl.textContent=nv?'Yes':'No'; toast('Modality Resolved → '+(nv?'Yes':'No')); renderModalityBar(); renderViewTiles(); }
      else toast('Save failed'); };
  } else { tog.disabled=true; const ro=el('span','readonly-note','  (set by the Graduate Dean’s office)'); wrap.appendChild(ro); }
  resWrap.appendChild(wrap); d.appendChild(resWrap);

  // Notes (colleges)
  const noteWrap=el('div','full'); noteWrap.innerHTML='<h4>College notes</h4>';
  const ta=el('textarea','note-box'); ta.value=s.notes||''; ta.placeholder='Add a note about this section…';
  const actions=el('div','note-actions');
  const save=el('button','btn btn-primary','Save note');
  const saved=el('span','note-saved'); saved.style.display='none'; saved.textContent='Saved ✓';
  const who=s.updated_by?el('span','muted','last edited by '+esc(s.updated_by)):el('span');
  save.onclick=async()=>{ save.disabled=true; const r=await saveNote(s,ta.value); save.disabled=false;
    if(r&&r.ok){ s.notes=ta.value; saved.style.display=''; setTimeout(()=>saved.style.display='none',2000); renderViewTiles(); }
    else toast('Save failed'); };
  actions.appendChild(save); actions.appendChild(saved); actions.appendChild(who);
  noteWrap.appendChild(ta); noteWrap.appendChild(actions); d.appendChild(noteWrap);
  return d;
}
function renderTableCellNote(){ /* refresh handled on next renderTable */ }

// ---------- saves (overridable for static/Airtable-direct) ----------
async function saveNote(s, notes){
  if(window._saveNote) return window._saveNote(s, notes);
  return (await fetch(API+`/api/section/${encodeURIComponent(s.crn)}/note`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({notes, course:s.course_code, college:s.college, updated_by:window._editor||''})})).json();
}
async function saveResolved(s, val){
  if(window._saveResolved) return window._saveResolved(s, val);
  return (await fetch(API+`/api/section/${encodeURIComponent(s.crn)}/resolved`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({resolved:val, course:s.course_code, college:s.college, updated_by:'owner'})})).json();
}

// ---------- connection button ----------
async function connectNow(){
  const btn=$('#connect-btn'); if(btn.disabled)return;
  if(STATIC){ window._staticConnect&&window._staticConnect(); return; }
  btn.disabled=true; btn.innerHTML='<span class="spin"></span> Updating…';
  try{
    await fetch(API+'/api/connect',{method:'POST'});
    const poll=async()=>{ const st=await (await fetch(API+'/api/status')).json();
      if(st.running){ setTimeout(poll,2500); return; }
      btn.disabled=false; btn.innerHTML='↻ Update data';
      if(st.ok){ toast('Updated — '+(st.count||'?')+' sections'); await load(); }
      else toast('Update failed: '+(st.error||'')); };
    setTimeout(poll,2500);
  }catch(e){ btn.disabled=false; btn.innerHTML='↻ Update data'; toast('Cannot reach local server'); }
}
window.connectNow=connectNow;

// ---------- filter controls ----------
function bindControls(){
  $('#f-college').onchange=e=>{filters.college=e.target.value;syncViewSelection();renderAll();};
  $('#f-campus').onchange=e=>{filters.campus=e.target.value;renderAll();};
  $('#f-subject').onchange=e=>{filters.subject=e.target.value;renderAll();};
  $('#f-modality').onchange=e=>{filters.modality=e.target.value;syncViewSelection();renderAll();};
  $('#f-resolved').onchange=e=>{filters.resolved=e.target.value;syncViewSelection();renderAll();};
  $('#f-search').oninput=e=>{filters.search=e.target.value;renderTable();};
  $('#seg-level').querySelectorAll('button').forEach(b=>b.onclick=()=>{
    filters.level=b.dataset.v; $('#seg-level').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));
    syncViewSelection(); renderAll();
  });
}
function syncFilterControls(){
  $('#f-college').value=filters.college; $('#f-campus').value=filters.campus;
  $('#f-subject').value=filters.subject; $('#f-modality').value=filters.modality;
  $('#f-resolved').value=filters.resolved; $('#f-search').value=filters.search;
  $('#seg-level').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.v===filters.level));
}
function clearFilters(){ applyView(BUILTIN_VIEWS[0]); }
window.clearFilters=clearFilters;

function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2600); }

function boot(){ bindControls(); load(); }
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();

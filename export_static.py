"""
export_static.py — build the password-gated static site into docs/.

Scheme (mirrors the program tracker):
  - Section facts are baked into data.json.enc (AES-256-GCM, key = PBKDF2 of the
    site password). Heavy + slow-changing, so it's a daily snapshot.
  - The Airtable base id / table id / token ride INSIDE the encrypted payload
    (never plaintext on GitHub), so once a visitor passes the gate the dashboard
    reads college Notes + Modality Resolved LIVE from Airtable and writes Notes
    back directly. That makes notes appear immediately for everyone and lets the
    owner's Modality Resolved flags propagate without a rebuild.
  - Modality Resolved is rendered read-only on the static site (is_admin=false),
    so colleges can't set it through the UI — only the owner does, from the local
    app. (The embedded token technically can write any field via raw API; the UI
    just never exposes it. Move Modality Resolved to a separate base if you ever
    need hard enforcement.)
"""
import os
import json
import base64
import subprocess
import datetime
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

import database as db
import notes_store

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(HERE, 'docs')
SITE_PASSWORD = 'husky26'          # shared with the program tracker
PBKDF2_ITERATIONS = 200_000
CACHE_BUST = datetime.datetime.now().strftime('%Y%m%d%H%M%S')


def _derive_key(password, salt):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=PBKDF2_ITERATIONS)
    return kdf.derive(password.encode())


def _encrypt_to_file(plaintext, key, out_path):
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    with open(out_path, 'wb') as f:
        f.write(iv + ct)


def _load_or_create_salt():
    p = os.path.join(DOCS, 'crypto.json')
    if os.path.exists(p):
        try:
            return base64.b64decode(json.load(open(p))['salt'])
        except Exception:
            pass
    return os.urandom(16)


def _load_team_views():
    """Shared (team) section views, baked into the static payload read-only.
    Personal views still live in each browser's localStorage."""
    p = os.path.join(HERE, 'data', 'section_views.json')
    try:
        with open(p) as f:
            data = json.load(f)
        return data.get('views', []) if isinstance(data, dict) else (data or [])
    except Exception:
        return []


def export_data(salt, key):
    sections = db.get_all_sections()
    notes = notes_store.get_all_notes()
    per_term = {}
    for s in sections:
        n = notes.get(s['id'], {})  # id = "{term}|{crn}"
        s['notes'] = n.get('notes', '')
        s['modality_resolved'] = bool(n.get('modality_resolved', False))
        s['updated_by'] = n.get('updated_by', '')
        # trim heavy fields not shown on the shared table (keeps the payload small)
        s.pop('course_description', None)
        s.pop('fetched_at', None)
        # previous_offerings is stored as a JSON string; ship a real array
        po = s.get('previous_offerings')
        if po:
            try:
                s['previous_offerings'] = json.loads(po)
            except (ValueError, TypeError):
                s['previous_offerings'] = []
        else:
            s['previous_offerings'] = []
        t = s.get('term', '') or '(none)'
        per_term[t] = per_term.get(t, 0) + 1
    built_at = datetime.datetime.now().astimezone().isoformat()
    db.set_meta('last_build', built_at)   # so the local app can show it too
    payload = {
        'sections': sections,
        'last_fetch': db._iso_local(db.get_meta('last_fetch')),
        'refresh_date': db.get_meta('refresh_date'),
        'built_at': built_at,
        'is_admin': False,
        'per_term': per_term,
        'team_views': _load_team_views(),
        'airtable': {
            'base': notes_store.AIRTABLE_BASE,
            'table': notes_store.AIRTABLE_TABLE,
            'token': notes_store._token(),
        },
    }
    _encrypt_to_file(json.dumps(payload).encode(), key,
                     os.path.join(DOCS, 'data.json.enc'))
    with open(os.path.join(DOCS, 'crypto.json'), 'w') as f:
        json.dump({'salt': base64.b64encode(salt).decode(), 'iterations': PBKDF2_ITERATIONS,
                   'algorithm': 'AES-256-GCM', 'kdf': 'PBKDF2-SHA256'}, f)
    return len(sections)


# --- static overrides prepended to app.js ---
STATIC_OVERRIDE = r'''/* ===== STATIC SITE OVERRIDES (injected by export_static.py) ===== */
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
'''


GATE_HEAD = '''<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fall 2026 Section Tracker</title>
<link rel="stylesheet" href="style.css?v={cb}">
<style>
#gate{{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f8f9fa;z-index:1000;font-family:-apple-system,Segoe UI,Roboto,sans-serif}}
#gate .card{{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:32px;box-shadow:0 4px 12px rgba(0,0,0,.08);width:340px;text-align:center}}
#gate h2{{font-size:18px;margin-bottom:6px}} #gate p{{color:#64748b;font-size:13px;margin-bottom:18px}}
#gate input{{width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;margin-bottom:10px}}
#gate button{{width:100%;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}}
#gate label{{display:flex;gap:6px;align-items:center;font-size:12px;color:#64748b;margin:6px 0 12px;justify-content:center}}
#gate .err{{color:#ef4444;font-size:13px;min-height:18px}}
</style></head><body>
<div id="gate"><div class="card">
  <h2>Fall 2026 Section Tracker</h2>
  <p>Enter the access password.</p>
  <form id="gate-form">
    <input type="password" id="gate-pw" placeholder="Password" autofocus autocomplete="current-password">
    <label><input type="checkbox" id="gate-remember" checked> Remember me on this device</label>
    <button type="submit" id="gate-submit">Unlock</button>
    <div class="err" id="gate-err"></div>
  </form>
</div></div>
'''


def build_index(body_markup):
    gate_script = '''
<script>
(function(){
  const ENC_FILES = new Set(['data.json']);
  const REMEMBER_KEY='sectrk-key-v1', REMEMBER_TTL=30*864e5, CB="%CB%";
  const dec=new TextDecoder(); let key=null; const cache=new Map();
  const gate=document.getElementById('gate'), form=document.getElementById('gate-form'),
        pw=document.getElementById('gate-pw'), err=document.getElementById('gate-err'),
        sub=document.getElementById('gate-submit'), rem=document.getElementById('gate-remember');
  const b64=s=>{const b=atob(s),o=new Uint8Array(b.length);for(let i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o;};
  async function derive(p,salt,it){const bk=await crypto.subtle.importKey('raw',new TextEncoder().encode(p),{name:'PBKDF2'},false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:it,hash:'SHA-256'},bk,{name:'AES-GCM',length:256},true,['decrypt']);}
  async function decrypt(k,blob){const iv=blob.slice(0,12),ct=blob.slice(12);return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},k,ct));}
  async function fetchDec(path){if(cache.has(path))return cache.get(path);
    const r=await fetch(path+'.enc?v='+CB,{cache:'no-store'});if(!r.ok)throw new Error('fetch');
    const obj=JSON.parse(await decrypt(key,new Uint8Array(await r.arrayBuffer())));cache.set(path,obj);return obj;}
  const of=window.fetch.bind(window);
  window.fetch=async function(u,o){const n=typeof u==='string'?u.replace(/^\\.\\//,'').split('?')[0]:null;
    if(n&&ENC_FILES.has(n)){const obj=await fetchDec(n);return new Response(JSON.stringify(obj),{status:200,headers:{'Content-Type':'application/json'}});}
    return of(u,o);};
  async function params(){return (await fetch('crypto.json?v='+CB)).json();}
  async function verify(k){const r=await fetch('data.json.enc?v='+CB);const obj=JSON.parse(await decrypt(k,new Uint8Array(await r.arrayBuffer())));cache.set('data.json',obj);return obj;}
  function boot(){gate.style.display='none';document.getElementById('app-root').style.display='';
    const s=document.createElement('script');s.src='app.js?v='+CB;document.head.appendChild(s);}
  async function unlock(p){const pr=await params();const k=await derive(p,b64(pr.salt),pr.iterations);await verify(k);key=k;
    if(rem.checked){try{const jwk=await crypto.subtle.exportKey('jwk',k);localStorage.setItem(REMEMBER_KEY,JSON.stringify({jwk,exp:Date.now()+REMEMBER_TTL}));}catch(e){}}boot();}
  form.addEventListener('submit',async e=>{e.preventDefault();err.textContent='';sub.disabled=true;sub.textContent='Unlocking…';
    try{await unlock(pw.value);}catch(x){err.textContent='Wrong password.';sub.disabled=false;sub.textContent='Unlock';pw.select();}});
  (async()=>{try{const raw=localStorage.getItem(REMEMBER_KEY);if(!raw)return;const {jwk,exp}=JSON.parse(raw);
    if(Date.now()>exp){localStorage.removeItem(REMEMBER_KEY);return;}const k=await crypto.subtle.importKey('jwk',jwk,{name:'AES-GCM'},true,['decrypt']);
    await verify(k);key=k;boot();}catch(e){localStorage.removeItem(REMEMBER_KEY);}})();
})();
</script>
</body></html>'''
    return (GATE_HEAD.format(cb=CACHE_BUST)
            + body_markup
            + gate_script.replace('%CB%', CACHE_BUST))


def build():
    os.makedirs(DOCS, exist_ok=True)
    salt = _load_or_create_salt()
    key = _derive_key(SITE_PASSWORD, salt)
    n = export_data(salt, key)

    # style.css
    with open(os.path.join(HERE, 'static', 'style.css')) as f:
        css = f.read()
    with open(os.path.join(DOCS, 'style.css'), 'w') as f:
        f.write(css)

    # app.js = overrides + base
    with open(os.path.join(HERE, 'static', 'app.js')) as f:
        base_js = f.read()
    with open(os.path.join(DOCS, 'app.js'), 'w') as f:
        f.write(STATIC_OVERRIDE + '\n' + base_js)

    # index.html — app-root markup with relative asset paths, no /static/, no connect button
    with open(os.path.join(HERE, 'templates', 'dashboard.html')) as f:
        tmpl = f.read()
    # extract the <div id="app-root">…</div> block
    start = tmpl.index('<div id="app-root">')
    end = tmpl.index('<div class="toast"')
    body = tmpl[start:end]
    body = body.replace('/static/', '')
    # hidden until the gate unlocks (boot() reveals it) — gate is now a sibling
    body = body.replace('<div id="app-root">', '<div id="app-root" style="display:none">', 1)
    # drop the local-server-only buttons on the static site (Console + Update);
    # Views (team read-only), Columns, and Export stay.
    body = body.replace('<button class="header-secondary-btn" id="console-btn" onclick="openConsoleModal()">Console</button>', '')
    body = body.replace('<button class="header-secondary-btn" id="connect-btn" onclick="connectNow()">↻ Update data</button>', '')
    body += '<div class="toast" id="toast"></div>'
    with open(os.path.join(DOCS, 'index.html'), 'w') as f:
        f.write(build_index(body))

    print(f'built docs/ — {n} sections, password {SITE_PASSWORD!r}')
    return n


if __name__ == '__main__':
    build()

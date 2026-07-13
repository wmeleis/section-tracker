"""
notes_store.py — Editable overlay (college Notes + owner-only Modality Resolved).

Single source of truth = an Airtable base the owner created. Colleges type notes
on the dashboard; those writes go straight to Airtable (same inline pattern as
the Retention tracker). Modality Resolved is written only from the local/admin
app (the static site renders no control for it), so in practice only the owner
sets it.

If Airtable is unreachable or the token can't see the base yet, everything
degrades to a local JSON file so the tracker stays fully functional; flip to
Airtable automatically once the token's base access is granted.

Keyed by CRN. Field names in the Airtable table:
    CRN · Course · College · Notes · Modality Resolved (Yes/No) · Updated By
"""
import os
import json
import time
import datetime
import subprocess
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_PATH = os.path.join(HERE, 'data', 'notes_local.json')
TOKEN_PATH = os.path.join(HERE, 'data', 'airtable_token')   # project-dir credential (gitignored)

AIRTABLE_BASE  = 'appPpmcDzhL2BllHu'
AIRTABLE_TABLE = 'tblUbDvuKPudNy6d8'
KEYCHAIN_SERVICE = 'airtable-sections'

F_CRN, F_COURSE, F_COLLEGE = 'CRN', 'Course', 'College'
F_NOTES, F_RESOLVED, F_BY  = 'Notes', 'Modality Resolved', 'Updated By'
F_TERM = 'Term'

def _key(term, crn):
    """Notes key — CRNs repeat across terms, so key on (term, crn)."""
    return f'{term}|{crn}' if term else str(crn)

_token_cache = None
_avail_cache = None  # None=unknown, True/False once probed


def _token():
    """Airtable PAT, resolved in order so the project is self-contained but the
    Keychain still works as a fallback:
      1. data/airtable_token  (project-dir credential file, gitignored — the source of truth)
      2. AIRTABLE_TOKEN env var
      3. macOS Keychain  security -s airtable-sections -a token  (legacy fallback)
    See CLAUDE.md → Credentials for how to (re)create the file."""
    global _token_cache
    if _token_cache is None:
        _token_cache = ''
        try:
            with open(TOKEN_PATH) as f:
                _token_cache = f.read().strip()
        except Exception:
            pass
        if not _token_cache:
            _token_cache = (os.environ.get('AIRTABLE_TOKEN') or '').strip()
        if not _token_cache:
            try:
                _token_cache = subprocess.check_output(
                    ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'token', '-w'],
                    stderr=subprocess.DEVNULL).decode().strip()
            except Exception:
                _token_cache = ''
    return _token_cache


def _api(method, path='', body=None, timeout=30):
    tok = _token()
    if not tok:
        raise RuntimeError('no airtable token')
    url = f'https://api.airtable.com/v0/{AIRTABLE_BASE}/{AIRTABLE_TABLE}{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': f'Bearer {tok}',
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace')
        raise urllib.error.HTTPError(e.url, e.code, detail, e.headers, None)


import re as _re
def _unknown_field(err_text):
    m = _re.search(r'Unknown field name:\s*"([^"]+)"', err_text or '')
    return m.group(1) if m else None


def airtable_available(force=False):
    global _avail_cache
    if _avail_cache is not None and not force:
        return _avail_cache
    try:
        _api('GET', '?maxRecords=1')
        _avail_cache = True
    except Exception:
        _avail_cache = False
    return _avail_cache


# ---------------------------------------------------------------------------
# Local JSON fallback
# ---------------------------------------------------------------------------

def _load_local():
    if os.path.exists(LOCAL_PATH):
        try:
            with open(LOCAL_PATH) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save_local(d):
    os.makedirs(os.path.dirname(LOCAL_PATH), exist_ok=True)
    tmp = LOCAL_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, indent=1)
    os.replace(tmp, LOCAL_PATH)


# ---------------------------------------------------------------------------
# Public API — always {crn: {notes, modality_resolved, updated_by}}
# ---------------------------------------------------------------------------

def get_all_notes():
    if airtable_available():
        try:
            out, offset = {}, None
            while True:
                path = '?pageSize=100' + (f'&offset={offset}' if offset else '')
                d = _api('GET', path)
                for rec in d.get('records', []):
                    f = rec.get('fields', {})
                    crn = str(f.get(F_CRN, '')).strip()
                    if not crn:
                        continue
                    rv = f.get(F_RESOLVED)
                    resolved = (rv is True) or (str(rv).strip().lower() in ('yes', 'true', '✓'))
                    out[_key(f.get(F_TERM, ''), crn)] = {
                        'notes': f.get(F_NOTES, '') or '',
                        'modality_resolved': resolved,
                        'updated_by': f.get(F_BY, '') or '',
                        '_rec_id': rec.get('id'),
                    }
                offset = d.get('offset')
                if not offset:
                    break
            return out
        except Exception:
            pass  # fall through to local
    return {k: {kk: vv for kk, vv in val.items()} for k, val in _load_local().items()}


def _upsert_airtable(crn, term, fields):
    """Upsert keyed on (CRN, Term), self-healing past fields/merge-keys that
    don't exist yet (e.g. before the owner adds the 'Term' or 'Modality
    Resolved' fields). Drops an unknown field/merge-key and retries so the rest
    still saves."""
    fields = dict(fields)
    fields[F_CRN] = str(crn)
    if term:
        fields[F_TERM] = term
    merge = [F_CRN, F_TERM] if term else [F_CRN]
    for _ in range(len(fields) + 2):
        body = {'performUpsert': {'fieldsToMergeOn': merge},
                'records': [{'fields': fields}], 'typecast': True}
        try:
            _api('PATCH', '', body)
            return
        except urllib.error.HTTPError as e:
            missing = _unknown_field(getattr(e, 'msg', '') or str(e))
            if missing == F_TERM:                 # Term field not added yet
                fields.pop(F_TERM, None); merge = [F_CRN]; continue
            if missing and missing in fields:
                del fields[missing]; continue
            raise


def set_note(crn, term, notes, updated_by='', course='', college=''):
    crn = str(crn)
    if airtable_available():
        fields = {F_NOTES: notes, F_BY: updated_by or 'web'}
        if course:  fields[F_COURSE] = course
        if college: fields[F_COLLEGE] = college
        _upsert_airtable(crn, term, fields)
        return {'ok': True, 'store': 'airtable'}
    d = _load_local(); k = _key(term, crn)
    rec = d.get(k, {}); rec.update({'notes': notes, 'updated_by': updated_by or 'local',
        'updated_at': datetime.datetime.now().isoformat(timespec='seconds')})
    d[k] = rec; _save_local(d)
    return {'ok': True, 'store': 'local'}


def set_resolved(crn, term, resolved, updated_by='', course='', college=''):
    crn = str(crn)
    if airtable_available():
        fields = {F_RESOLVED: ('Yes' if resolved else 'No'), F_BY: updated_by or 'owner'}
        if course:  fields[F_COURSE] = course
        if college: fields[F_COLLEGE] = college
        _upsert_airtable(crn, term, fields)
        return {'ok': True, 'store': 'airtable'}
    d = _load_local(); k = _key(term, crn)
    rec = d.get(k, {}); rec.update({'modality_resolved': bool(resolved),
        'updated_by': updated_by or 'owner',
        'updated_at': datetime.datetime.now().isoformat(timespec='seconds')})
    d[k] = rec; _save_local(d)
    return {'ok': True, 'store': 'local'}


if __name__ == '__main__':
    print('airtable available:', airtable_available(force=True))
    print('notes on file:', len(get_all_notes()))

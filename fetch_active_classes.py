"""
fetch_active_classes.py — Pull the Fall 2026 section roster from Tableau.

Mechanism (no browser needed for the recurring pull):
  The Registrar's "Active Classes" Tableau view is gated behind two empty
  multi-selects (Subject Code, Class College) plus a term parameter, so a plain
  REST export comes back empty. The owner saved a Tableau **Custom View** named
  "Fall 2026" with Term=Fall 2026 + all subjects + all colleges selected. A
  custom view bakes its filter state server-side, so the REST custom-view data
  endpoint returns the full section table in one request.

      /api/exp/sites/{site_id}/customviews/{cv_id}/data   ->  CSV

  This is the same pattern the Retention tracker uses (scripts/downloaders/
  tableau_client.py). Credentials come from data/tableau_pat.json (gitignored).

To change which term/selection is pulled, edit the "Fall 2026" custom view in
the browser (it stays server-side) — no code change needed.
"""
import os
import csv
import io
import json
import time
import urllib.request
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PAT_PATH = os.path.join(HERE, 'data', 'tableau_pat.json')

TABLEAU_HOST = 'https://tableau.northeastern.edu'
SITE_NAME    = 'Registrar'
API_VERSION  = '3.24'
WORKBOOK     = 'Active Classes'
CUSTOM_VIEW  = 'Fall 2026'
TERM_LABEL   = 'Fall 2026'

RAW_CSV = os.path.join(HERE, 'data', 'active_classes_fall26.csv')

# Values that mean "no data" in the registrar feed.
_EMPTY = {'', 'na', 'null', 'n/a', 'none'}


def _clean(v):
    if v is None:
        return ''
    v = str(v).strip()
    return '' if v.lower() in _EMPTY else v


# ---------------------------------------------------------------------------
# Tableau REST
# ---------------------------------------------------------------------------

def _http(method, url, headers=None, body=None, timeout=180):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _signin():
    with open(PAT_PATH) as f:
        creds = json.load(f)
    body = json.dumps({'credentials': {
        'personalAccessTokenName': creds['token_name'],
        'personalAccessTokenSecret': creds['token_secret'],
        'site': {'contentUrl': creds.get('site', SITE_NAME)},
    }}).encode()
    status, raw = _http('POST', f'{TABLEAU_HOST}/api/{API_VERSION}/auth/signin',
                        {'Content-Type': 'application/json', 'Accept': 'application/json'}, body)
    if status != 200:
        raise RuntimeError(f'Tableau signin failed: HTTP {status}: {raw[:200]}')
    d = json.loads(raw)
    return d['credentials']['token'], d['credentials']['site']['id']


def _find_custom_view(token, site_id, workbook_name, cv_name):
    # Locate the base view in the workbook, then the named custom view on it.
    url = (f'{TABLEAU_HOST}/api/{API_VERSION}/sites/{site_id}/views'
           f'?filter=workbookName:eq:{urllib.parse.quote(workbook_name)}')
    status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': 'application/json'})
    if status != 200:
        raise RuntimeError(f'list views HTTP {status}: {raw[:200]}')
    views = json.loads(raw).get('views', {}).get('view', [])
    if not views:
        raise RuntimeError(f'No views in workbook {workbook_name!r}')
    view_id = views[0]['id']

    url = f'{TABLEAU_HOST}/api/{API_VERSION}/sites/{site_id}/customviews?viewId={view_id}'
    status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': 'application/json'})
    if status != 200:
        raise RuntimeError(f'list customviews HTTP {status}: {raw[:200]}')
    cvs = json.loads(raw).get('customViews', {}).get('customView', [])
    avail = [c.get('name') for c in cvs]
    for c in cvs:
        if (c.get('name') or '').strip().lower() == cv_name.strip().lower():
            return c['id']
    raise RuntimeError(f'Custom view {cv_name!r} not found. Available: {avail}')


def _signout(token):
    try:
        _http('POST', f'{TABLEAU_HOST}/api/{API_VERSION}/auth/signout',
              {'X-Tableau-Auth': token}, timeout=20)
    except Exception:
        pass


def download_csv():
    """Sign in, download the Fall 2026 custom view CSV text, save it, return it."""
    token, site_id = _signin()
    try:
        cv_id = _find_custom_view(token, site_id, WORKBOOK, CUSTOM_VIEW)
        url = f'{TABLEAU_HOST}/api/exp/sites/{site_id}/customviews/{cv_id}/data'
        status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': '*/*'})
        if status != 200:
            raise RuntimeError(f'customview data HTTP {status}: {raw[:200]}')
        text = raw.decode('utf-8-sig', errors='replace')
        os.makedirs(os.path.dirname(RAW_CSV), exist_ok=True)
        with open(RAW_CSV, 'w', encoding='utf-8') as f:
            f.write(text)
        return text
    finally:
        _signout(token)


# ---------------------------------------------------------------------------
# Parse + collapse to one row per CRN
# ---------------------------------------------------------------------------

def parse_sections(csv_text):
    """Collapse the row-per-(CRN×meeting/faculty) CSV into one dict per CRN.

    Tableau emits duplicate rows when a section has multiple meeting patterns
    or faculty; we group by CRN and merge those multi-valued fields.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    by_crn = {}
    order = []
    for row in reader:
        crn = _clean(row.get('CRN'))
        if not crn or crn.lower() == 'all':
            continue  # skip Tableau grand-total artifact rows
        if (_clean(row.get('Class Term')) or '').lower() == 'all':
            continue
        # drop administrative placeholders (no real subject / "Administrative Non-CEU")
        if not _clean(row.get('Subject Code')):
            continue
        if _clean(row.get('Class Title')).lower().startswith('administrative'):
            continue
        if crn not in by_crn:
            by_crn[crn] = _make_section(crn, row)
            order.append(crn)
        else:
            _merge_multivalue(by_crn[crn], row)
    return [by_crn[c] for c in order]


_MULTI = {
    'faculty_name': 'Faculty Name',
    'faculty_email': 'Faculty Email',
    'meeting_time': 'Meeting Time',
    'location': 'Class Location',
}


def _make_section(crn, row):
    subject = _clean(row.get('Subject Code'))
    number  = _clean(row.get('Course Number'))
    try:
        enrolled = int(float(_clean(row.get('Total Enrolled')) or 0))
    except ValueError:
        enrolled = 0
    sec = {
        'crn': crn,
        'subject': subject,
        'course_number': number,
        'course_code': (f'{subject} {number}').strip(),
        'section': _clean(row.get('Class Section')),
        'title': _clean(row.get('Class Title')),
        'college': _clean(row.get('Class College')),
        'campus': _clean(row.get('Class Campus')),
        'instructional_method': _clean(row.get('Instructional Method')),
        'level': _clean(row.get('Level')),
        'schedule': _clean(row.get('Schedule')),
        'meeting_time': _clean(row.get('Meeting Time')),
        'location': _clean(row.get('Class Location')),
        'faculty_name': _clean(row.get('Faculty Name')),
        'faculty_email': _clean(row.get('Faculty Email')),
        'faculty_type': _clean(row.get('Faculty Type')),
        'faculty_category': _clean(row.get('Faculty Category')),
        'honors_ind': _clean(row.get('Honors Ind')),
        'attributes': _clean(row.get('Attributes')),
        'course_description': _clean(row.get('Course Description')),
        'total_enrolled': enrolled,
        'term': _clean(row.get('Class Term')),
        'refresh_date': _clean(row.get('Refresh Date')),
    }
    return sec


def _merge_multivalue(sec, row):
    for key, col in _MULTI.items():
        v = _clean(row.get(col))
        if not v:
            continue
        existing = [p.strip() for p in sec[key].split(';') if p.strip()] if sec[key] else []
        if v not in existing:
            existing.append(v)
            sec[key] = '; '.join(existing)
    # keep the largest enrollment seen
    try:
        e = int(float(_clean(row.get('Total Enrolled')) or 0))
        if e > sec['total_enrolled']:
            sec['total_enrolled'] = e
    except ValueError:
        pass


def fetch_and_parse(use_cache=False):
    """Return (sections, refresh_date). use_cache reads the last saved CSV."""
    if use_cache and os.path.exists(RAW_CSV):
        with open(RAW_CSV, encoding='utf-8') as f:
            text = f.read()
    else:
        text = download_csv()
    sections = parse_sections(text)
    refresh = sections[0]['refresh_date'] if sections else ''
    return sections, refresh


if __name__ == '__main__':
    import sys
    cache = '--cache' in sys.argv
    secs, refresh = fetch_and_parse(use_cache=cache)
    print(f'{len(secs)} sections (refresh {refresh})')
    from collections import Counter
    print('modalities:', dict(Counter(s['instructional_method'] for s in secs)))

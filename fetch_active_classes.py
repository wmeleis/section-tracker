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
import re
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

# Each term is a shared Tableau Custom View on the "Active Classes" view, saved
# with Term + all subjects + all colleges selected. `label` is the canonical
# term name used everywhere (filter, notes key). Add a term by saving a new
# custom view and listing it here.
TERMS = [
    {'cv': 'Fall 2026',   'label': 'Fall 2026'},
    {'cv': 'Spring 2026', 'label': 'Spring 2026'},
    {'cv': 'Summer 2026', 'label': 'Summer 2026'},
]

def _raw_csv(label):
    slug = label.lower().replace(' ', '_')
    return os.path.join(HERE, 'data', f'active_classes_{slug}.csv')

# Values that mean "no data" in the registrar feed.
_EMPTY = {'', 'na', 'null', 'n/a', 'none'}


def _clean(v):
    if v is None:
        return ''
    v = str(v).strip()
    return '' if v.lower() in _EMPTY else v


# Special-topics detector — derived from the course TITLE alone (not the
# Registrar's summary sheet). Explicit markers only, covering the registrar's
# title abbreviations:
#   • "Special Topic(s)" / "Spec Top" / "Spec. Topics" / "Spec Topc"
#   • "Special Tpcs" / "Spec Tpc"  (Topics → Tpcs/Tpc abbreviation)
#   • "SpTp" / "Sp Tp" / "SpTp:"   (Special Topics initialism)
#   • a leading "ST" code: "ST:", "ST-", "ST/", "ST "
# Deliberately NOT matching bare "Topics in X" (mostly permanent courses) or
# titles that merely start with "St" (Statistics, Strategic, Studio…). The
# spec(ial) branch has no \w* gap so it can't span into "Specifications
# Topology"-type false positives.
_SPECIAL_TOPIC_RE = re.compile(
    r'spec(?:ial)?\.?\s*(?:top|tpc)|\bsp\.?\s*tp\b|^st\s*[:/\-]|^st\s+\S', re.I)


def is_special_topic(title):
    return bool(_SPECIAL_TOPIC_RE.search((title or '').strip()))


# Special-topics identification + per-topic offering counts come from the
# Registrar's "Historical Courses" section list, distilled by build_historical_st.py
# into data/historical_st.json:
#   • st_codes  — course codes ("SUBJECT NUMBER") whose catalog shell title is a
#     topics course (minus curated exclusions like SOCL 7003).
#   • counts    — {code: {normalized-topic: times-offered-through-Fall-2026}}.
# A section is special topics if its code is in st_codes OR its title carries an
# explicit ST marker (covers generic-titled shells run as ST); times_offered is
# the count for its normalized topic. Regenerate the JSON with build_historical_st.
import build_historical_st as _hist   # norm_topic() lives here (stdlib-only)

def _load_historical_st():
    p = os.path.join(HERE, 'data', 'historical_st.json')
    try:
        d = json.load(open(p))
        return set(d.get('st_codes', [])), d.get('counts', {}), d.get('crn_count', {})
    except Exception:
        return set(), {}, {}

_ST_CODES, _ST_COUNTS, _ST_CRN_COUNT = _load_historical_st()


def reload_historical_st():
    """Re-read historical_st.json into the module globals — call after
    fetch_historical.maybe_refresh() regenerates it mid-process."""
    global _ST_CODES, _ST_COUNTS, _ST_CRN_COUNT
    _ST_CODES, _ST_COUNTS, _ST_CRN_COUNT = _load_historical_st()


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
    # Always the Registrar site (Active Classes lives there); the PAT JSON's
    # `site` key points at a different site and must not be used here.
    body = json.dumps({'credentials': {
        'personalAccessTokenName': creds['token_name'],
        'personalAccessTokenSecret': creds['token_secret'],
        'site': {'contentUrl': SITE_NAME},
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


def download_csv(token, site_id, cv_name, out_path):
    """Download one custom view's CSV text, save it, return it."""
    cv_id = _find_custom_view(token, site_id, WORKBOOK, cv_name)
    url = f'{TABLEAU_HOST}/api/exp/sites/{site_id}/customviews/{cv_id}/data'
    status, raw = _http('GET', url, {'X-Tableau-Auth': token, 'Accept': '*/*'})
    if status != 200:
        raise RuntimeError(f'customview data HTTP {status}: {raw[:200]}')
    text = raw.decode('utf-8-sig', errors='replace')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(text)
    return text


# ---------------------------------------------------------------------------
# Parse + collapse to one row per CRN
# ---------------------------------------------------------------------------

def parse_sections(csv_text, term_label):
    """Collapse the row-per-(CRN×meeting/faculty) CSV into one dict per CRN,
    tagged with `term_label`. Each section gets id = "{term}|{crn}" (CRNs repeat
    across terms, so the term is part of the key)."""
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
            by_crn[crn] = _make_section(crn, row, term_label)
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


def _make_section(crn, row, term_label):
    subject = _clean(row.get('Subject Code'))
    number  = _clean(row.get('Course Number'))
    try:
        enrolled = int(float(_clean(row.get('Total Enrolled')) or 0))
    except ValueError:
        enrolled = 0
    sec = {
        'id': f'{term_label}|{crn}',
        'term': term_label,
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
        'special_topics': 'Yes' if (f'{subject} {number}' in _ST_CODES or is_special_topic(_clean(row.get('Class Title')))) else '',
        'times_offered': '',   # filled by the per-topic historical join below
        'class_term': _clean(row.get('Class Term')),
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
    """Pull every term in TERMS and return (sections, refresh_date).
    use_cache reads the last saved per-term CSVs (offline). A term whose custom
    view is empty/unset simply contributes 0 sections (logged), never an error."""
    token = site_id = None
    if not use_cache:
        token, site_id = _signin()
    all_sections, refresh = [], ''
    try:
        for t in TERMS:
            out = _raw_csv(t['label'])
            try:
                if use_cache:
                    if not os.path.exists(out):
                        print(f"  {t['label']}: no cached CSV — skipping")
                        continue
                    with open(out, encoding='utf-8') as f:
                        text = f.read()
                else:
                    text = download_csv(token, site_id, t['cv'], out)
                secs = parse_sections(text, t['label'])
                print(f"  {t['label']}: {len(secs)} sections")
                all_sections.extend(secs)
                if secs and not refresh:
                    refresh = secs[0]['refresh_date']
            except Exception as e:
                print(f"  {t['label']}: skipped ({e})")
        # Course-number propagation: a course number with ANY special-topics-
        # titled section is a special-topics shell (e.g. CS 7180), so every
        # section under it is a special topic — including ones titled with just
        # the topic name (e.g. "Applied Deep Learning") that the title test
        # can't see. Purely title-derived: the shell set comes from our own
        # flagged titles, not the summary sheet.
        st_codes = {(s['subject'], s['course_number']) for s in all_sections
                    if s.get('special_topics') == 'Yes'}
        prop = 0
        for s in all_sections:
            if s.get('special_topics') != 'Yes' and (s['subject'], s['course_number']) in st_codes:
                s['special_topics'] = 'Yes'
                prop += 1
        if prop:
            print(f"  special-topics propagation: +{prop} sections under {len(st_codes)} ST course numbers")
        # Times-offered: per-topic count from the Historical Courses list, run through
        # Fall 2026 and per TOPIC (one shell hosts many topics). Primary join is exact
        # by (term, CRN) — the section's own historical row, so it's immune to
        # ActiveClasses-vs-Historical title-wording differences; fall back to a
        # normalized-title match for the ~1% of CRNs not present in the historical file.
        hits = exact = 0
        for s in all_sections:
            if s.get('special_topics') != 'Yes':
                continue
            n = _ST_CRN_COUNT.get(f"{s['term']}|{s['crn']}")
            if n is not None:
                exact += 1
            else:
                topic = _hist.norm_topic(s['title'])
                n = _ST_COUNTS.get(s['course_code'], {}).get(topic) if topic else None
            if n is not None:
                s['times_offered'] = n
                hits += 1
        flagged = sum(1 for s in all_sections if s.get('special_topics') == 'Yes')
        print(f"  special topics: {flagged} flagged, {hits} with a times-offered count "
              f"({exact} exact by CRN, {hits - exact} by title) — "
              f"{len(_ST_CODES)} ST codes / {sum(len(v) for v in _ST_COUNTS.values())} topics on file")
    finally:
        if token:
            _signout(token)
    return all_sections, refresh


if __name__ == '__main__':
    import sys
    cache = '--cache' in sys.argv
    secs, refresh = fetch_and_parse(use_cache=cache)
    print(f'{len(secs)} sections total (refresh {refresh})')
    from collections import Counter
    print('by term:', dict(Counter(s['term'] for s in secs)))

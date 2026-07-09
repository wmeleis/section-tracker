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
    {'cv': 'Summer 2026', 'label': 'Summer 2026'},
]

# Terms that have aged out of the live "Active Classes" custom views (which only
# expose the current/upcoming roster) but that we still want listed. These are
# backfilled from the "Historical Courses" feed (data/historical_courses.csv) via
# sections_from_historical(). The historical feed is a THIN source — it carries
# term / course + section title / CRN / faculty / enrollment only, with NO
# instructional method, campus, schedule, etc. — so backfilled rows have those
# fields blank. College is derived by matching the subject code against the live
# terms' own subject->college mapping; Level is derived from the course number.
HISTORICAL_BACKFILL_TERMS = ['Spring 2026']

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
        return (set(d.get('st_codes', [])), d.get('offerings', {}),
                d.get('crn_topic', {}), d.get('course_titles', {}),
                d.get('topic_class', {}))
    except Exception:
        return set(), {}, {}, {}, {}

# _ST_OFFERINGS: topic_key -> [{term, rank, instructor, enrolled, title}] (most-recent-
# first, through Fall 2026). _ST_CRN_TOPIC: "term|crn" -> topic_key. _ST_COURSE_TITLES:
# course code -> catalog/shell Course Title (for special-topics shells). _ST_TOPIC_CLASS:
# topic_key -> 'Container shell' | 'Needs review' | 'Repeat topic' (shell classifier).
_ST_CODES, _ST_OFFERINGS, _ST_CRN_TOPIC, _ST_COURSE_TITLES, _ST_TOPIC_CLASS = _load_historical_st()


def reload_historical_st():
    """Re-read historical_st.json into the module globals — call after
    fetch_historical.maybe_refresh() regenerates it mid-process."""
    global _ST_CODES, _ST_OFFERINGS, _ST_CRN_TOPIC, _ST_COURSE_TITLES, _ST_TOPIC_CLASS
    _ST_CODES, _ST_OFFERINGS, _ST_CRN_TOPIC, _ST_COURSE_TITLES, _ST_TOPIC_CLASS = _load_historical_st()


HIST_CSV = os.path.join(HERE, 'data', 'historical_courses.csv')


def _subject_college_map(sections):
    """Majority college per subject code, learned from the live-fetched terms
    (the only source that carries Class College). A subject that maps to more than
    one college — a handful of stray cross-listings — takes its most common."""
    from collections import Counter, defaultdict
    tally = defaultdict(Counter)
    for s in sections:
        subj, col = (s.get('subject') or '').strip(), (s.get('college') or '').strip()
        if subj and col:
            tally[subj][col] += 1
    return {subj: c.most_common(1)[0][0] for subj, c in tally.items()}


def _level_from_number(number):
    """UG/GR from the course number (matches the Registrar 'Level' field exactly:
    <5000 -> UG, >=5000 -> GR). '' when the number has no digits."""
    digits = ''.join(ch for ch in str(number or '') if ch.isdigit())[:4]
    if not digits:
        return ''
    return 'GR' if int(digits) >= 5000 else 'UG'


def sections_from_historical(term_label, subj_college_map, csv_path=HIST_CSV):
    """Build section rows for an aged-out term from the Historical Courses feed,
    in the same schema as _make_section(). Rows are collapsed to one per CRN;
    college comes from subj_college_map, level from the course number. Fields the
    thin feed can't supply (instructional_method, campus, schedule, meeting_time,
    location, faculty_email/type/category, honors, attributes, description) stay ''."""
    if not os.path.exists(csv_path):
        return []
    by_crn = {}
    order = []
    with open(csv_path, encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            if _hist.canon_term((r.get('Course Term') or '').strip()) != term_label:
                continue
            crn = (r.get('CRN') or '').strip()
            subject = (r.get('Subject Code') or '').strip()
            if not crn or crn.lower() == 'all' or not subject:
                continue
            number = str(r.get('Course Number') or '').strip()
            if crn not in by_crn:
                code = f'{subject} {number}'.strip()
                title = (r.get('Section Title') or '').strip() or (r.get('Course Title') or '').strip()
                by_crn[crn] = {
                    'id': f'{term_label}|{crn}',
                    'term': term_label,
                    'crn': crn,
                    'subject': subject,
                    'course_number': number,
                    'course_code': code,
                    'section': '',
                    'title': title,
                    'college': subj_college_map.get(subject, ''),
                    'campus': '',
                    'instructional_method': '',
                    'level': _level_from_number(number),
                    'schedule': '',
                    'meeting_time': '',
                    'location': '',
                    'faculty_name': '',
                    'faculty_email': '',
                    'faculty_type': '',
                    'faculty_category': '',
                    'honors_ind': '',
                    'attributes': '',
                    'course_description': '',
                    'total_enrolled': 0,
                    'special_topics': 'Yes' if (code in _ST_CODES or is_special_topic(title)) else '',
                    'course_title': _ST_COURSE_TITLES.get(code, ''),
                    'times_offered': '',
                    'previous_offerings': '',
                    'topic_class': '',
                    'class_term': (r.get('Course Term') or '').strip(),
                    'refresh_date': (r.get('Refresh Date') or '').strip(),
                }
                order.append(crn)
            sec = by_crn[crn]
            fac = f"{(r.get('Faculty First Name') or '').strip()} {(r.get('Faculty Last Name') or '').strip()}".strip()
            if fac:
                have = [p.strip() for p in sec['faculty_name'].split(';') if p.strip()]
                if fac not in have:
                    have.append(fac)
                    sec['faculty_name'] = '; '.join(have)
            if (r.get('Measure Names') or '').strip().lower() == 'avg. enrolled':
                try:
                    e = int(round(float(r.get('Measure Values') or 0)))
                    if e > sec['total_enrolled']:
                        sec['total_enrolled'] = e
                except (ValueError, TypeError):
                    pass
    return [by_crn[c] for c in order]


def _topic_key_for(sec):
    """Resolve a section to its historical topic key: exact by (term, CRN), else a
    normalized-title match within the course code (for CRNs absent from the file)."""
    tk = _ST_CRN_TOPIC.get(f"{sec['term']}|{sec['crn']}")
    if tk:
        return tk
    topic = _hist.norm_topic(sec['title'])
    cand = f"{sec['course_code']}␟{topic}" if topic else None
    return cand if cand in _ST_OFFERINGS else None


_TITLE_NORM_RE = re.compile(r'[^a-z0-9]+')


def _norm_title(s):
    """Light title normalizer (case / punctuation / whitespace) for the direct
    'section title == course title' shell test — does NOT strip the ST prefix."""
    return _TITLE_NORM_RE.sub(' ', (s or '').lower()).strip()


def _is_title_only_shell(sec):
    """A section whose title is just the course's catalog (shell) title names no
    specific rotating topic -> container shell. Uses the section's own displayed
    title and its catalog course title (the two columns shown in the review list)."""
    ct = sec.get('course_title') or ''
    return bool(ct) and _norm_title(sec.get('title')) == _norm_title(ct)


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


def check():
    """Probe the Tableau PAT connection (sign in, then out). Returns (ok, detail)."""
    try:
        token, _ = _signin()
        _signout(token)
        return True, 'Tableau reachable (PAT valid)'
    except Exception as e:
        return False, f'{type(e).__name__}: {e}'


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
        'course_title': _ST_COURSE_TITLES.get(f'{subject} {number}', ''),  # catalog/shell name (ST); '' -> section title == course title
        'times_offered': '',        # filled by the per-topic historical join below
        'previous_offerings': '',   # JSON list of earlier offerings (term/instructor/enrolled)
        'topic_class': '',          # shell classifier: Container shell / Needs review / Repeat topic
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
        # Backfill aged-out terms (Spring 2026…) from the Historical Courses feed.
        # College is learned from the live terms' own subject->college mapping;
        # thin-feed fields (modality, campus, schedule…) stay blank. Done before
        # the ST propagation + times-offered join so these rows participate too.
        subj_college = _subject_college_map(all_sections)
        for term_label in HISTORICAL_BACKFILL_TERMS:
            hs = sections_from_historical(term_label, subj_college)
            if hs:
                with_college = sum(1 for s in hs if s['college'])
                print(f"  {term_label}: {len(hs)} sections (from Historical Courses; "
                      f"{with_college} with college, {len(hs) - with_college} blank)")
                all_sections.extend(hs)
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
        # Times-offered + previous-offerings, from the Historical Courses feed. Per TOPIC
        # (one shell hosts many topics). Join is exact by (term, CRN) — the section's own
        # historical row, immune to ActiveClasses-vs-Historical wording differences — with a
        # normalized-title fallback for CRNs absent from the file. Both metrics count by
        # DISTINCT PREVIOUS TERM (earlier than the section's own term), so concurrent
        # same-term sections don't inflate them: times_offered = number of previous terms;
        # previous_offerings = one row per previous term (instructors, total enrolled, #
        # sections), most-recent-first.
        matched = exact = 0
        for s in all_sections:
            if s.get('special_topics') != 'Yes':
                continue
            tk = _topic_key_for(s)
            if not tk:
                continue
            s['topic_class'] = _ST_TOPIC_CLASS.get(tk, '')
            # Direct rule: section title == course (catalog) title -> container shell,
            # overriding the historical classifier (which compares prefix-stripped
            # historical titles and can miss verbatim section==course echoes).
            if _is_title_only_shell(s):
                s['topic_class'] = 'Container shell'
            sec_rank = _hist.rank_int(s['term'])
            by_term = {}
            for o in _ST_OFFERINGS.get(tk, []):
                if o['rank'] >= sec_rank:
                    continue   # same-term (concurrent) or later — not a *previous* offering
                g = by_term.setdefault(o['term'], {'term': o['term'], 'rank': o['rank'],
                                                   'instr': set(), 'enrolled': 0, 'sections': 0, 'titles': set()})
                if o.get('instructor'):
                    g['instr'].add(o['instructor'])
                if isinstance(o.get('enrolled'), int):
                    g['enrolled'] += o['enrolled']
                if o.get('title'):
                    g['titles'].add(o['title'])
                g['sections'] += 1
            prev = sorted(by_term.values(), key=lambda g: g['rank'], reverse=True)
            s['times_offered'] = len(prev)
            if prev:
                s['previous_offerings'] = json.dumps(
                    [{'term': g['term'], 'title': ' · '.join(sorted(g['titles'])),
                      'instructor': '; '.join(sorted(g['instr'])),
                      'enrolled': g['enrolled'], 'sections': g['sections']} for g in prev],
                    separators=(',', ':'))
            matched += 1
            if f"{s['term']}|{s['crn']}" in _ST_CRN_TOPIC:
                exact += 1
        flagged = sum(1 for s in all_sections if s.get('special_topics') == 'Yes')
        print(f"  special topics: {flagged} flagged, {matched} matched to history "
              f"({exact} exact by CRN) — {len(_ST_CODES)} ST codes / {len(_ST_OFFERINGS)} topics on file")
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

"""
build_historical_st.py — special-topics identification + per-topic offering counts
from the Registrar's "Historical Courses" section list (data/historical_courses.csv).

This is the single source for both jobs (replaces the catalog web-scrape, the
Course-Inventory title scan, and the Registrar's Special-Topic-Summary dashboard):

  • WHICH courses are special topics  — a course code is ST if any of its section
    rows (through the cutoff term) has a *Course Title* (the catalog shell name)
    matching the topics regex, OR a *Section Title* carrying an explicit "ST:"
    marker. Codes in data/special_topics_exclusions.json are removed
    (e.g. SOCL 7003 doctoral proseminar). HONR 3300-3303 stay in.

  • HOW MANY times each topic was offered — within an ST course, group its rows by
    normalized *Section Title* (the specific rotating topic; falls back to Course
    Title when Section Title is blank) and count distinct (term, CRN). The count is
    per TOPIC, not per course number — one shell hosts many topics.

Counts run THROUGH the cutoff term (default Fall 2026) — future scheduled terms
(Spring 2027…) and the Tableau "All" rollup row are excluded.

Output: data/historical_st.json {st_codes, counts:{code:{topic_norm:count}}}.
fetch_active_classes loads this compact JSON at scan time (not the 53MB CSV).
"""
import os
import re
import csv
import json
import datetime
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, 'data', 'historical_courses.csv')
OUT_PATH = os.path.join(HERE, 'data', 'historical_st.json')
EXCL_PATH = os.path.join(HERE, 'data', 'special_topics_exclusions.json')

CUTOFF = ('Fall 2026', 2026, 3)   # include terms <= (year 2026, season Fall)

# shell-name signal (catalog Course Title): "Special Topics" / "Topics" / "Selected/Advanced Topics"
_COURSE_ST = re.compile(r'special\s+topic|\btopics?\b', re.I)
# section-title signal: an explicit ST marker (covers generic-titled shells run as ST)
_SECTION_ST = re.compile(r'special\s+topic|\btopics?\b|^st\s*[:/\-]', re.I)

_SEASON = {'winter': 0, 'spring': 1, 'summer': 2, 'fall': 3}


def _term_rank(term):
    """(year, season) for chronological ordering; None for 'All'/unparseable."""
    if not term:
        return None
    m = re.search(r'\b(19|20)\d{2}\b', term)
    if not m:
        return None
    yr = int(m.group(0))
    s = next((v for k, v in _SEASON.items() if k in term.lower()), None)
    if s is None:
        return None
    return (yr, s)


def _in_window(term):
    r = _term_rank(term)
    return r is not None and r <= (CUTOFF[1], CUTOFF[2])


_SEASON_NAME = {0: 'Winter', 1: 'Spring', 2: 'Summer', 3: 'Fall'}


def canon_term(term):
    """Historical term string ('Fall 2026 Semester', 'Summer Full 2026 Semester',
    'Fall 2026 CPS Quarter') -> the tracker's canonical label ('Fall 2026'), so the
    per-CRN join key matches the tracker's term labels."""
    r = _term_rank(term)
    return f'{_SEASON_NAME[r[1]]} {r[0]}' if r else None


def rank_int(term):
    """Chronological sort/compare key: year*10 + season (Winter<Spring<Summer<Fall)."""
    r = _term_rank(term)
    return r[0] * 10 + r[1] if r else 0


# leading course-type label ("ST" / "Special Topics" / "Topics" / "Selected/Advanced/Short
# Topics", incl. the Top/Tpc/Tpcs abbreviations + optional in/on/of) stripped so
# "ST: Ethics of War", "Spec Top: Ethics of War", and "Ethics of War" all group together.
_TOP = r'(?:top(?:ic)?s?|tpcs?)'
_TOPIC_PREFIX = re.compile(
    r'^\s*(?:special\s+' + _TOP + r'|spec\.?\s*' + _TOP + r'|sel(?:ected)?\.?\s*' + _TOP +
    r'|adv(?:anced)?\.?\s*' + _TOP + r'|short\s+' + _TOP + r'|' + _TOP +
    r'|sp\.?\s*tp|st)'
    r'\s*[:;,.\-–—]*\s*(?:\b(?:in|on|of)\b\s*)?', re.I)


def norm_topic(title):
    """Normalized per-topic grouping key."""
    t = (title or '').strip()
    t = _TOPIC_PREFIX.sub('', t, count=1)      # drop a leading ST/Topics label
    t = t.lower().replace('&', ' and ')
    t = re.sub(r'[^a-z0-9]+', ' ', t)           # punctuation -> space
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def _load_exclusions():
    try:
        return set(json.load(open(EXCL_PATH)).get('excluded', []))
    except Exception:
        return set()


def build(csv_path=CSV_PATH):
    excl = _load_exclusions()
    is_st = defaultdict(bool)                    # code -> bool
    seen = defaultdict(set)                      # (code, topic) -> {(term, crn)}
    meta = {}                                    # (code, topic, term, crn) -> {instr, enr, title}
    course_titles = {}                           # code -> catalog/shell Course Title (freshest)
    _ct_rank = {}
    rows = skipped = 0
    with open(csv_path, encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            term = (r.get('Course Term') or '').strip()
            if not _in_window(term):
                skipped += 1
                continue
            rows += 1
            code = f"{(r.get('Subject Code') or '').strip()} {str(r.get('Course Number') or '').strip()}".strip()
            if not code or code == ' ':
                continue
            ct = (r.get('Course Title') or '').strip()
            st = (r.get('Section Title') or '').strip()
            if not (_COURSE_ST.search(ct) or _SECTION_ST.search(st)):
                continue
            is_st[code] = True
            topic = norm_topic(st or ct)
            crn = (r.get('CRN') or '').strip()
            seen[(code, topic)].add((term, crn))
            m = meta.setdefault((code, topic, term, crn), {'instr': set(), 'enr': None, 'title': (st or ct)})
            fac = f"{(r.get('Faculty First Name') or '').strip()} {(r.get('Faculty Last Name') or '').strip()}".strip()
            if fac:
                m['instr'].add(fac)
            if (r.get('Measure Names') or '').strip().lower() == 'avg. enrolled':
                try:
                    m['enr'] = int(round(float(r.get('Measure Values') or 0)))
                except (ValueError, TypeError):
                    pass
            rk = rank_int(term)                        # keep the freshest Course (shell) title per code
            if ct and rk >= _ct_rank.get(code, -1):
                _ct_rank[code] = rk; course_titles[code] = ct

    st_codes = sorted(c for c, v in is_st.items() if v and c not in excl)
    st_set = set(st_codes)
    offerings = {}       # topic_key -> [{term, rank, instructor, enrolled}] most-recent-first
    crn_topic = {}       # "canon-term|crn" -> topic_key (exact per-section join)
    for (code, topic), crns in seen.items():
        # Skip the empty-topic bucket: rows with a blank Section Title (~28%) can't be
        # attributed to a specific topic; a tracker section always has a real title.
        if code not in st_set or not topic:
            continue
        tk = f'{code}␟{topic}'
        lst = []
        for term, crn in crns:
            m = meta.get((code, topic, term, crn), {})
            lst.append({'term': term, 'rank': rank_int(term),
                        'instructor': '; '.join(sorted(m.get('instr') or [])),
                        'enrolled': m.get('enr'), 'title': m.get('title') or ''})
            if crn:
                crn_topic[f'{canon_term(term)}|{crn}'] = tk
        lst.sort(key=lambda o: o['rank'], reverse=True)
        offerings[tk] = lst

    out = {
        'generated': datetime.datetime.now().isoformat(timespec='seconds'),
        'source': 'historical_courses.csv',
        'cutoff_term': CUTOFF[0],
        'rows_in_window': rows,
        'rows_excluded_out_of_window': skipped,
        'st_codes': st_codes,
        'excluded_codes': sorted(excl),
        'offerings': offerings,
        'crn_topic': crn_topic,
        'course_titles': course_titles,
    }
    json.dump(out, open(OUT_PATH, 'w'), indent=1)
    return out


if __name__ == '__main__':
    out = build()
    offs = out['offerings']
    total_offerings = sum(len(v) for v in offs.values())
    print(f"in-window rows: {out['rows_in_window']:,}  (excluded out-of-window: {out['rows_excluded_out_of_window']:,})")
    print(f"ST course codes: {len(out['st_codes'])}   distinct topics: {len(offs):,}   offering records: {total_offerings:,}")
    print(f"excluded: {out['excluded_codes']}")
    print(f"-> {OUT_PATH}")
    # sanity: one well-known topic's full offering list
    probe = next((k for k in offs if k.startswith('INFO 7374␟')), None)
    if probe:
        print(f'\n{probe.replace("␟", " · ")} ({len(offs[probe])}x):')
        for o in offs[probe][:6]:
            print(f"   {o['term']:24s} {o['instructor'][:28]:28s} enr={o['enrolled']}")

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
    per-CRN count key matches the tracker's term labels."""
    r = _term_rank(term)
    return f'{_SEASON_NAME[r[1]]} {r[0]}' if r else None


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
    seen = defaultdict(set)                      # (code, topic_norm) -> {(term, crn)}
    topic_label = {}                             # (code, topic_norm) -> a display label
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
            row_is_st = bool(_COURSE_ST.search(ct)) or bool(_SECTION_ST.search(st))
            if row_is_st:
                is_st[code] = True
                topic_raw = st or ct
                key = (code, norm_topic(topic_raw))
                seen[key].add((term, (r.get('CRN') or '').strip()))
                topic_label.setdefault(key, topic_raw)

    st_codes = sorted(c for c, v in is_st.items() if v and c not in excl)
    st_set = set(st_codes)
    counts = defaultdict(dict)
    crn_count = {}   # "term|crn" -> its topic's total count (primary, exact join key)
    for (code, topic), crns in seen.items():
        # Skip the empty-topic bucket: rows with a blank Section Title (~28%) can't
        # be attributed to a specific topic, so they'd wrongly merge unrelated
        # offerings. A tracker section always has a real title, so it never needs it.
        if code in st_set and topic:
            n = len(crns)
            counts[code][topic] = n
            for term, crn in crns:
                if crn:
                    crn_count[f'{canon_term(term)}|{crn}'] = n

    out = {
        'generated': datetime.datetime.now().isoformat(timespec='seconds'),
        'source': 'historical_courses.csv',
        'cutoff_term': CUTOFF[0],
        'rows_in_window': rows,
        'rows_excluded_out_of_window': skipped,
        'st_codes': st_codes,
        'excluded_codes': sorted(excl),
        'counts': {k: counts[k] for k in sorted(counts)},
        'crn_count': crn_count,
    }
    json.dump(out, open(OUT_PATH, 'w'), indent=1)
    return out, topic_label


if __name__ == '__main__':
    out, labels = build()
    nc = out['counts']
    total_topics = sum(len(v) for v in nc.values())
    print(f"in-window rows: {out['rows_in_window']:,}  (excluded out-of-window: {out['rows_excluded_out_of_window']:,})")
    print(f"ST course codes: {len(out['st_codes'])}   distinct topics: {total_topics:,}")
    print(f"excluded: {out['excluded_codes']}")
    print(f"-> {OUT_PATH}")
    # sanity: busiest shells + a couple of well-known topics
    busiest = sorted(nc.items(), key=lambda kv: -sum(kv[1].values()))[:6]
    print('\nbusiest ST shells (total offerings, distinct topics):')
    for code, tops in busiest:
        print(f"   {code:12s} {sum(tops.values()):>4} offerings across {len(tops):>3} topics")
    # show INFO 7374 top topics
    for probe in ('INFO 7374', 'ALY 6983', 'CS 7180'):
        tops = sorted(nc.get(probe, {}).items(), key=lambda kv: -kv[1])[:5]
        if tops:
            print(f'\n{probe} top topics:')
            for t, n in tops:
                print(f'   {n:>3}x  {t}')

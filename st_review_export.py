"""st_review_export.py — special-topics policy review list -> data/reports/.

Buckets every special topic offered in the current academic year (Spring/Summer/Fall
2026) with 2+ prior terms into Container shell / Needs review / Repeat topic (the shell
classifier in build_historical_st.classify_topic), with the evidence for each row so the
exclusions can be audited before they're trusted. Run: python3 st_review_export.py

Output stays in the project data store (data/reports/, gitignored), not ~/Downloads —
see CLAUDE.md → project data & documentation organization.
"""
import os
import csv
import json
import datetime
from collections import defaultdict
import database as db
import fetch_active_classes as fa

CUR_TERMS = {'Spring 2026', 'Summer 2026', 'Fall 2026'}
_CLASS_ORDER = {'Container shell': 0, 'Needs review': 1, 'Repeat topic': 2}
_TERM_ORDER = {'Spring 2026': 0, 'Summer 2026': 1, 'Fall 2026': 2}


def main():
    hist = json.load(open(os.path.join(fa.HERE, 'data', 'historical_st.json')))
    CLASS = hist.get('topic_class', {})
    REASON = hist.get('topic_class_reason', {})
    OFF = hist.get('offerings', {})
    CT = hist.get('course_titles', {})   # course code -> catalog/shell title (shows it's ST)

    # One row per distinct topic in the current-AY 2+-prior-terms set (matches the view).
    # Track which current-AY term(s) each topic runs in (a topic can span >1 term).
    seen = {}
    terms_by_tk = defaultdict(set)
    for s in db.get_all_sections():
        if s['term'] not in CUR_TERMS or s.get('special_topics') != 'Yes':
            continue
        if int(s.get('times_offered') or 0) < 2:
            continue
        tk = fa._topic_key_for(s)
        if not tk:
            continue
        terms_by_tk[tk].add(s['term'])
        if tk not in seen:
            seen[tk] = s

    out = []
    for tk, s in seen.items():
        n = int(s['times_offered'])
        offs = OFF.get(tk, [])
        ctitle = CT.get(s['course_code'], '') or s.get('course_title', '')
        cls = s.get('topic_class', '') or CLASS.get(tk, '')   # section value carries the title-match override
        why = ('section title matches the course title'
               if fa._is_title_only_shell(s) else REASON.get(tk, ''))
        current_terms = '; '.join(sorted(terms_by_tk[tk], key=lambda t: _TERM_ORDER.get(t, 9)))
        out.append({
            'topic_class': cls,
            'current_terms': current_terms,   # which of Spring/Summer/Fall 2026 it runs in
            'offering_number': n + 1,          # this Spring/Summer/Fall 2026 run is the Nth
            'prior_terms': n,                  # distinct terms it ran before its own term
            'course': s['course_code'],
            'course_title': ctitle,
            'topic_title': s['title'],
            'college': s.get('college', ''),
            'most_recent_prior_instructor': offs[0]['instructor'] if offs else '',
            'why_classified': why,
        })
    # Container shells are NOT violations (a recurring container whose title names no
    # specific rotating topic) — drop them from the list. What remains is the review
    # queue: genuine Repeat topics + the ambiguous Needs-review middle.
    shells = [r for r in out if r['topic_class'] == 'Container shell']
    kept = [r for r in out if r['topic_class'] != 'Container shell']
    kept.sort(key=lambda r: (-r['offering_number'], r['course']))  # worst repeat offenders first

    reports_dir = os.path.join(fa.HERE, 'data', 'reports')
    os.makedirs(reports_dir, exist_ok=True)
    path = os.path.join(reports_dir, 'special_topics_review_%s.csv' % datetime.date.today())
    cols = ['topic_class', 'current_terms', 'offering_number', 'prior_terms', 'course',
            'course_title', 'topic_title', 'college', 'most_recent_prior_instructor',
            'why_classified']
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(kept)

    from collections import Counter
    dist = Counter(r['topic_class'] for r in kept)
    print(f'wrote {len(kept)} topics -> {path}')
    print('  ' + ', '.join(f'{k}: {v}' for k, v in sorted(dist.items())))
    print(f'  (excluded {len(shells)} container shells)')


if __name__ == '__main__':
    main()

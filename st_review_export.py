"""st_review_export.py — special-topics policy review list -> ~/Downloads.

Buckets every special topic offered in the current academic year (Spring/Summer/Fall
2026) with 2+ prior terms into Container shell / Needs review / Repeat topic (the shell
classifier in build_historical_st.classify_topic), with the evidence for each row so the
exclusions can be audited before they're trusted. Run: python3 st_review_export.py
"""
import os
import csv
import json
import datetime
import database as db
import fetch_active_classes as fa

CUR_TERMS = {'Spring 2026', 'Summer 2026', 'Fall 2026'}
_CLASS_ORDER = {'Container shell': 0, 'Needs review': 1, 'Repeat topic': 2}


def main():
    hist = json.load(open(os.path.join(fa.HERE, 'data', 'historical_st.json')))
    CLASS = hist.get('topic_class', {})
    REASON = hist.get('topic_class_reason', {})
    OFF = hist.get('offerings', {})
    CT = hist.get('course_titles', {})   # course code -> catalog/shell title (shows it's ST)

    # One row per distinct topic in the current-AY 2+-prior-terms set (matches the view).
    seen = {}
    for s in db.get_all_sections():
        if s['term'] not in CUR_TERMS or s.get('special_topics') != 'Yes':
            continue
        if int(s.get('times_offered') or 0) < 2:
            continue
        tk = fa._topic_key_for(s)
        if not tk or tk in seen:
            continue
        seen[tk] = s

    out = []
    for tk, s in seen.items():
        n = int(s['times_offered'])
        offs = OFF.get(tk, [])
        ctitle = CT.get(s['course_code'], '') or s.get('course_title', '')
        cls = s.get('topic_class', '') or CLASS.get(tk, '')   # section value carries the title-match override
        why = ('section title matches the course title'
               if fa._is_title_only_shell(s) else REASON.get(tk, ''))
        out.append({
            'topic_class': cls,
            'offering_number': n + 1,          # this Spring/Summer/Fall 2026 run is the Nth
            'prior_terms': n,                  # distinct terms it ran before its own term
            'course': s['course_code'],
            'course_title': ctitle,
            'topic_title': s['title'],
            'college': s.get('college', ''),
            'most_recent_prior_instructor': offs[0]['instructor'] if offs else '',
            'why_classified': why,
        })
    out.sort(key=lambda r: (_CLASS_ORDER.get(r['topic_class'], 9), -r['offering_number']))

    path = os.path.expanduser(
        '~/Downloads/special_topics_review_%s.csv' % datetime.date.today())
    cols = ['topic_class', 'offering_number', 'prior_terms', 'course', 'course_title',
            'topic_title', 'college', 'most_recent_prior_instructor', 'why_classified']
    with open(path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(out)

    from collections import Counter
    dist = Counter(r['topic_class'] for r in out)
    print(f'wrote {len(out)} topics -> {path}')
    print('  ' + ', '.join(f'{k}: {v}' for k, v in sorted(dist.items())))


if __name__ == '__main__':
    main()

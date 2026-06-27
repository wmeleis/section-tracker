"""
fetch_special_topics.py — "times offered" counts for special-topics courses.

Source: the Registrar's "Special Topic Summary" Tableau view, which the REST
`/views/{id}/data` endpoint returns directly (no custom view / filter gating).
It's a long-format table — one row per (Course, Measure):

    Course                              Measure Names              Measure Values
    ALY 6983 ST: Python for Data Sci    Total Number of Sections   3
    ALY 6983 ST: Python for Data Sci    Average Enrollment         12.5

"Course" = "<Subject> <Number> <Title>", keyed PER TOPIC (the same shell number
hosts several topics with different counts). We keep only "Total Number of
Sections" → the times-offered count, mapped by a normalized course key so it can
be joined onto section rows (subject + number + title). Term-agnostic (a
cumulative historical count), so it's pulled once per refresh.
"""
import os
import re
import csv
import io

import fetch_active_classes as fac   # reuse the Tableau REST helpers

HERE = os.path.dirname(os.path.abspath(__file__))
VIEW_ID = 'a4fb77ef-cee7-4fdc-8402-81f4c7f8de87'   # Special Topic Summary (Registrar)
RAW_CSV = os.path.join(HERE, 'data', 'special_topics_summary.csv')


def norm_key(s):
    """Normalized join key: lowercase, collapse whitespace."""
    return re.sub(r'\s+', ' ', (s or '').strip()).lower()


def section_key(subject, number, title):
    return norm_key(f'{subject} {number} {title}')


def download_csv(token, site_id):
    url = f'{fac.TABLEAU_HOST}/api/{fac.API_VERSION}/sites/{site_id}/views/{VIEW_ID}/data'
    status, raw = fac._http('GET', url, {'X-Tableau-Auth': token, 'Accept': '*/*'})
    if status != 200:
        raise RuntimeError(f'special-topics data HTTP {status}: {raw[:200]}')
    text = raw.decode('utf-8-sig', errors='replace')
    os.makedirs(os.path.dirname(RAW_CSV), exist_ok=True)
    with open(RAW_CSV, 'w', encoding='utf-8') as f:
        f.write(text)
    return text


def parse_times_offered(csv_text):
    """Return {normalized "subject number title" -> times_offered:int}."""
    out = {}
    for row in csv.DictReader(io.StringIO(csv_text)):
        if (row.get('Measure Names') or '').strip() != 'Total Number of Sections':
            continue
        course = (row.get('Course') or '').strip()
        if not course:
            continue
        try:
            out[norm_key(course)] = int(float(row.get('Measure Values') or 0))
        except ValueError:
            pass
    return out


def fetch_times_offered(token=None, site_id=None, use_cache=False):
    """Return the {course-key -> times_offered} map. Reuses a caller's signed-in
    token/site_id when given; otherwise signs in itself."""
    if use_cache and os.path.exists(RAW_CSV):
        with open(RAW_CSV, encoding='utf-8') as f:
            return parse_times_offered(f.read())
    own = token is None
    if own:
        token, site_id = fac._signin()
    try:
        return parse_times_offered(download_csv(token, site_id))
    finally:
        if own:
            fac._signout(token)


if __name__ == '__main__':
    import sys
    m = fetch_times_offered(use_cache='--cache' in sys.argv)
    print(f'{len(m)} special-topic courses')
    for k in list(m)[:5]:
        print('  ', k, '->', m[k])

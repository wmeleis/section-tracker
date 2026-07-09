"""
database.py — SQLite layer for the Fall 2026 Section Tracker.

One table, `sections`, keyed by CRN. Section facts come from Tableau and are
fully replaced on each fetch. Editable fields (notes, Modality Resolved) live in
the notes store (Airtable / local JSON) — NOT here — so a re-fetch never clobbers
human input.
"""
import os
import sqlite3
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, 'data', 'sections.db')

SECTION_COLUMNS = [
    'id', 'term', 'crn', 'subject', 'course_number', 'course_code', 'section',
    'title', 'college', 'campus', 'instructional_method', 'level', 'schedule',
    'meeting_time', 'location', 'faculty_name', 'faculty_email', 'faculty_type',
    'faculty_category', 'honors_ind', 'attributes', 'course_description',
    'total_enrolled', 'special_topics', 'course_title', 'times_offered', 'previous_offerings',
    'class_term', 'refresh_date',
]


def _conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL')
    return c


def init_db():
    c = _conn()
    _int_cols = {'total_enrolled', 'times_offered'}
    cols = ',\n  '.join(f'{name} INTEGER' if name in _int_cols else f'{name} TEXT'
                        for name in SECTION_COLUMNS)
    c.execute(f'''CREATE TABLE IF NOT EXISTS sections (
  {cols},
  fetched_at TEXT,
  PRIMARY KEY (id)
)''')
    c.execute('''CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)''')
    # Self-healing migration: add any SECTION_COLUMNS missing from an older table.
    have = {r[1] for r in c.execute('PRAGMA table_info(sections)').fetchall()}
    for name in SECTION_COLUMNS:
        if name not in have:
            c.execute(f'ALTER TABLE sections ADD COLUMN {name} '
                      f'{"INTEGER" if name in _int_cols else "TEXT"}')
    c.commit()
    c.close()


def replace_all_sections(sections, protect_empty_terms=True):
    """Replace the section set in one transaction.

    Keep-last-good: if a term that currently HAS rows comes back with ZERO rows in
    this pull (intermittent-empty Tableau response, or an aged-out source), its
    existing rows are preserved rather than wiped — this protects the active term
    (Fall) from a single bad pull. A term that already had no rows stays empty (so
    a genuinely dropped term like Spring 2026 doesn't get resurrected)."""
    init_db()
    now = datetime.datetime.now().isoformat(timespec='seconds')
    c = _conn()
    try:
        preserved = []
        if protect_empty_terms:
            fresh_terms = {s.get('term') for s in sections if s.get('term')}
            existing = [r['term'] for r in c.execute(
                "SELECT term FROM sections WHERE term IS NOT NULL AND term!='' "
                "GROUP BY term HAVING COUNT(*) > 0")]
            gone = sorted(t for t in existing if t not in fresh_terms)
            if gone:
                q = ','.join('?' for _ in gone)
                preserved = [dict(r) for r in
                             c.execute(f'SELECT * FROM sections WHERE term IN ({q})', gone)]
                print(f"[keep-last-good] {gone} returned 0 rows this pull — "
                      f"preserving {len(preserved)} existing rows (not wiping)")
        c.execute('DELETE FROM sections')
        cols = SECTION_COLUMNS + ['fetched_at']
        placeholders = ','.join(['?'] * len(cols))
        rows = [tuple(s.get(k, '') for k in SECTION_COLUMNS) + (now,) for s in sections]
        rows += [tuple(p.get(k, '') for k in SECTION_COLUMNS) + (p.get('fetched_at') or now,)
                 for p in preserved]
        c.executemany(f"INSERT INTO sections ({','.join(cols)}) VALUES ({placeholders})", rows)
        total = len(sections) + len(preserved)
        set_meta('last_fetch', now, c)
        set_meta('section_count', str(total), c)
        if sections:
            set_meta('refresh_date', sections[0].get('refresh_date', ''), c)
        c.commit()
    finally:
        c.close()
    return total


def get_all_sections():
    init_db()
    c = _conn()
    try:
        rows = c.execute('SELECT * FROM sections ORDER BY term, subject, course_number, section').fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()


def set_meta(key, value, conn=None):
    own = conn is None
    c = conn or _conn()
    c.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
              (key, value))
    if own:
        c.commit()
        c.close()


def get_meta(key, default=''):
    init_db()
    c = _conn()
    try:
        r = c.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return r['value'] if r else default
    finally:
        c.close()


# Batch inputs whose staleness the dashboard banner watches. Airtable notes are
# read LIVE (no batch step), so they're not a staleness source.
STALE_SOURCE_DAYS = 3


def _iso_local(s):
    """Attach the local TZ offset to a naive local ISO timestamp so a browser in
    any timezone parses the correct absolute instant."""
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s).astimezone().isoformat()
    except (ValueError, TypeError):
        return s


def source_health():
    """Last-successful-read timestamp per batch input, for the staleness banner.
    Baked into the payload (works on both the local app and the shared static site);
    the client compares each to 'now' and warns past STALE_SOURCE_DAYS."""
    hist = None
    hp = os.path.join(HERE, 'data', 'last_historical_fetch')
    try:
        with open(hp) as f:
            hist = _iso_local(f.read().strip())
    except OSError:
        try:
            hist = _iso_local(datetime.datetime.fromtimestamp(os.path.getmtime(hp)).isoformat())
        except OSError:
            hist = None
    return {
        'stale_days': STALE_SOURCE_DAYS,
        'sources': [
            {'name': 'Section roster (Active Classes)', 'last_success': _iso_local(get_meta('last_fetch'))},
            {'name': 'Historical Courses (special topics)', 'last_success': hist},
        ],
    }

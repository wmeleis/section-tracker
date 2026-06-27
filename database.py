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
    'total_enrolled', 'special_topics', 'times_offered', 'class_term', 'refresh_date',
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
    c.commit()
    c.close()


def replace_all_sections(sections):
    """DELETE + INSERT the whole section set in one transaction."""
    init_db()
    now = datetime.datetime.now().isoformat(timespec='seconds')
    c = _conn()
    try:
        c.execute('DELETE FROM sections')
        placeholders = ','.join(['?'] * (len(SECTION_COLUMNS) + 1))
        cols = ','.join(SECTION_COLUMNS + ['fetched_at'])
        rows = [tuple(s.get(k, '') for k in SECTION_COLUMNS) + (now,) for s in sections]
        c.executemany(f'INSERT INTO sections ({cols}) VALUES ({placeholders})', rows)
        set_meta('last_fetch', now, c)
        set_meta('section_count', str(len(sections)), c)
        if sections:
            set_meta('refresh_date', sections[0].get('refresh_date', ''), c)
        c.commit()
    finally:
        c.close()
    return len(sections)


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

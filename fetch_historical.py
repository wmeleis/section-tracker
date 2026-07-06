"""
fetch_historical.py — daily refresh of the Registrar's "Historical Courses" section
list, the single source for special-topics identification + per-topic offering counts.

Pulls the "Courses with Faculty Name" Tableau view (workbook HistoricalCourses) via a
plain REST data export (no custom view needed — the full ~509k-row table comes back
directly), saves it to data/historical_courses.csv, then regenerates
data/historical_st.json via build_historical_st.

Keep-last-good: the download is validated (looks like the expected CSV, plausible size)
before it replaces the existing file, and data/historical_st.json is only rebuilt on a
good download — so a logged-out session or a truncated pull never wipes the counts.
Gated to once per `max_age_hours` (default 20h, so a daily job always refreshes but a
rapid manual re-run skips the 53 MB download).
"""
import os
import datetime

import fetch_active_classes as fac   # reuse Tableau REST helpers (_signin/_http/_signout)
import build_historical_st

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(HERE, 'data', 'historical_courses.csv')
STAMP_PATH = os.path.join(HERE, 'data', 'last_historical_fetch')
VIEW_ID = 'aaaece8a-b675-45a7-a0e4-d61f010b4aaa'   # HistoricalCourses / Courses with Faculty Name

_MIN_BYTES = 5_000_000          # full file is ~53 MB; anything tiny is a login/error page
_REQUIRED_COLS = ('Course Term', 'Section Title', 'Subject Code', 'CRN')


def _validate(text):
    if not text or text.lstrip()[:1] == '<':
        raise RuntimeError('response is HTML (login/redirect), not CSV')
    if len(text) < _MIN_BYTES:
        raise RuntimeError(f'response too small ({len(text)} bytes) — likely gated/empty')
    header = text.split('\n', 1)[0]
    missing = [c for c in _REQUIRED_COLS if c not in header]
    if missing:
        raise RuntimeError(f'missing expected columns {missing}')


def pull(token, site_id):
    """Download + validate the view; overwrite CSV_PATH only if valid. Returns row count."""
    url = f'{fac.TABLEAU_HOST}/api/{fac.API_VERSION}/sites/{site_id}/views/{VIEW_ID}/data'
    status, raw = fac._http('GET', url, {'X-Tableau-Auth': token, 'Accept': '*/*'}, timeout=600)
    if status != 200:
        raise RuntimeError(f'historical data HTTP {status}: {raw[:200]}')
    text = raw.decode('utf-8-sig', errors='replace')
    _validate(text)
    os.makedirs(os.path.dirname(CSV_PATH), exist_ok=True)
    tmp = CSV_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, CSV_PATH)   # atomic swap only after a validated write
    return text.count('\n')


def _age_hours():
    try:
        return (datetime.datetime.now().timestamp() - os.path.getmtime(STAMP_PATH)) / 3600
    except OSError:
        return float('inf')


def maybe_refresh(max_age_hours=20, token=None, site_id=None, force=False):
    """Refresh the historical CSV + rebuild historical_st.json if stale. Best-effort:
    returns True if refreshed, False if skipped (fresh). Raises only on a hard failure
    the caller should log; the existing files are left intact on any error."""
    if not force and _age_hours() < max_age_hours:
        return False
    own = token is None
    if own:
        token, site_id = fac._signin()
    try:
        rows = pull(token, site_id)
        out = build_historical_st.build()[0]
        with open(STAMP_PATH, 'w') as f:
            f.write(datetime.datetime.now().isoformat(timespec='seconds'))
        print(f'  historical refresh: {rows:,} rows -> {len(out["st_codes"])} ST codes, '
              f'{sum(len(v) for v in out["counts"].values())} topics')
        return True
    finally:
        if own:
            fac._signout(token)


if __name__ == '__main__':
    import sys
    refreshed = maybe_refresh(force='--force' in sys.argv)
    print('refreshed' if refreshed else 'skipped (fresh)')

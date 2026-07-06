"""
run_update.py — one full refresh cycle, used by the daily launchd job and the
local "Update data" button path.

  0. Refresh the Historical Courses feed (daily) -> rebuild the special-topics
     identification + per-topic offering-count lookup (historical_st.json).
  1. Pull the Fall 2026 custom view from Tableau (PAT, no browser).
  2. Replace the sections table.
  3. Rebuild the encrypted static site (docs/).
  4. Force-push docs/ to gh-pages.

Notes + Modality Resolved live in Airtable and are read live by the site, so
they are never touched here.
"""
import sys
import datetime

import fetch_active_classes as fetch
import fetch_historical
import database as db
import export_static
import deploy


def main(skip_deploy=False):
    t0 = datetime.datetime.now()
    print(f'[{t0:%Y-%m-%d %H:%M}] section update starting')
    # Daily historical refresh (best-effort; keeps last-good on any failure).
    try:
        if fetch_historical.maybe_refresh():
            fetch.reload_historical_st()
    except Exception as e:
        print(f'  historical refresh skipped: {type(e).__name__}: {e}')
    sections, refresh = fetch.fetch_and_parse(use_cache=False)
    n = db.replace_all_sections(sections)
    print(f'  pulled + stored {n} sections (registrar refresh {refresh})')
    export_static.build()
    if not skip_deploy:
        deploy.publish_pages()
    print(f'  done in {(datetime.datetime.now()-t0).seconds}s')
    return n


if __name__ == '__main__':
    main(skip_deploy='--no-deploy' in sys.argv)

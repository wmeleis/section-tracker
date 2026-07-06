"""
app.py — Flask server for the Fall 2026 Section Tracker (local/admin).

Endpoints:
  GET  /                      dashboard (admin build — Modality Resolved editable)
  GET  /api/sections          sections merged with the notes/resolved overlay
  GET  /api/status            last fetch time, count, refresh date, store info
  POST /api/connect           re-pull from Tableau (the "connection button")
  POST /api/section/<crn>/note      {notes}     -> notes store (colleges)
  POST /api/section/<crn>/resolved  {resolved}  -> notes store (owner only)

Run:  PYTHONUNBUFFERED=1 python3 app.py
"""
import os
import json
import threading
import datetime
from flask import Flask, jsonify, request, render_template, send_from_directory
from flask_cors import CORS

import database as db
import notes_store
import fetch_active_classes as fetch

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, 'data')
SECTION_VIEWS_PATH = os.path.join(DATA_DIR, 'section_views.json')
app = Flask(__name__, template_folder='templates', static_folder='static')
CORS(app, resources={r'/api/*': {'origins': '*'}})

_connect_state = {'running': False, 'ok': None, 'error': '', 'finished': '', 'count': 0}
_lock = threading.Lock()


def _load_team_views():
    try:
        with open(SECTION_VIEWS_PATH) as f:
            data = json.load(f)
        return data.get('views', []) if isinstance(data, dict) else (data or [])
    except Exception:
        return []


def _save_team_views(views):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(SECTION_VIEWS_PATH, 'w') as f:
        json.dump({'views': views}, f, indent=2)


def merged_sections():
    sections = db.get_all_sections()
    notes = notes_store.get_all_notes()
    for s in sections:
        n = notes.get(s['id'], {})  # id = "{term}|{crn}"
        s['notes'] = n.get('notes', '')
        s['modality_resolved'] = bool(n.get('modality_resolved', False))
        s['updated_by'] = n.get('updated_by', '')
    return sections


def do_connect():
    with _lock:
        _connect_state.update(running=True, ok=None, error='')
    try:
        # Daily historical refresh (gated ~20h) -> rebuild the special-topics
        # identification + per-topic count lookup. Best-effort; keeps last-good.
        try:
            import fetch_historical
            if fetch_historical.maybe_refresh():
                fetch.reload_historical_st()
        except Exception as he:
            print('historical refresh skipped:', he)
        sections, refresh = fetch.fetch_and_parse(use_cache=False)
        n = db.replace_all_sections(sections)
        # rebuild + publish the shared site (best-effort; never fails the pull)
        try:
            import export_static, deploy
            export_static.build()
            deploy.publish_pages()
        except Exception as pe:
            print('publish skipped:', pe)
        _connect_state.update(ok=True, count=n,
                              finished=datetime.datetime.now().isoformat(timespec='seconds'))
    except Exception as e:
        _connect_state.update(ok=False, error=f'{type(e).__name__}: {e}')
    finally:
        _connect_state.update(running=False)


@app.route('/')
def dashboard():
    return render_template('dashboard.html', is_admin=True)


@app.route('/api/sections')
def api_sections():
    return jsonify({
        'sections': merged_sections(),
        'last_fetch': db.get_meta('last_fetch'),
        'refresh_date': db.get_meta('refresh_date'),
        'is_admin': True,
        'airtable': notes_store.airtable_available(),
    })


@app.route('/api/status')
def api_status():
    return jsonify({
        'running': _connect_state['running'],
        'ok': _connect_state['ok'],
        'error': _connect_state['error'],
        'finished': _connect_state['finished'],
        'count': db.get_meta('section_count'),
        'last_fetch': db.get_meta('last_fetch'),
        'refresh_date': db.get_meta('refresh_date'),
        'airtable': notes_store.airtable_available(force=True),
    })


@app.route('/api/connect', methods=['POST'])
def api_connect():
    if _connect_state['running']:
        return jsonify({'started': False, 'reason': 'already running'}), 409
    threading.Thread(target=do_connect, daemon=True).start()
    return jsonify({'started': True})


@app.route('/api/console')
def api_console():
    """Data-status snapshot for the Console modal: last pull, registrar refresh,
    total + per-term section counts, notes store availability, and the most
    recent update (connect) result."""
    sections = db.get_all_sections()
    per_term = {}
    for s in sections:
        t = s.get('term', '') or '(none)'
        per_term[t] = per_term.get(t, 0) + 1
    try:
        notes_count = len(notes_store.get_all_notes())
    except Exception:
        notes_count = 0
    return jsonify({
        'last_fetch': db.get_meta('last_fetch'),
        'refresh_date': db.get_meta('refresh_date'),
        'section_count': len(sections),
        'per_term': per_term,
        'airtable': notes_store.airtable_available(),
        'notes_count': notes_count,
        'connect': {
            'running': _connect_state['running'],
            'ok': _connect_state['ok'],
            'error': _connect_state['error'],
            'finished': _connect_state['finished'],
            'count': _connect_state['count'],
        },
    })


@app.route('/api/views', methods=['GET', 'POST'])
def api_views():
    """Shared (team) section views, persisted to data/section_views.json.

    GET  -> [...]  (the array of team views)
    POST -> body is the client's full list of team views; the server replaces
            its stored list with it (mirrors the program tracker's full-replace
            contract). An empty list is accepted (clears team views)."""
    if request.method == 'GET':
        return jsonify(_load_team_views())
    views = request.get_json(force=True)
    if not isinstance(views, list):
        return jsonify({'error': 'body must be a JSON array of views'}), 400
    try:
        _save_team_views(views)
    except Exception as e:
        return jsonify({'error': f'save failed: {e}'}), 500
    return jsonify({'ok': True, 'views': views})


@app.route('/api/section/<crn>/note', methods=['POST'])
def api_note(crn):
    body = request.get_json(force=True) or {}
    res = notes_store.set_note(
        crn, body.get('term', ''), body.get('notes', ''), updated_by=body.get('updated_by', ''),
        course=body.get('course', ''), college=body.get('college', ''))
    return jsonify(res)


@app.route('/api/section/<crn>/resolved', methods=['POST'])
def api_resolved(crn):
    body = request.get_json(force=True) or {}
    res = notes_store.set_resolved(
        crn, body.get('term', ''), bool(body.get('resolved')), updated_by=body.get('updated_by', 'owner'),
        course=body.get('course', ''), college=body.get('college', ''))
    return jsonify(res)


@app.route('/static/<path:p>')
def _static(p):
    return send_from_directory(os.path.join(HERE, 'static'), p)


if __name__ == '__main__':
    db.init_db()
    if not db.get_all_sections():
        # cold start — ingest from the last saved CSV so the page isn't empty
        try:
            sections, _ = fetch.fetch_and_parse(use_cache=True)
            if sections:
                db.replace_all_sections(sections)
                print(f'cold-start ingest: {len(sections)} sections from cache')
        except Exception as e:
            print('cold-start ingest skipped:', e)
    app.run(port=5055, debug=False, threaded=True)

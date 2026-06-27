# Fall 2026 Section Tracker

## What this is
A dashboard for analyzing **Fall 2026 course sections** — primarily **modality**
(Instructional Method) — modeled on the program/student trackers. Colleges enter
**Notes** per section; the Graduate Dean sets an owner-only **Modality Resolved**
(Yes/No) flag. Local Flask admin app + password-gated static site on GitHub Pages.

- **Live site:** https://wmeleis.github.io/section-tracker/ (password `husky26`)
- **Repo:** https://github.com/wmeleis/section-tracker (public; data is encrypted)
- **Local admin:** `python3 app.py` → http://localhost:5055 (Modality Resolved editable here)

## Data source — Tableau "Active Classes" (Registrar site)
The view is gated behind empty Subject Code + Class College multi-selects plus a
term parameter, so a plain REST export returns nothing. The owner saved one shared
Tableau **Custom View per term** ("Fall 2026", "Spring 2026", "Summer 2026"), each
with its term + all subjects + all colleges selected. A custom view bakes its
filter state server-side, so the REST custom-view data endpoint returns that term's
full section table in one request — **no browser needed for the recurring pull**.
The fetcher pulls every term in `fetch_active_classes.TERMS` (add a term by saving
a new custom view and listing it there). To change a term's selection, edit its
custom view in the browser (no code change). **Sign-in is pinned to the Registrar
site** (the PAT JSON's `site` key points elsewhere — don't use it). PAT in
`data/tableau_pat.json` (gitignored). Endpoint:
`/api/exp/sites/{site}/customviews/{cv}/data`. ~25k sections across 3 terms.

**Term is part of the key.** CRNs repeat across terms, so every section's id and
the DB primary key are `"{term}|{crn}"`. The dashboard's **Term** row (first
control) scopes everything to one term (default Fall 2026; "All" shows every term).

The feed is row-per-(CRN × meeting/faculty); `fetch_active_classes.parse_sections`
collapses to **one row per CRN**, merging multi-valued faculty/meeting/location,
and drops administrative placeholders (empty Subject / "Administrative Non-CEU").

## Editable overlay — Airtable (`notes_store.py`)
Base `appPpmcDzhL2BllHu`, table `tblUbDvuKPudNy6d8`. Token in **Keychain**
(`security … -s airtable-sections -a token`). Fields: `CRN`, `Term`, `Course`,
`College`, `Notes`, `Modality Resolved` (Yes/No), `Updated By`. Notes are keyed
on **(CRN, Term)** — the upsert merges on `['CRN','Term']` and self-heals to
`['CRN']` if the `Term` field is missing (but multi-term notes need the `Term`
field present, or notes won't line up with the right section).
- **Notes** — colleges edit on the dashboard; writes go straight to Airtable.
- **Modality Resolved** — editable only in the local/admin build (`is_admin`);
  the static site renders it read-only, so in practice only the owner sets it.
- Writes are self-healing: an unknown field name is dropped and retried (so the
  rest still saves). If Airtable is unreachable, everything falls back to
  `data/notes_local.json`.

The static site reads Notes + Modality Resolved **live** from Airtable on every
load (token rides inside the encrypted payload), so edits appear immediately and
the owner's resolved flags propagate without a rebuild. Section facts are the
only thing baked into the daily snapshot.

## Files
| File | Purpose |
|---|---|
| `fetch_active_classes.py` | Tableau custom-view pull + parse/dedupe to one row per CRN |
| `database.py` | SQLite `sections` table (CRN PK); facts only, replaced each fetch |
| `notes_store.py` | Airtable read/write overlay (Notes + Modality Resolved) + local fallback |
| `app.py` | Flask :5055 — dashboard + `/api/sections`, `/api/connect`, note/resolved POSTs |
| `export_static.py` | Build encrypted, password-gated `docs/` (AES-256-GCM / PBKDF2) |
| `deploy.py` | Force-push `docs/` as one squashed commit to `gh-pages` |
| `run_update.py` | One cycle: pull → store → build → deploy (used by launchd + Update button) |
| `update.sh` + `launchd/…plist` | Daily refresh at 06:30 local time |
| `static/app.js`, `static/style.css`, `templates/dashboard.html` | Frontend |

## UI
Modality bar (tile per Instructional Method, click to filter) · view chips
(built-in modality views + "Modality unresolved/resolved", "Has notes", + custom
saved views in localStorage) · filters (College, Campus, Subject, Modality,
Resolved, Grad/Undergrad, search) · sortable expandable table; each row expands
to section detail + Notes editor + Modality Resolved toggle.

## Deploy / publishing (gh-pages, repo-size safe)
`docs/` is gitignored on `main`. `deploy.py` builds `docs/` into a throwaway temp
repo and **force-pushes a single squashed commit** to `gh-pages` (Pages source =
`gh-pages` /), so neither branch accumulates the daily 12 MB `.enc`. The local
"Update data" button and the daily launchd job both run the full pull→build→deploy.

## Security tradeoff (note)
The Airtable token (read+write to the base) is embedded in the encrypted payload,
so anyone with the site password can recover it and could, via the raw API, write
any field including Modality Resolved (the UI never exposes that on the static
site). Acceptable for an internal, trusted audience. To harden: move Modality
Resolved to a separate base the shared token can't reach, or front writes with a
small auth proxy.

## Common ops
```bash
python3 fetch_active_classes.py            # live pull, print modality counts
python3 fetch_active_classes.py --cache    # parse last saved CSV (offline)
python3 run_update.py --no-deploy          # pull + build, skip gh-pages push
python3 run_update.py                       # full cycle
launchctl unload/load ~/Library/LaunchAgents/com.sectiontracker.update.plist
```

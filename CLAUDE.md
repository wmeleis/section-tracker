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
the DB primary key are `"{term}|{crn}"`. The dashboard's **Term** dropdown filter
scopes everything to one term (default Fall 2026; "All terms" shows every term).

**Special topics + times offered (two derived fields — single source: Historical Courses).**
Both come from the Registrar's **"Historical Courses"** section list (all terms with
faculty, `data/historical_courses.csv`), distilled by **`build_historical_st.py`** into
`data/historical_st.json`. This replaced the earlier catalog web-scrape, the Course-
Inventory title scan, and the Registrar's "Special Topic Summary" dashboard (all three
retired) — the historical list identifies ST *and* counts offerings from one place, and
its section titles catch generic-titled shells (e.g. ECON 4650 run as "ST: …") that a
catalog-title scan misses. Two title fields in that file map onto the two jobs:
- **Which courses are special topics** — the catalog *shell* name (`Course Title`, e.g.
  "Spec Topics in Political Sci", "Topics in Studio Art") identifies the course; a code is
  ST if any of its rows (through the cutoff term) has a topics-matching `Course Title` OR a
  `Section Title` with an explicit "ST:" marker. `data/special_topics_exclusions.json`
  removes course-type false positives whose title merely trips the topics regex —
  currently only **SOCL 7003** (doctoral proseminar); **HONR 3300–3303** ("Topics in
  Research and Inquiry") are explicitly kept. → `historical_st.json.st_codes` (~327 codes).
- `special_topics` (Yes/blank) — set in `_make_section`: code ∈ `st_codes` OR the section
  title trips `is_special_topic` (covers codes the historical file lacks); **then a
  course-number propagation pass** flags every section under an ST shell (catches
  topic-named sections like CS 7180 "Applied Deep Learning" with no marker). ~479 ST
  sections across the three terms.
- Both times_offered + previous_offerings count by **DISTINCT PREVIOUS TERM** (earlier than
  the section's own term), so concurrent same-term sections don't inflate them. This is the
  fix for the ARCH-7430 case: a research-methods course caught by "Topics" in its title, run
  as 7 parallel Fall-2026 sections with blank section titles — the old section-count showed
  "7" with an empty previous list; term-counting shows the honest **0 prior terms**.
  `historical_st.json` stores the raw material as `offerings` (topic_key `"CODE␟topic"` ->
  list of `{term, rank, instructor, enrolled}`, most-recent-first) + `crn_topic`
  (`"canon-term|crn" -> topic_key`), both run **through the cutoff term (Fall 2026)** —
  future terms (Spring 2027…) and the Tableau "All" rollup excluded. `fetch_and_parse`
  resolves each section's topic **exact by `(term, CRN)`** via `crn_topic` (immune to
  ActiveClasses-vs-Historical wording differences), normalized-title fallback for CRNs
  absent from the file, then groups its `offerings` by term keeping only earlier terms:
- `times_offered` (int, "Prior Terms" in the UI; blank when the topic didn't resolve) =
  **number of previous terms** the topic ran. `≥ 2` = 2+ prior terms (what the "Special
  topics — 2+ prior offerings" team view filters — threshold is 2, not 3).
- `previous_offerings` (JSON list, blank when none) = **one row per previous term**
  `{term, instructor(s), enrolled (term total), sections}`, most-recent-first. Stored as a
  section column, shown as a **"Previous offerings"** list in the row's detail panel
  (special-topics rows only). export_static ships it as a real array; the frontend tolerates
  array-or-JSON-string.
- `special_topics` / `times_offered` are `defaultHidden` columns (⊞ Columns) + Views filter
  fields; Prior Terms is a **number** field (at least / at most / equals).
- **Refresh:** `fetch_historical.py` re-pulls the Historical Courses view (direct REST data
  export, no custom view) and rebuilds `historical_st.json` **daily** — gated ~20h, keep-
  last-good on any failure — wired into `run_update.py` and the local Update button;
  `fetch_active_classes.reload_historical_st()` picks it up in-process. `fetch_active_classes`
  loads only the compact JSON at scan time (never the 53 MB CSV).

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
One **Resolved** button row (All/Unresolved/Resolved/Has notes) · a row of
**dropdown filters**: Term (default Fall 2026; "All terms" option), Level
(Grad/Undergrad), Modality (Instructional Method), Special Topics (All / only /
not — uses the title-derived `special_topics` flag), College, Campus, Subject,
plus Search · sortable expandable table; each row expands to section detail +
Notes editor + Modality Resolved toggle. (Term, Level, and Modality were all
originally toggle/tile rows — the user moved them to dropdowns; only Resolved
remains as buttons. There is no longer a modality "pipeline" tile bar.)

**Header tools (ported from the program tracker):**
- **★ Views** — full saved-Views system: a filter-tree builder modal (recursive
  AND/OR groups of rules over `SECTION_FILTER_FIELDS`), **Team** views (admin-only
  edit; `GET/POST /api/views` → `data/section_views.json`, baked into the static
  payload as `team_views`, read-only on the static site) + **Personal** views
  (`localStorage['sectrk-views-v1']`), a permanent **All sections** system view,
  star tiles above the table (`localStorage['sectrk-starred-v1']`), draft-until-
  Apply, live match count. Admin = `!window._staticMode` (purple ADMIN pill). A
  view snapshots visible columns + the full top-bar filter state (incl. term) + tree.
  - **Starred tiles seed for everyone:** a team view carrying `"starred": true`
    in `section_views.json` auto-stars on each browser's first sight
    (`initStarredIfNeeded`, tracked via `localStorage['sectrk-starred-seen-v1']`
    so a user's later un-star sticks) — so an admin-starred team view appears as a
    tile for all users (incl. colleges on the static site), like the student page.
    An admin star/unstar on a team view persists `starred` back to the shared file
    (`pvStarById`). Shipped starred team views: **Live Cast courses**
    (Modality = Live Cast), **Live Cast — needs justification** (Live Cast AND
    `has_notes = No`), and **Special topics — 2+ prior offerings**.

**Live Cast justifications live in the Notes field** (no dedicated column). For a
Live Cast section the detail panel relabels "College notes" → **"Live Cast
justification"** with a justification prompt; the **"Live Cast — needs
justification"** view is the tracking queue (LC sections with an empty note). So a
college's LC justification is just its section Note, and Notes stays one free-text
field serving both purposes.
- **⊞ Columns** — show/hide table columns (`SECTION_COLUMNS`; `defaultHidden`:
  Term/CRN/Schedule/Meeting Time/Location/Faculty Email). Persisted in
  `localStorage['sectrk-cols']`.
- **⤓ Export** — CSV of the currently-filtered rows × visible columns.
- **Console** — data-status modal (`/api/console`: last pull, registrar refresh,
  total + per-term counts, notes-store status, last update result). Local-only.
- **↻ Update data** — re-pull + rebuild + deploy, with `#scan-status` feedback.
  Local-only (stripped on the static site).

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

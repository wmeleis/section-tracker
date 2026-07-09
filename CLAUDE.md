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
Tableau **Custom View per current/upcoming term** ("Fall 2026", "Summer 2026"), each
with its term + all subjects + all colleges selected. A custom view bakes its
filter state server-side, so the REST custom-view data endpoint returns that term's
full section table in one request — **no browser needed for the recurring pull**.
The fetcher pulls every term in `fetch_active_classes.TERMS` (add a term by saving
a new custom view and listing it there). To change a term's selection, edit its
custom view in the browser (no code change). **Sign-in is pinned to the Registrar
site** (the PAT JSON's `site` key points elsewhere — don't use it). PAT in
`data/tableau_pat.json` (gitignored). Endpoint:
`/api/exp/sites/{site}/customviews/{cv}/data`. ~25k sections across 3 terms.

**Aged-out terms backfilled from Historical Courses (`HISTORICAL_BACKFILL_TERMS`, currently
`Spring 2026`).** Active Classes only exposes the current/upcoming roster, so a past term
(Spring 2026) returns 0 there. Those terms are rebuilt from the **Historical Courses** feed
by `fetch_active_classes.sections_from_historical(term_label, subj_college_map)` — collapsed
to one row per CRN, in the same schema as a live section. The historical feed is a **thin
source**: it carries term / course + section title / CRN / faculty / enrollment (Avg. Enrolled)
only, with **no instructional method, campus, section number, schedule, meeting time, location,
faculty email/type, honors, attributes, or description** — so those fields are blank on
backfilled rows (Campus/Modality render "—", and Modality/Campus filters don't apply to them).
Two fields are **derived**: **College** from a majority `subject → college` map learned from
the live terms' own rows (`_subject_college_map`; the ~18 legacy subject codes absent from the
current catalog — ABRL, ECO, HSTY, PS, WRIT… — stay blank), and **Level** (UG/GR) from the
course number (`_level_from_number`, `<5000 → UG`, matching the Registrar Level field exactly).
Backfill runs inside `fetch_and_parse` **before** the ST-propagation + times-offered join, so
these rows get special-topics flags and prior-term counts like any live section. ~8.8k Spring
sections. (Add another aged-out term by listing its canonical label in `HISTORICAL_BACKFILL_TERMS`.)

**Term is part of the key.** CRNs repeat across terms, so every section's id and
the DB primary key are `"{term}|{crn}"`. The dashboard's **Term** button row is
multi-select (`filters.term` is an array; `[]` = all terms, default `['Fall 2026']`),
with an "All terms" button. The buttons are ordered **chronologically ascending**
(`termRank` = year·10 + Winter<Spring<Summer<Fall), so e.g. Spring 2026 sits before
Fall 2026. **Term** is also a (defaultHidden) table column, placed right after Title.

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
  topics — 2+ prior terms" team view filters — threshold is 2, not 3). A top-bar **Prior
  terms** dropdown (Any / 1+ / 2+ / 3+ / 5+, `filters.priorTerms`) filters on it too.
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

**Keep-last-good on empty pulls (`database.replace_all_sections`, `protect_empty_terms=True`).**
The store is a full DELETE+INSERT, but if a term that currently HAS rows comes back with
**zero** rows in a pull (intermittent-empty Tableau response, or an aged-out source), its
existing rows are **preserved instead of wiped** — this protects the active term (Fall)
from a single bad pull. A term that already had no rows stays empty (a genuinely dropped
term that has no live custom view and isn't in `HISTORICAL_BACKFILL_TERMS` is not
resurrected; **Spring 2026** is now backfilled from Historical Courses — see above — so it
is no longer empty). Added 2026-07-07 after a 6:30 scan pulled Spring 2026 = 0 and the old
unconditional wipe deleted that term (irrecoverable — `docs/` gitignored, gh-pages squashed;
only a Time Machine copy survived). Partial drops (a term returning far fewer rows, not zero)
are **not** guarded yet.

**Always-visible refresh + build times** (same location/format as the program & student
trackers). The header holds two adjacent `.last-updated` spans, shown for everyone (local +
shared site): `#last-updated` → **"Updated: `<mon d>` at `<time>` ET"** (from `last_fetch`,
when Tableau was last pulled) and `#app-build` → **"Build: `<mon d, yyyy, time>` ET"** (from
`built_at`, when export_static last ran — also stored in the `last_build` meta). Both are
TZ-stamped before emitting (`db._iso_local`; `built_at` carries its own offset) so any-TZ
browsers render ET correctly. On the shared static site these two are the staleness signal —
if the scan stalls, the frozen timestamps show it.

**Source-data staleness banner — LOCAL app only** (like the CIM program tracker; owner-facing).
`database.source_health()` reports the last-successful-read timestamp for each batch input —
**Section roster (Active Classes)** = `last_fetch`, **Historical Courses** =
`data/last_historical_fetch` — with `STALE_SOURCE_DAYS = 3`. Served via `/api/sections` +
`GET /api/source_health`; the amber, dismissible banner (`renderSourceHealthBanner`,
`#source-banner`) renders **only when `!STATIC`** and **only when a source is stale**.
Airtable notes are live-read, so **not** a source. Dismissal is keyed by the stale-signature
(`localStorage['sectrk-srcbanner-dismissed']`) so a new/worse staleness re-appears.

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
| `update.sh` + `launchd/…plist` | Daily refresh, retry-until-success (see below) |
| `static/app.js`, `static/style.css`, `templates/dashboard.html` | Frontend |

## UI
**Layout (copied from the program/student trackers):** content is full-width flush-left
(no `max-width`/`margin:auto` centering; ~24px inset). Order under the header: starred
**Views** tiles on top, then a **▸ Filters** toggle, then the filter panel. The Resolved
row + dropdown filters live in `#controls-section` (a soft-blue band, `#d8e6f6`/`#bcd0e6`,
matching the VIEWS tiles). The panel is **collapsible and always collapsed on page load**
(`body.filters-collapsed #controls-section{display:none}`; session-only, not remembered —
copied from the student tracker's `toggleTopFilters`): `toggleFilters()` flips `_filtersOpen`
and `applyFiltersState()` sets the `▸`/`▾ Filters` label; `<body class="filters-collapsed">`
+ `applyFiltersState()` in `load()` avoid a flash.

**Columns + Export** live in a `.table-toolbar` row directly above the list (summary on the
left, the two buttons right-aligned via `margin-left:auto`), NOT in the header (which keeps
only Views / Console / Update data).

**Two gotchas that bit the filter toggle:**
1. `static/app.js` is wrapped in an IIFE (`(function(){ 'use strict'; … })()`), so a bare
   `function foo(){}` is NOT global. **Any function referenced from an inline `onclick=` must
   be exported at the bottom** (`window.foo = foo;`) — otherwise the click silently no-ops.
2. The local app previously loaded `/static/{style.css,app.js}` with **no cache-buster**, so
   the browser served stale assets after edits (looked like "the change didn't work"). Fixed:
   `app.py:dashboard()` passes `cb=_asset_cb()` (newest of the two files' mtimes) and the
   template appends `?v={{ cb }}`. These two tags sit outside the `app-root…toast` block that
   `export_static` extracts, so the static build is unaffected (it cache-busts on its own).

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
    `has_notes = No`), and **Special topics — 2+ prior terms (Spring/Summer/Fall 2026)**
    (`special_topics=Y`
    AND `times_offered>=2`, term scoped to **Spring 2026 + Summer 2026 + Fall 2026**
    — the full current academic year — with the **Term** column shown so the terms are
    distinguishable).

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

**Schedule — retry-until-success, once/day (`launchd` `com.sectiontracker.update`).**
launchd fires `update.sh` every **30 min** (`StartInterval 1800` + `RunAtLoad`, so it
also fires on load/wake). `update.sh` gates itself to at most **one successful refresh
per calendar day**: before 6am it skips; if `data/last_success_date` already equals
today it skips; otherwise it runs `run_update.py` and, **only on exit 0**, stamps today
into `data/last_success_date`. A failed attempt (exit ≠ 0) leaves the marker stale, so
the next 30-min firing retries — this fixes the old `StartCalendarInterval` 06:30 design
where a single morning failure (e.g. the network not being up yet, as on 2026-07-09)
left the site stale until the next day. After the day's first success, later firings are
cheap no-ops (date check + exit). `data/last_success_date` is gitignored (runtime state).

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

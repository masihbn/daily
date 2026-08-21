# Build plan — "Daily" v1

**Purpose.** This is the execution plan that turns `docs/APP_CONCEPT.md`
(the resolved design) into shipped code. It is written so that a session
with **no prior context** can open it, read one step, and immediately
know what to build, how to build it, and how to prove it works.

**How to use this file:**

1. Read `CLAUDE.md` (repo root) first — it auto-loads and gives the
   high-level shape.
2. Read the **Step Contract** section below.
3. Find the first step whose status is not `DONE`. Read that step's
   *entire* entry — its Preconditions, Deliverables, Implementation
   notes, and Test Subjects.
4. Build it. Test it. Update the step's status line and fill in its
   Test Subjects results. Commit.
5. Do **not** skip ahead. Steps are ordered by hard dependency unless
   explicitly marked parallel-safe.

**Status legend:** `TODO` · `IN PROGRESS` · `DONE` · `BLOCKED`

---

## Ground rules that apply to every step

These are non-negotiable and are *not* repeated in each step. Violating
one of these is a bug even if the feature works.

- **No build step. No bundler. No npm in the deploy path.** GitHub Pages
  serves the repo verbatim. Everything that ships must be a file in the
  repo or a pinned CDN URL in a `<script>` tag.
- **Native ES modules only** (`<script type="module">`). This is how we
  get multi-file JS without a bundler. Supported on iOS Safari 10.1+.
  Consequence: **the app will not run from `file://`** — always test
  through an HTTP server.
- **Use PowerShell, not the Bash tool, to run local test servers.** The
  Bash tool on this machine runs in an isolated network namespace and
  its servers are unreachable. (Documented in `docs/PROJECT_NOTES.md` →
  Environment notes.) Bash is fine for git/gh/file work.
- **Any change to a cached asset requires bumping the `CACHE` constant
  in `sw.js`.** If you add a new file to `ASSETS`, bump it. If you edit
  `index.html`, `styles.css`, any `js/**` file, or an icon, bump it.
  Forgetting this means already-installed phones keep serving stale
  files. Use the naming scheme `daily-vN`.
- **Schema changes go in `supabase/migrations/` as a new numbered
  `.sql` file**, applied via the Supabase MCP `apply_migration` tool.
  Never hand-edit tables in the dashboard without writing the matching
  migration file. After applying, update `docs/DATA_MODEL.md` so it
  always describes what is actually live.
- **Stage deliberately.** `git add <specific files>`, never `git add -A`.
- **RLS stays open during v1.** This is a recorded, accepted tradeoff
  (`docs/APP_CONCEPT.md` → "RLS/auth hardening timing"). Do not
  "helpfully" harden it mid-build — it is Phase 5, Step 5.3, and doing
  it early will break every step in between. Do not add fields beyond
  what this plan specifies without revisiting that decision.
- **Append to `docs/PROJECT_NOTES.md`'s Test log** when a step is
  verified on a real device or produces a gotcha worth remembering.

---

## Step Contract

Every step below has the same shape. When you execute a step you are
responsible for all five parts.

| Field | Meaning |
|---|---|
| **Status** | Update it as you go. |
| **Goal** | One sentence — what is true after this step that wasn't before. |
| **Preconditions** | What must already be `DONE`. If unmet, stop. |
| **Deliverables** | The exact files created/changed. |
| **Implementation notes** | The technical specifics — schema, function signatures, algorithms, gotchas. This is the part that lets a cold session skip re-deriving decisions. |
| **Test Subjects** | *Intentionally left empty in this plan.* The executing session designs and runs the tests for that step, using whatever methodology fits (browser automation, direct SQL via Supabase MCP, unit-style assertions in a scratch harness, manual device check), then records what was tested and the result here. |

**On Test Subjects.** The protocol is: *no step is complete until its
new behavior has been actively verified, not just written.* The plan
deliberately does not prescribe the tests — the session that builds the
feature is best placed to know what could break. Record enough detail
that a later reader can tell what was actually proven versus assumed.

---

## Architecture decisions locked for v1

Recorded here so no step re-litigates them.

### Rendering / dependencies

- **Charts: Chart.js v4 (UMD) + `chartjs-plugin-annotation`, from a
  pinned jsDelivr URL.** No npm, no bundler — plain `<script>` tags.
  Chosen over hand-rolling because v1 needs four distinct chart types
  with axes, tooltips, threshold lines and zone shading, and hand-rolled
  canvas for all of that is a large amount of incidental code.
  - **Pin exact versions** in the `<script src>` (e.g.
    `chart.js@4.4.x`). Never use a floating `@latest` — a silent major
    bump would break the installed app on people's phones with no
    deploy.
  - **Verify the current version numbers at implementation time**
    rather than trusting a version written into this doc.
  - **Both CDN files must be added to `sw.js`'s `ASSETS`** so the
    installed PWA still charts while offline. Cross-origin entries in
    `cache.addAll()` are fetched as opaque `no-cors` responses in some
    cases — if `addAll` starts failing after adding them, fetch and
    `cache.put()` them individually inside the install handler instead
    of relying on `addAll`'s all-or-nothing behavior.
- **No date adapter.** Chart.js's `time` scale requires an extra adapter
  plus a date library (two more dependencies). Avoid it: use the
  `category` scale and pass pre-formatted label strings that we generate
  ourselves. All date math is ours anyway (ISO weeks, rolling windows).
- **Calendar heatmap is hand-rolled CSS Grid, not Chart.js.** A month
  grid is ~42 cells; every charting library needs an extra matrix plugin
  to render it, and DOM cells are tappable and screen-reader-navigable
  in a way a canvas region is not. The heatmap cells double as the
  "tap a day to edit that day's entry" affordance.

### Code structure

Native ES modules under `js/`, one concern per file:

```
js/
  main.js          entry point; router + app bootstrap. The only file
                    referenced from index.html (type="module").
  config.js        SUPABASE_URL / SUPABASE_ANON_KEY constants.
  api.js           thin PostgREST fetch wrapper (see Step 1.1).
  store.js         in-memory cache of trackables/entries + localStorage
                    mirror for offline reads.
  dates.js         all date math: ISO week keys, month grids, ranges,
                    local-timezone-safe YYYY-MM-DD formatting.
  aggregate.js     pure functions: rollups, normalization, bound
                    derivation. No DOM, no fetch — trivially testable.
  views/
    home.js        trackable list + quick-log
    trackable.js   create/edit form
    detail.js      per-trackable chart screen
    compare.js     multi-series comparison screen
    settings.js    settings + CSV export
  charts/
    heatmap.js     CSS-grid month calendar
    weekly.js      Chart.js bar/line + target annotation
    bounds.js      Chart.js two-bars threshold + zone shading
    overlay.js     marker overlay onto a bounds chart
```

**`aggregate.js` and `dates.js` must stay pure** (no DOM, no network).
That is what makes them testable without a browser and is where the
subtle bugs will live.

### Date handling — the single biggest correctness trap

- Entries are keyed by **local calendar date**, not UTC instant. The
  user logging at 11pm local must land on today, not tomorrow.
- **Never** use `new Date().toISOString().slice(0,10)` to get "today" —
  that is UTC and will be wrong for part of every day. Write one
  `todayLocal()` helper in `dates.js` that builds the string from
  `getFullYear()` / `getMonth()` / `getDate()` and use it everywhere.
- **Never** parse `'2026-08-21'` with `new Date(str)` — the ES spec
  parses bare date-only strings as **UTC midnight**, which shifts the
  day backward in negative-offset timezones. Parse by splitting on `-`
  and calling `new Date(y, m-1, d)`.
- ISO weeks (Mon-start, week containing the year's first Thursday) are
  the rollup unit. Put `isoWeekKey(date) -> 'YYYY-Www'` in `dates.js`
  and use it as the only grouping key. Do not hand-roll week math per
  chart.

### Open design questions to resolve during the relevant step

- **Auto-derived bound statistic is unspecified.** `APP_CONCEPT.md`
  says bounds can be auto-derived over a rolling window (default 90
  days) but never says *which statistic*. Raw `min`/`max` over the
  window is trivially skewed by a single bad reading. Proposal to
  confirm at Step 3.3: use the **10th and 90th percentiles** of the
  window, which resists outliers and still describes the oscillation
  band. Flag this to the user before implementing.
- **"Specific days of week" targets** are the one item `APP_CONCEPT.md`
  leaves open, and it notes nothing discussed so far actually needs it.
  **Ship the schema support, defer the UI** (Step 2.2) — do not let it
  block the weekly-count target that everything actually uses.

---

# PHASE 0 — Foundation

## Step 0.1 — Rename repo and Pages URL to "Daily"

**Status:** TODO

**Goal.** The project lives at its real name before anything is built on
top of the old URL, so the phone's home-screen icon is added once, not
twice.

**Preconditions.** None. This is deliberately first — see
`APP_CONCEPT.md` → "Product name" for why it was held until now.

**Deliverables.**
- GitHub repo renamed `memory-test-pwa` → `daily`.
- Local `origin` remote updated.
- `manifest.json`: `name`, `short_name`, `start_url`, `scope` updated.
- `index.html`: `<title>`.
- `CLAUDE.md` + `docs/PROJECT_NOTES.md`: every occurrence of the old URL
  and repo name.
- `sw.js`: `CACHE` bumped.

**Implementation notes.**
- **This is a user-facing, hard-to-reverse, public action. Confirm with
  the user before executing**, and expect Claude Code's own auto-mode
  classifier to gate it regardless (documented in `PROJECT_NOTES.md`).
- Rename via `gh repo rename daily --repo masihbn/memory-test-pwa`.
  GitHub auto-redirects the old URL for git operations, but **the Pages
  URL does not redirect reliably** — treat
  `https://masihbn.github.io/daily/` as the new canonical URL.
- **The `start_url` / `scope` in `manifest.json` are path-sensitive.**
  Pages serves this project from a subpath (`/daily/`, not `/`). If
  `start_url` is absolute (`/`) the installed app will launch at the
  user's GitHub root and 404. Keep these **relative** (`./`) so the
  subpath change is a non-event.
- Update the local remote: `git remote set-url origin <new url>`, then
  confirm with `git remote -v` and a `git fetch`.
- The two repo secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and the
  keepalive workflow survive a rename — no action needed, but verify
  with one `gh workflow run supabase-keepalive.yml`.
- Pages takes ~30–90s to propagate. A 404 in the first minute is
  expected, not a failure.
- The user must **delete the old home-screen icon and re-add** from the
  new URL. Tell them explicitly; the old icon will silently keep
  pointing at a dead path.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 0.2 — Migration `0003`: generalize schema to Trackables/Entries

**Status:** TODO

**Goal.** The live database matches the entity model in
`APP_CONCEPT.md`, replacing the narrower `skills`/`skill_entries`
design.

**Preconditions.** None (parallel-safe with 0.1).

**Deliverables.**
- `supabase/migrations/0003_trackables.sql`, applied live via the
  Supabase MCP `apply_migration` tool.
- `docs/DATA_MODEL.md` rewritten to describe the new schema.

**Implementation notes.**

Load the `supabase-postgres-best-practices` skill before writing this
migration — it is a schema change and that is exactly its trigger.

Prefer `ALTER TABLE ... RENAME` over drop-and-recreate: it preserves the
existing rows and keeps the migration honest about being an evolution.
There is no meaningful production data yet, but the habit matters.

**`skills` → `trackables`**, with these column changes:

| Change | Column | Type | Notes |
|---|---|---|---|
| rename | `tracking_type` → `value_shape` | text | check in `('boolean','numeric')` |
| add | `relog_semantic` | text | check in `('cumulative','state')`; only meaningful when `value_shape='numeric'`. Default `'cumulative'`. |
| add | `aggregation` | text | check in `('sum','count','average','last')`. Drives rollups. |
| keep | `direction` | text | `('build','break')` — reused as target direction: `build` = floor (hit-or-exceed is good), `break` = ceiling (stay under is good). |
| rename | `target_per_week` → `target_value` | numeric | widened from smallint: a target can be `2000` kcal, not just a small count. |
| add | `target_type` | text | check in `('none','weekly_count','specific_days')`. Default `'none'`. |
| add | `target_days` | smallint[] | nullable; ISO weekday numbers 1–7 (Mon=1). Only used when `target_type='specific_days'`. Schema ships now, UI deferred. |
| add | `bounds_enabled` | boolean | default `false`. Turns on the two-bars chart. |
| add | `bounds_mode` | text | check in `('manual','auto')`; default `'auto'`. |
| add | `bound_lower` | numeric | nullable; only used when `bounds_mode='manual'`. |
| add | `bound_upper` | numeric | nullable; same. |
| keep | `unit`, `color`, `sort_order`, `archived`, `created_at` | | unchanged |

**`skill_entries` → `entries`**, with `skill_id` → `trackable_id`.
Everything else (`entry_date`, `value`, `note`, `created_at`,
`updated_at`) is unchanged and already correct.

- **Preserve the unique constraint** on `(trackable_id, entry_date)` —
  the entire re-log-semantics design depends on one row per trackable
  per day. Renaming a table carries its constraints and indexes along,
  but *verify* this after applying rather than assuming.
- Renaming a table does **not** rename its constraints/indexes; their
  names will still say `skill_`. Cosmetic, but rename them too so a
  future reader isn't confused about what table they belong to.
- **Add an `updated_at` trigger.** `DATA_MODEL.md` currently notes the
  app must set this manually — that is a footgun. A
  `before update ... for each row` trigger setting
  `new.updated_at = now()` removes a whole class of "forgot to bump it"
  bugs. Do this now while the table is being touched anyway.

**New table `app_settings`** — single-row global config:

| column | type | notes |
|---|---|---|
| `id` | smallint | primary key, `check (id = 1)` — enforces exactly one row |
| `rolling_window_days` | integer | default `90`; the auto-bound derivation window (`APP_CONCEPT.md` confirms this is global, not per-metric) |
| `updated_at` | timestamptz | default `now()` |

Seed it with `insert into app_settings (id) values (1) on conflict do nothing;`
so the client never has to handle a missing-settings case.

- **RLS**: carry forward the same permissive `for all using (true) with
  check (true)` policy onto `app_settings` and onto the renamed tables.
  This is the accepted v1 tradeoff. Enable RLS on `app_settings` — a
  table with RLS *disabled* is a different and worse thing than one
  with a permissive policy, and `get_advisors` will flag it.
- Run `mcp__supabase__get_advisors` after applying and address anything
  new it reports that isn't the known, accepted RLS gap.
- **Do not drop the `counter` table.** The keepalive workflow
  (`.github/workflows/supabase-keepalive.yml`) pings it every 5 days to
  stop the free project auto-pausing. Dropping it silently breaks the
  keepalive and the project pauses a week later. Either leave it, or
  repoint the workflow first — leaving it is cheaper.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 0.3 — App shell: replace the tap counter

**Status:** TODO

**Goal.** `index.html` boots a real multi-view app shell with a working
router instead of the placeholder counter. No features yet — this is the
skeleton every later step hangs off.

**Preconditions.** Step 0.1 (for the correct title/URLs).

**Deliverables.**
- `index.html` rewritten: app shell markup, `<script type="module"
  src="js/main.js">`, pinned Chart.js + annotation plugin `<script>`
  tags.
- `js/main.js`, `js/config.js` created.
- `js/app.js` deleted (its Supabase constants move to `config.js`).
- `css/styles.css` rewritten for the app shell.
- `sw.js`: `ASSETS` updated for every new file + both CDN URLs; `CACHE`
  bumped to `daily-v3`.

**Implementation notes.**
- **Router: hash-based** (`#/`, `#/t/:id`, `#/new`, `#/compare`,
  `#/settings`). Not the History API — Pages serves static files, so a
  History-API deep link to `/daily/t/5` would 404 on refresh. Hash
  routing needs no server config and survives the PWA's standalone
  relaunch.
- The shell is a single `<div id="app">` that views render into, plus a
  persistent bottom nav (Home / Compare / Settings) — thumb-reachable,
  which matters on a phone.
- **iOS safe areas**: the viewport meta already has `viewport-fit=cover`.
  Pair it with `padding-bottom: env(safe-area-inset-bottom)` on the
  bottom nav or it sits under the home indicator on an iPhone 15.
- **Suppress the double-tap-to-zoom delay and text selection** on
  tap targets (`touch-action: manipulation`, `-webkit-tap-highlight-color`)
  — otherwise every quick-log tap feels 300ms laggy.
- Keep the existing service-worker registration logic; move it into
  `main.js`.
- `config.js` exports `SUPABASE_URL` and `SUPABASE_ANON_KEY`. These are
  the publishable/anon key and are **meant** to be public — keep the
  existing explanatory comment from `app.js` about never putting the
  service_role key here.
- **Dark-mode-first styling.** The app is a phone app opened at night;
  the existing theme-color is `#111111`. Respect
  `prefers-color-scheme` rather than forcing one.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

# PHASE 1 — Data layer

## Step 1.1 — PostgREST client (`api.js`) + offline store (`store.js`)

**Status:** TODO

**Goal.** One well-tested module owns all network access; the rest of
the app never calls `fetch` directly.

**Preconditions.** 0.2, 0.3.

**Deliverables.** `js/api.js`, `js/store.js`.

**Implementation notes.**
- `api.js` exports a small set of functions, not a generic
  query-builder: `listTrackables()`, `createTrackable(obj)`,
  `updateTrackable(id, patch)`, `archiveTrackable(id)`,
  `listEntries({trackableIds, from, to})`, `upsertEntry(obj)`,
  `deleteEntry(trackableId, date)`, `getSettings()`,
  `updateSettings(patch)`.
- Shared header builder: `apikey` + `Authorization: Bearer` +
  `Content-Type: application/json`. Same pattern the old `app.js` used —
  it is known to work against this project.
- **Upsert is the core operation.** PostgREST:
  `POST /rest/v1/entries` with header
  `Prefer: resolution=merge-duplicates,return=representation` and query
  param `?on_conflict=trackable_id,entry_date`. This is what makes
  re-logging a day edit rather than error on the unique constraint.
- **Every function must throw a typed, message-bearing error on
  non-2xx** — include `res.status` and the PostgREST error body, which
  is JSON with `message`/`hint`/`details` and is genuinely useful.
  Swallowing these produces silent no-op saves, which on a logging app
  means quietly losing the user's data.
- `store.js` holds the in-memory copy and mirrors to `localStorage`
  under a versioned key (e.g. `daily.cache.v1`). **Network is the source
  of truth; the cache is a read-only fallback for offline display.**
  Never let a cached value overwrite a server value on reconnect.
- **Queue failed writes.** A logging app that silently drops a log
  because the phone was in a tunnel is worse than useless. Keep a
  `localStorage` outbox of pending upserts, replay on next successful
  load, and surface pending state in the UI. If this turns out to be
  large, it is acceptable to split it into its own step — but do not
  ship v1 with writes that vanish.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 1.2 — `dates.js` and `aggregate.js` (pure logic)

**Status:** TODO

**Goal.** All date math and all rollup/normalization/bound math exist as
pure, dependency-free functions before any chart tries to use them.

**Preconditions.** 0.2.

**Deliverables.** `js/dates.js`, `js/aggregate.js`.

**Implementation notes.**

`dates.js` exports at minimum:
- `todayLocal()` → `'YYYY-MM-DD'` from local components. See the date
  trap in Architecture decisions.
- `parseLocal('YYYY-MM-DD')` → `Date` at local midnight.
- `isoWeekKey(date)` → `'YYYY-Www'`. Mon-start; the week containing the
  first Thursday is week 01. Note the year in the key is the **ISO week
  year**, which differs from the calendar year in late Dec / early Jan —
  getting this wrong makes New Year weeks silently merge or split.
- `monthGrid(year, month)` → the 6×7 array of dates for the heatmap,
  including leading/trailing days from adjacent months (flagged so they
  can be dimmed).
- `rangeDays(from, to)`, `addDays(date, n)`.

`aggregate.js` exports at minimum:
- `rollup(entries, period, aggregation)` → grouped values.
  `aggregation` is one of `sum|count|average|last`, taken from the
  trackable. `count` counts days with an entry (not sum of values) —
  that is what makes "gym sessions per week" work.
- **`average` must define its denominator explicitly.** Average over
  *days with an entry*, not over all 7 days of the week — otherwise a
  week where the user logged calories twice reads as a starvation week.
  Document the choice in a comment.
- `deriveBounds(entries, windowDays, method)` → `{lower, upper}`. See
  the open question about percentile-vs-min/max in Architecture
  decisions — confirm with the user at Step 3.3.
- `normalizeSeries(values)` → 0–100 using the series' own historical
  min–max (`APP_CONCEPT.md`, resolved). **Guard the degenerate case**:
  when `min === max` (one data point, or a flat series) the naive
  formula divides by zero. Return a constant mid-line, not `NaN`.
- `applyRelog(existingValue, newValue, trackable)` → the resulting
  stored value, implementing the resolved semantics table: `boolean` →
  idempotent (stays `1`); `numeric`+`cumulative` → add; `numeric`+`state`
  → replace. **This one function is the heart of the data model** — if
  it is wrong, every number in the app is wrong.

Because these are pure, they can be tested by loading them in Node
directly (`node --input-type=module`) or in a scratch HTML harness.
That is far cheaper than driving the UI, so favor it heavily here.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

# PHASE 2 — Core UI

## Step 2.1 — Home: trackable list + quick-log

**Status:** TODO

**Goal.** The primary daily-use screen works: see everything tracked,
log today's value for any of them in one or two taps.

**Preconditions.** 1.1, 1.2.

**Deliverables.** `js/views/home.js`, styles.

**Implementation notes.**
- Layout per `APP_CONCEPT.md` → "Navigation / home layout": a list of
  trackables, each row showing name, today's logged value (or empty
  state), and a fast log control.
- **Boolean trackables**: single tap toggles done for today. The tap
  must feel instant — update the DOM optimistically, then reconcile
  with the server response, and visibly mark the row if the write
  failed.
- **Numeric trackables**: tapping opens a compact numeric input.
  `inputmode="decimal"` — resolved in `APP_CONCEPT.md`, this is what
  brings up the numeric keypad instead of full QWERTY on iOS. Decimals
  allowed (weight = `78.4`).
- **Show the re-log semantic in the UI.** When a `cumulative` trackable
  already has a value today, the input must make clear the new number
  *adds* (e.g. "Today: 320 kcal · add more"), and for `state` that it
  *replaces*. Users cannot infer this and will corrupt their own data
  guessing.
- Respect `sort_order`; hide `archived` trackables.
- Empty state matters — a brand-new install shows nothing. Give it a
  clear "add your first trackable" path rather than a blank screen.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 2.2 — Create / edit a trackable

**Status:** TODO

**Goal.** The user can define what they track, without touching SQL.

**Preconditions.** 2.1.

**Deliverables.** `js/views/trackable.js`, styles.

**Implementation notes.**
- Form fields map 1:1 to the `trackables` columns from Step 0.2: name,
  value shape, re-log semantic, aggregation, direction, unit, target
  type + value, color, bounds config.
- **This form is where the model's complexity becomes visible, so
  progressively disclose it.** Only show `relog_semantic` /
  `aggregation` / `unit` when `value_shape = 'numeric'`. Only show bound
  fields when `bounds_enabled`. Only show `bound_lower`/`bound_upper`
  when `bounds_mode = 'manual'`. A flat form with every field showing is
  unusable on a phone.
- **Pick sensible defaults per shape** so the common case is a name and
  two taps: boolean → `aggregation='count'`, `target_type='weekly_count'`;
  numeric → `relog_semantic='cumulative'`, `aggregation='sum'`.
- `direction` doubles as target direction (`build` = floor, `break` =
  ceiling — resolved). Label it in user terms ("more is better" / "less
  is better"), never as the raw enum.
- **`specific_days` target type: expose the schema but not the UI.**
  Explicitly deferred (`APP_CONCEPT.md` open questions). Leave a comment
  pointing at that section so the next reader knows it is deliberate.
- **Archive, not delete.** The `archived` flag exists so history is
  never destroyed. If a hard delete is offered at all, it must warn that
  entries cascade (`on delete cascade` on the FK).
- Validate before writing: non-empty name, numeric target for numeric
  trackables, `bound_lower < bound_upper`.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 2.3 — Trackable detail screen shell

**Status:** TODO

**Goal.** Tapping a trackable opens its own screen with a place for each
applicable chart. Charts themselves come in Phase 3.

**Preconditions.** 2.1, 2.2.

**Deliverables.** `js/views/detail.js`.

**Implementation notes.**
- Route `#/t/:id`. Header: name, unit, edit affordance.
- **Which chart slots appear is driven by the trackable's config, not
  hardcoded**: heatmap always; weekly trend always; two-bars only when
  `bounds_enabled`; overlay only when bounds are on *and* other
  trackables exist.
- Fetch the entry range once here and pass it down to each chart module.
  Do not let each chart issue its own query — that is 3–4 round trips on
  a phone network for data they all share.
- Include an explicit date-range control (e.g. 3m / 6m / 1y / all); it
  bounds every query on this screen and every chart reads from it.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

# PHASE 3 — Charts

## Step 3.1 — Calendar heatmap

**Status:** TODO

**Goal.** Chart type 1 of 4. A month grid where each day is colored by
whether/how much was logged.

**Preconditions.** 2.3.

**Deliverables.** `js/charts/heatmap.js`.

**Implementation notes.**
- CSS Grid, `grid-template-columns: repeat(7, 1fr)`, built from
  `dates.monthGrid()`. Not Chart.js — see Architecture decisions.
- **Boolean trackables**: binary fill using the trackable's `color`.
- **Numeric trackables**: intensity ramp by magnitude, scaled against
  that month's max (or the visible range's max — pick one and document
  it; per-month scaling makes months incomparable, global scaling makes
  quiet months invisible).
- **`direction` flips the reading.** For `break` trackables (smoking),
  *low or absent* is the good color. Do not hardcode "filled = good" —
  this is exactly why the `direction` column exists
  (`DATA_MODEL.md`).
- Month navigation (prev/next), and **do not allow navigating into the
  future** past the current month.
- **Tapping a day opens that day's entry for editing** — this is the
  only way to fix a mis-logged past day, so it is not optional polish.
- Accessibility: each cell needs an accessible label with the date and
  value; color alone must not carry the meaning.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 3.2 — Weekly trend chart + target line

**Status:** TODO

**Goal.** Chart type 2 of 4. One bar/point per ISO week, aggregated per
the trackable's `aggregation`, with the target drawn as a reference
line.

**Preconditions.** 3.1 (for shared chart plumbing/styling).

**Deliverables.** `js/charts/weekly.js`.

**Implementation notes.**
- Chart.js bar chart, **`category` scale** with labels from
  `dates.isoWeekKey()` (no time adapter — see Architecture decisions).
- Values come from `aggregate.rollup(entries, 'week', trackable.aggregation)`.
  This step must not reimplement rollup logic locally.
- **Target line via `chartjs-plugin-annotation`** — a horizontal `line`
  annotation at `target_value`. Resolved in `APP_CONCEPT.md` → "Target
  lines": targets are a visual reference line, not just an abstract
  streak number.
- **Color bars by target success, using `direction`**: `build` → bar at
  or above the line is good; `break` → bar at or below is good. Same
  data, inverted verdict.
- **Weeks with zero entries must render as an explicit zero/gap, not be
  omitted.** A skipped week silently vanishing from a category axis
  makes a 3-week gap look like continuous activity — actively
  misleading on a habit tracker.
- **Destroy the Chart.js instance on view teardown** (`chart.destroy()`).
  A hash-router that re-renders a view without destroying the old canvas
  leaks the instance and produces the classic "tooltips from the
  previous chart" bug.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 3.3 — Two-bars threshold chart

**Status:** TODO

**Goal.** Chart type 3 of 4 — the mechanic that motivated the whole
reframing. A numeric metric over time with upper/lower bound lines and
zone shading.

**Preconditions.** 3.2.

**Deliverables.** `js/charts/bounds.js`.

**Implementation notes.**
- **Read `APP_CONCEPT.md` → "Bounded metrics" and "Motivating example"
  before building.** The point is to make an invisible oscillation loop
  visible; a plain line chart with two lines on it does not achieve
  that. Zone shading is the feature, not decoration.
- Chart.js line chart of **raw daily values** (not weekly rollups) —
  bounded metrics like weight want the actual trend, per
  `APP_CONCEPT.md`'s aggregation section.
- Bounds source: `bounds_mode='manual'` → `bound_lower`/`bound_upper`
  columns. `bounds_mode='auto'` → `aggregate.deriveBounds()` over the
  global `rolling_window_days` from `app_settings`.
- **Resolve the open statistic question first** (Architecture decisions
  → open questions): raw window min/max vs. 10th/90th percentile. Ask
  the user; do not silently pick one.
- Zone shading via annotation `box` regions + a gradient on the line as
  it approaches a bound. **v1 behavior is visual only** — no
  notifications, resolved explicitly.
- Handle sparse data: `state` metrics like weight are logged
  irregularly. Decide and document whether to connect across gaps
  (`spanGaps`) or break the line — connecting a 3-week gap draws a
  confident straight line through data that does not exist.
- Guard the cold-start case: fewer data points than the rolling window
  means auto-bounds are meaningless. Show an explicit "not enough data
  yet" state rather than deriving bounds from four readings.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 3.4 — Correlation marker overlay

**Status:** TODO

**Goal.** Chart type 4a. Discrete events from other trackables (gym
days) drawn as markers on a bounded metric's chart.

**Preconditions.** 3.3.

**Deliverables.** `js/charts/overlay.js`.

**Implementation notes.**
- This is the *originally scoped* correlation feature — markers on an
  existing chart, distinct from the comparison chart in 3.5.
  `APP_CONCEPT.md` splits these explicitly; keep them separate.
- Implementation: add a second Chart.js dataset with `showLine: false`
  and a distinct point style, plotted against the same category axis,
  pinned to a fixed y position (or the metric's value that day).
- Multi-select which trackables to overlay; persist the selection
  (`localStorage` is fine — it is a per-device view preference).
- Legend must distinguish overlay markers from the metric line clearly.
- Only offer boolean/discrete trackables as overlay candidates —
  overlaying a continuous numeric series is what Step 3.5 is for.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 3.5 — Normalized multi-series comparison chart

**Status:** TODO

**Goal.** Chart type 4b. Any number of numeric trackables on one chart,
each normalized to its own historical min–max, so differently-scaled
series (calories vs. dollars) are visually comparable.

**Preconditions.** 3.2, 3.4.

**Deliverables.** `js/views/compare.js`.

**Implementation notes.**
- Route `#/compare`. This is a top-level screen, not a per-trackable
  chart — it compares across trackables.
- Pipeline, resolved in `APP_CONCEPT.md`: for each selected trackable →
  aggregate to a common period using **its own** aggregation function →
  normalize to 0–100 via `aggregate.normalizeSeries()` → plot.
- **The y-axis is a percentage of each series' own range and must be
  labeled as such.** An unlabeled 0–100 axis will be read as absolute
  values and is actively misleading.
- **Raw values stay visible in the tooltip/legend** — explicitly
  resolved. Only the plotted *position* is normalized. Keep the raw
  value alongside the normalized one in the dataset so the tooltip can
  show it.
- **No hard cap on series count** (resolved), but `APP_CONCEPT.md`
  flags that readability degrades — implement a decluttering pass:
  distinct colors, a recommended-max soft warning, and the ability to
  toggle series off without deselecting them.
- Series must share a common period grid; a trackable with no data in a
  period needs an explicit gap, not a silently shifted point.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

# PHASE 4 — Settings & data ownership

## Step 4.1 — Settings screen

**Status:** TODO

**Goal.** The global rolling-window setting is user-editable, per the
resolved decision that it must not be a hardcoded constant.

**Preconditions.** 3.3 (the setting has no observable effect before
auto-bounds exist).

**Deliverables.** `js/views/settings.js`.

**Implementation notes.**
- Route `#/settings`. Reads/writes the single `app_settings` row.
- `rolling_window_days`: default 90, global not per-metric (resolved
  twice in `APP_CONCEPT.md`). Validate a sane range (e.g. 14–730).
- **Changing it must invalidate any cached derived bounds** and
  re-render affected charts — otherwise the change appears to do
  nothing until a reload, and the user concludes it is broken.
- Also a reasonable home for trackable reordering (`sort_order`) and
  viewing/unarchiving archived trackables.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 4.2 — CSV export

**Status:** TODO

**Goal.** The user can get all their data out. Scoped as a real v1
feature, not "someday."

**Preconditions.** 1.1.

**Deliverables.** CSV export in `js/views/settings.js` (+ helper).

**Implementation notes.**
- Two modes, both resolved as in-scope: **per-trackable** and
  **everything**.
- Generate client-side: build the CSV string, `new Blob([csv], {type:
  'text/csv'})`, `URL.createObjectURL`, trigger an `<a download>`, then
  **`URL.revokeObjectURL`** to avoid leaking the blob.
- **iOS Safari's download behavior for blob URLs is the risk here**, and
  it differs between a Safari tab and a standalone home-screen PWA. Test
  on the actual device. If `<a download>` proves unreliable in
  standalone mode, the fallback is rendering the CSV into a
  select-all-able `<textarea>` / share-sheet path. Do not declare this
  step done based on a desktop-browser test alone.
- CSV correctness: quote fields containing commas/quotes/newlines
  (notes are free text and *will* contain commas), double up embedded
  quotes, and emit a header row. Include the trackable name and unit,
  not just the id — an export whose rows say `trackable_id: 7` is not
  useful to a human.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

# PHASE 5 — Hardening & release

## Step 5.1 — Offline behavior & service-worker pass

**Status:** TODO

**Goal.** The installed app opens and shows last-known data with no
network, and reliably picks up new deploys.

**Preconditions.** Phases 1–4.

**Deliverables.** `sw.js` reworked; offline states in the UI.

**Implementation notes.**
- The current `sw.js` is network-first-with-cache-fallback, which is
  right for this app (data freshness beats instant load). Keep the
  strategy; make sure the asset list is complete, **including both
  pinned CDN chart scripts**.
- **Never cache Supabase REST responses in the service worker.** Serving
  a stale entry list from the SW cache while the app also has its own
  `store.js` cache produces two competing stale layers and
  irreproducible bugs. Restrict SW caching to same-origin app assets +
  the pinned CDN scripts; let `store.js` own data caching.
- Add a visible "offline — showing last known data" indicator, and
  surface the pending-write outbox from Step 1.1.
- **Verify the update path explicitly**: bump `CACHE`, deploy, and
  confirm an already-installed client actually picks up the new version.
  This is the single most-repeated gotcha in `PROJECT_NOTES.md`.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 5.2 — Face ID local app-lock (WebAuthn)

**Status:** TODO

**Goal.** Opening the installed app requires Face ID (falling back to
device passcode).

**Preconditions.** Phases 1–4. Deliberately after core features.

**Implementation notes.**
- **Scope is resolved and narrow: a local device-level app-lock only.**
  Not Supabase user accounts. See `APP_CONCEPT.md` → "Face ID / auth
  scope (resolved)".
- **Be honest in the UI about what this does and does not protect.**
  Resolved and re-stated in the concept doc: a local lock does *not*
  secure the backend. Anyone with the anon key can still read/write over
  the network until Step 5.3. Do not label this "your data is secure."
- Mechanism: WebAuthn platform authenticator. Register a credential
  (`navigator.credentials.create`) on first setup, then require
  `navigator.credentials.get` with `userVerification: 'required'` at
  launch. Store the credential id locally.
- **Confirmed feasible on installed iOS PWAs**, with automatic passcode
  fallback. Caveat already researched: standalone PWA mode is disabled
  in the EU under the DMA — irrelevant unless used from the EU.
- **This step can lock the user out of their own app.** Ship an escape
  hatch (a way to clear the credential / a bypass query param) before
  enabling it, and test the failure path *first*.
- WebAuthn requires a secure context — fine on the Pages HTTPS URL, and
  `localhost` is also treated as secure, but a LAN-IP test server over
  plain HTTP is **not** and will fail. Plan device testing accordingly.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 5.3 — RLS hardening + Supabase Auth

**Status:** TODO

**Goal.** Close the tracked security gap: real per-user, auth-scoped
policies replacing `using (true)`.

**Preconditions.** Feature set stable (Phases 1–4 done). This ordering
is an explicit, recorded decision — not an oversight.

**Implementation notes.**
- **Read `docs/DATA_MODEL.md` → "Security status" and
  `docs/PROJECT_NOTES.md` → "Security posture" first.** Both describe
  the exact intended fix.
- Shape: Supabase Auth (single-user email/magic-link is sufficient) +
  a `user_id uuid` column on `trackables` (and `entries`, or derived via
  the FK) + policies scoped to `auth.uid()`, replacing every
  `using (true)` policy including `counter`'s.
- **Backfill `user_id` on existing rows before making the column
  `not null` or enabling the restrictive policy**, or every existing
  entry becomes invisible the moment the policy flips. Do this as an
  ordered migration: add nullable → backfill → set not null → swap
  policies.
- The client must now handle a signed-out state, token refresh, and the
  PWA relaunch case where the session is restored from storage.
- **Update the keepalive workflow** — it pings `counter` with the anon
  key. If `counter`'s policy tightens, the workflow starts failing and
  the project silently auto-pauses a week later.
- Run `mcp__supabase__get_advisors` afterward and expect the known-gap
  warnings to clear.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Step 5.4 — Real-device verification & docs close-out

**Status:** TODO

**Goal.** The whole thing is confirmed working on the actual iPhone, and
the docs describe reality.

**Preconditions.** All prior steps.

**Implementation notes.**
- **The equivalent test for the plumbing already passed** — the live
  HTTPS URL, Add to Home Screen, standalone launch, icon rendering and
  persistence were all confirmed on the real device on 2026-08-21
  (`PROJECT_NOTES.md` → Test log, Attempt 5). So the PWA shell is known
  good; **what is unverified here is the "Daily" app itself**, which did
  not exist at that point. Do not treat Attempt 5 as covering this step.
- Repeat the same device checks against the real app: Add to Home
  Screen, standalone launch, icon rendering, log an entry over cellular,
  kill and relaunch, confirm persistence — plus the things Attempt 5
  could not have exercised: chart rendering on a phone-sized viewport,
  the CDN chart scripts loading (and working offline from the SW cache),
  the CSV download path, and the Face ID lock.
- Some of this **cannot be verified from this machine** — Safari-specific
  service-worker behavior, Add-to-Home-Screen, standalone launch, and
  the CSV download path all need the real device and the user's report.
  Ask for it explicitly; do not mark verified on desktop evidence.
- Update `CLAUDE.md` (it currently says "the actual tracking UI has not
  been built yet" — that will be false), `docs/DATA_MODEL.md`, and
  append a Test log entry to `docs/PROJECT_NOTES.md`.
- Note the Claude-in-Chrome extension disconnects between turns
  sometimes; have `Invoke-WebRequest` + Supabase MCP queries ready as
  the fallback verification path.

**Test Subjects.**

_(To be filled in by the executing session.)_

---

## Orchestration model

How this plan is meant to be executed across sessions.

**One step = one subagent task.** Each step above is scoped to be
completable by a single agent with a bounded context: the step's own
entry, the Ground Rules, the Architecture decisions, and the specific
files it names. That is the reason the steps carry redundant technical
detail rather than cross-referencing each other heavily — a cold
subagent should not need to read the whole plan to do one step.

**The orchestrator's job** (the session holding this file):
1. Pick the first non-`DONE` step; confirm its preconditions really are
   `DONE`, not just marked so.
2. Hand the subagent: the step text verbatim, the Ground Rules, the
   Architecture decisions, and a pointer to `CLAUDE.md` +
   `docs/APP_CONCEPT.md`.
3. On completion, **verify rather than trust** — read the diff, confirm
   the Test Subjects section was actually filled in with real results,
   and check that `sw.js`'s `CACHE` was bumped if assets changed.
4. Update the step status here and commit.

**Parallelism.** Most steps are strictly sequential. The genuinely
parallel-safe pairs: 0.1 ∥ 0.2 (rename vs. schema touch nothing in
common), and 3.1 ∥ 3.2 only after their shared plumbing exists. Do not
parallelize Phase 1 — later steps depend on the exact function
signatures earlier ones establish.

**When a subagent hits a gray area**, it should stop and surface it to
the orchestrator rather than guessing — every guess that contradicts
`APP_CONCEPT.md` costs more to unwind than to ask about. The known gray
areas are listed under Architecture decisions → open questions.

---

## Decision log for this plan

- **2026-08-21** — Plan created from `docs/APP_CONCEPT.md`.
- **2026-08-21** — Charting: Chart.js v4 + `chartjs-plugin-annotation`
  via pinned CDN `<script>` tags. This does not violate the "no
  framework" rule, which is specifically about build tooling — a CDN
  tag needs no npm, bundler, or compile step. Calendar heatmap stays
  hand-rolled CSS Grid (tappable/accessible cells; every lib needs an
  extra matrix plugin to do it worse). No date adapter — `category`
  scale with self-generated labels avoids two more dependencies.
- **2026-08-21** — Code structure: native ES modules, no bundler.
  Consequence: must be served over HTTP, never `file://`.
- **2026-08-21** — Repo/Pages rename to "Daily" scheduled as Step 0.1,
  executed before feature work so the phone install happens once.
- **2026-08-21** — Face ID app-lock sequenced after core features
  (Step 5.2); RLS hardening after that (5.3), per the recorded tradeoff.
- **2026-08-21** — Test Subjects sections intentionally left empty; the
  executing session designs and records its own verification per step.

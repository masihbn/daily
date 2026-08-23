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

### Testing

Full protocol in **`docs/ORCHESTRATION.md`**. The short version:

- **Unit tests** (`tests/unit/`) — Node's built-in runner, `node --test`,
  zero dependencies. Covers `dates.js` / `aggregate.js`, where the real
  bugs live. Bias heavily toward these.
- **Integration tests** (`tests/integration/`) — real PostgREST calls
  against rows named `__test__*`, torn down after.
- **E2E** (`tests/e2e/`) — Playwright, a **test-only devDependency**.
  Never shipped; the deploy path stays pure vanilla. Small, high-value
  smoke checks only.
- **The suite is cumulative and always run in full.** A step is not
  `DONE` until every test from every prior step still passes.
- **Nothing may ever modify a Supabase row not prefixed `__test__`.**
  That guardrail is what protects real logged data.

### Resolved design questions

- **Auto-derived bound statistic: 10th / 90th percentile** of the
  rolling window (resolved 2026-08-21, rationale in `APP_CONCEPT.md` →
  Bounded metrics). Raw min/max was rejected — it is set by exactly two
  readings, which are the two most likely to be measurement noise, and
  one bad weigh-in would permanently widen the band.
- **"Specific days of week" targets** remain the single open design
  question in `APP_CONCEPT.md`. Resolution for v1: **ship the schema
  column, defer the UI** (Step 2.2). Nothing discussed so far needs it
  over a weekly-count target, so it must not block v1.

---

# PHASE 0 — Foundation

## Step 0.0 — Test harness & regression suite scaffold

**Status:** DONE (2026-08-21)

**Goal.** `npm test` exists, runs green against an empty-but-real suite,
and every later step has somewhere to add tests. Nothing else in this
plan can be verified until this exists.

**Preconditions.** None. This is genuinely first.

**Deliverables.**
- `package.json` — test-only. Playwright as the sole devDependency,
  `"private": true`, npm scripts for each tier plus an aggregate `test`.
- `.gitignore` — add `node_modules/`, Playwright's `test-results/` and
  `playwright-report/`.
- `tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/helpers/`.
- `tests/helpers/server.mjs` — zero-dependency static file server.
- `tests/helpers/supabase.mjs` — `__test__` row helpers + stale sweep.
- `playwright.config.mjs`.
- One trivial smoke test per tier, proving the tier actually runs.

**Implementation notes.**
- **`package.json` at the repo root does not make this a Node project
  and does not affect the deploy.** GitHub Pages serves static files and
  ignores it. Say so in a `"description"` field so a future reader
  doesn't think a build step appeared. `node_modules/` must be
  gitignored — it must never reach Pages.
- **Run tests from PowerShell, not the Bash tool.** Bash on this machine
  runs in an isolated network namespace; a server it starts is
  unreachable, which will make Playwright hang confusingly.
  (`PROJECT_NOTES.md` → Environment notes.)
- `server.mjs`: use Node's built-in `http` + `fs`. Do not add a
  dependency for this. **It must send `Content-Type:
  text/javascript` for `.js`** — native ES modules are rejected outright
  by the browser under a wrong MIME type, and the resulting error does
  not obviously point at the server.
- Wire it through Playwright's `webServer` config so the suite starts
  and stops it automatically.
- `supabase.mjs` exports `createTestTrackable()`, `cleanupTestRows()`,
  and `sweepStaleTestRows()`. **Every delete must be filtered to names
  starting `__test__`** — PostgREST `?name=like.__test__*`. A teardown
  that can match a real row is a data-loss bug, so write it defensively
  and test the filter itself.
- Keys come from `js/config.js` so there is one source of truth.
- Tiers run fast → slow (`unit` → `integration` → `e2e`), failing at the
  first broken tier so a logic bug doesn't cost a full browser run.
- The three smoke tests exist to prove the *harness* works. A tier that
  silently runs zero tests and reports success is the worst possible
  outcome here — assert each tier actually executed something.

**Test Subjects.**

Final result: **122 tests, all green** — unit 113, integration 6, e2e 3.
Runtimes: unit 510ms, integration 931ms, e2e 3.2s.

*Deviations from the plan as written, and why:*

- **`js/config.js` was created here, not in Step 0.3.** This step's notes
  require test credentials to come from `config.js`, but the plan listed
  it as a 0.3 deliverable. Pulled forward; 0.3 now inherits it instead of
  creating it. `js/app.js`, `index.html` and `sw.js` were left untouched,
  so nothing in the deploy path references it yet and `CACHE` was
  correctly *not* bumped.
- **`supabase.mjs` targets `trackables`/`entries` (post-0.2 names) but
  tolerates the table being absent.** `trackables` does not exist until
  Step 0.2, so `sweepStaleTestRows()` and `deleteTestTrackablesByName()`
  return `0` on a missing relation (HTTP 404 / `PGRST205` / `42P01`) and
  `createTestTrackable()` throws with `.code === 'TABLE_MISSING'`. This
  lets the mandatory suite-start sweep be safe to call from day one.
- **Implementer/Test Author file boundary was redrawn for this step
  only.** Normally the Implementer never touches `tests/**`, but here the
  harness *is* the deliverable. Implementer owned `tests/helpers/**` +
  config; Test Author owned `tests/unit|integration|e2e/**`. Neither
  crossed, so tests were still written blind against the contract.

*What was actually tested:*

- **Test-data isolation guard** (`tests/unit/isolation-guard.test.mjs`) —
  `isTestName` accepts only strings starting `__test__`; returns `false`
  without throwing for 20 hostile inputs (`''`, `'__test_'`, `'x__test__y'`,
  `'__TEST__x'` case-sensitivity, `null`, `undefined`, numbers, booleans,
  `{}`, `[]`, `Symbol`, a function, an object whose `toString()` returns
  `'__test__x'`). `assertTestName` throws for every one, message carrying
  both `__test__` and the rejected value. `buildDeleteByNameUrl` throws for
  11 hostile names and never returns a URL for any of them; URL-encoding
  round-trips (`'__test__a b&c=d'` survives as one `name` param — an
  unescaped `&` would truncate the filter and widen the delete).
  **Result: pass.**
- **Static server** (`tests/unit/server.test.mjs`) — full Content-Type map,
  with `.js` → `text/javascript; charset=utf-8` asserted explicitly (a wrong
  MIME here makes every ES module fail to load with an error that does not
  point at the server). `/` serves `index.html` byte-identically;
  query strings stripped; `Cache-Control: no-store` on success and error
  paths; 404 for missing file and for an existing directory (no autoindex);
  `POST` → 405; `HEAD` → 200 with empty body; malformed percent-escape
  → 400; port closed after `close()`. Traversal blocked on 4 vectors — 2
  percent-encoded via `fetch`, 2 literal dot-segment via raw socket.
  **Result: pass.**
- **Live PostgREST connectivity** (`tests/integration/connectivity.test.mjs`)
  — read-only `GET counter?id=eq.1` returns 200 with a numeric value,
  proving credentials + network + PostgREST. `trackables` probe tolerates
  both eras and logged `trackables table ABSENT (pre-Step-0.2 era) — got
  status 404`. `sweepStaleTestRows()` returns a number without throwing.
  `cleanupTestRows(['__test__ok','real_habit'])` rejects **before issuing
  any delete**. `restGet` does not throw on non-2xx. Tier performs zero
  writes and zero deletes of its own. **Result: pass.**
- **Browser smoke** (`tests/e2e/smoke.test.mjs`) — page loads 200 with a
  non-empty title and no uncaught page errors; `/js/app.js` served as
  `text/javascript` end-to-end through Playwright's own webServer; missing
  script 404s. **Result: pass.**
- **Harness self-checks** — `run-tier.mjs nosuchtier` exits 1 with
  `no test files found`; no-argument invocation exits 1 with usage; the
  standalone server CLI (`node tests/helpers/server.mjs 8199`, the exact
  invocation Playwright's `webServer` uses) returns 200 with the correct
  MIME. Tier summary lines verified to match Node's own `pass`/`fail`
  counts. **Result: pass.**

*Bugs found during the fix cycle (one cycle; all now permanent regression
tests):*

1. **`sweepStaleTestRows()` could delete real user data.** The sweep filtered
   with PostgREST `name=like.__test__*`, which becomes SQL `LIKE '__test__%'`
   — and **`_` is a single-character wildcard in SQL `LIKE`**. The pattern
   therefore meant "any 2 chars, then `test`, then any 2 chars, then
   anything", matching ordinary names like `mytestrun`, `AAtestBB`,
   `12test34x`. Since the sweep runs at the start of every suite run against
   the live database, this would have silently and permanently deleted real
   trackables. **This bug originated in the orchestrator's interface
   contract, not in either subagent** — both implemented the wrong spec
   faithfully, which is precisely the class of error blind parallelism
   cannot catch. It was found by the orchestrator reading the diff, and was
   *missed* by the Diagnostician, which read the same file and explicitly
   cleared it as safe.
   **Fix:** all SQL wildcards removed from the sweep. It now GETs
   `?select=id,name`, filters in JS with the exhaustively-tested
   `isTestName()` predicate, dedupes, and deletes each survivor by exact
   name through `buildDeleteByNameUrl()`. `buildSweepUrl()` was deleted
   from the module so the hazard cannot be reintroduced by calling it.
   **Regression test:** the seven strings that matched the old pattern are
   asserted rejected by `isTestName`, and `buildDeleteByNameUrl` asserted
   to throw for each; a separate test asserts `buildSweepUrl` is no longer
   exported. Invariant now holds: exactly **one** DELETE exists in the whole
   module, exact-match `name=eq.<encoded>`, gated by `assertTestName()`.
2. **Tier runner double-counted.** Node fires `test:pass`/`test:fail` for
   `describe` suites as well as leaf tests, so one failing `it()` nested two
   levels deep reported as 3 failures — printed `105 passed, 3 failed`
   against Node's true `94/1`. Exit codes were still correct, but a harness
   whose summary line lies is exactly what this runner exists to prevent.
   **Fix:** skip events where `details.type === 'suite'`, defaulting to
   counting when `details` is absent so the tally can never collapse toward
   zero and defeat the zero-test guard. Verified: runner counts now match
   Node's exactly in both tiers.
3. **A traversal test tested nothing** (`GET /../package.json` returned 200).
   The server was correct; `fetch()`'s WHATWG URL parser collapses `/../`
   client-side, so the request on the wire was plain `GET /package.json` —
   an in-bounds file. The containment guard was never reached. Judged
   **test wrong, code right** (the two percent-encoded siblings already
   passed, proving the guard works).
   **Fix — rewritten, not deleted:** the case now uses a raw `net.Socket`
   with a hand-written request line so the literal dot-segment reaches the
   server, plus a second new vector (`/../../Windows/win.ini`) escaping the
   root entirely. Meaningful traversal coverage went 2 → 4 cases; a comment
   records why it must not be "simplified" back to `fetch()`.

*Not verified here (deferred by design):* `createTestTrackable()` has never
executed successfully against a live table, because `trackables` does not
exist yet. Only its name-assertion and `TABLE_MISSING` paths are covered.
**Step 0.2 must exercise the real create/delete round-trip** once the table
exists — that is the first point at which the teardown path can be proven
end-to-end rather than by construction.

---

## Step 0.1 — Rename repo and Pages URL to "Daily"

**Status:** DONE (2026-08-22)

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

Executed 2026-08-22 after explicit user confirmation (public,
hard-to-reverse action — `ORCHESTRATION.md` §6 requires confirming it
every time, and the user was shown the exact command and the
dead-icon consequence before approving).

- **Repo renamed** — `gh repo rename daily --repo masihbn/memory-test-pwa
  --yes`. The command printed nothing on success, so the rename was
  **verified independently** rather than assumed: `gh repo view
  masihbn/daily` returns `{"name":"daily","visibility":"PUBLIC",
  "url":"https://github.com/masihbn/daily"}`. Still public, which the
  free Pages tier requires. **Result: pass.**
- **Pages config survived** — `gh api repos/masihbn/daily/pages` returns
  `html_url: https://masihbn.github.io/daily/`, `source: {branch: main,
  path: /}`, `status: building`. Branch and path were preserved through
  the rename; no reconfiguration was needed. **Result: pass.**
- **Local remote repointed** — `git remote set-url origin
  https://github.com/masihbn/daily.git`, confirmed by `git remote -v` and
  a real `git fetch origin` that succeeded. Worth doing deliberately:
  GitHub redirects the old URL for git operations, so a stale remote
  keeps working silently and the mistake stays invisible. **Result: pass.**
- **Repo secrets survived** — `gh secret list` shows both `SUPABASE_URL`
  and `SUPABASE_ANON_KEY` still present. **Result: pass.**
- **Keepalive workflow survived** — `gh workflow run
  supabase-keepalive.yml --repo masihbn/daily` accepted. This matters
  disproportionately: if keepalive breaks, the free Supabase project
  auto-pauses about a week later with no other symptom. **Result: pass.**
- **`manifest.json`** — `name`/`short_name` → `"Daily"`; `start_url`
  `"./index.html"` and a newly added `scope: "./"`, both **relative**.
  Pages serves this project from the `/daily/` subpath, so an absolute
  `start_url` of `/` would launch the installed app at the GitHub user
  root and 404. Keeping them relative makes the subpath change a
  non-event. **Result: pass (verified by inspection).**
- **`index.html`** — `<title>` → `Daily`. **`sw.js`** — `CACHE`
  `memtest-v2` → `daily-v3`, required because cached assets changed.
  **Result: pass.**
- **Docs** — `CLAUDE.md` and `docs/PROJECT_NOTES.md` current-state
  references updated to the new repo and URL.
  **Deliberate deviation from this step's deliverable list:** it says to
  update *every* occurrence of the old URL in `PROJECT_NOTES.md`, but
  most remaining occurrences are inside **dated historical test-log
  entries** describing what was verified on 2026-08-21. Those were left
  as written — rewriting them would make the log claim things were tested
  at a URL that did not exist yet, destroying the evidence trail the log
  exists to provide. A dated banner was added at the top of the live-setup
  section explaining the rename and how to read older entries.
  **Result: pass, with the deviation recorded above.**

**Not verifiable from this machine — needs the user's device:** that the
new URL actually serves, that Add to Home Screen works from it, and that
the standalone launch is correct. Deferred to the Phase 0 gate checklist.

---

## Step 0.2 — Migration `0003`: generalize schema to Trackables/Entries

**Status:** DONE (2026-08-22)

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

Applied 2026-08-22 as a single `apply_migration` call (one transaction, so
a mid-way error would have rolled back rather than leaving a half-renamed
database). Suite after this step: **150 tests green** — 113 unit, 34
integration (up from 6), 3 e2e.

Note on sequencing: this step was interrupted by a session limit on
2026-08-21 *after* its tests were written but *before* the migration was
applied. The test file was parked as `schema.test.mjs.pending-step-0.2`
so the tier runner would not discover it and turn the suite red against a
schema that did not exist yet, then renamed back once the migration
landed. The tests were therefore written entirely blind to the
implementation — stronger evidence than the usual parallel run, since
they were authored a day earlier and not touched afterward.

*Verified live by orchestrator introspection (`list_tables` verbose,
`pg_constraint`, `pg_indexes`):*

- Every renamed and added column matches the contract exactly, including
  defaults, check constraints, and column comments.
- **`entries_trackable_id_entry_date_key` — `UNIQUE (trackable_id,
  entry_date)`** confirmed present by name, as both a constraint and its
  backing index. This is the constraint the entire re-log-semantics
  design rests on; it was verified rather than assumed to have survived
  the table rename.
- `counter` untouched — 1 row, original columns, original policy. The
  keepalive workflow depends on it and was separately re-run green after
  the Step 0.1 rename.
- `get_advisors(security)`: **empty**. Notably the known permissive-RLS
  gap did not appear, because permissive policies exist on every table
  including the new `app_settings` — a table with RLS *disabled* would
  have been flagged, which is why enabling it mattered.
- `get_advisors(performance)`: one INFO `unused_index` on
  `entries_trackable_date_idx` — expected on a 0-row table nobody has
  queried yet, not a new gap.

*Verified by the test suite (`tests/integration/schema.test.mjs`, 28
cases):*

- **(A)** `trackables` and `entries` return 200; `skills` and
  `skill_entries` no longer resolve; `counter` still returns its row.
- **(B)** `app_settings` is a correctly seeded singleton — exactly one
  row, `id = 1`, `rolling_window_days = 90`. Never written to by the
  suite: it has no `name` column and therefore no `__test__` guard, so
  its single-row `check (id = 1)` was verified by introspection instead.
- **(C)** create → read back → `cleanupTestRows` → read back empty. **The
  first end-to-end proof that the teardown path actually deletes what it
  claims to** — impossible to test before this step, since `trackables`
  did not exist and only the guard and table-missing paths were covered.
- **(D)** Every column default pinned: `value_shape='boolean'`,
  `relog_semantic='cumulative'`, `aggregation='sum'`, `direction='build'`,
  `target_type='none'`, `bounds_enabled=false`, `bounds_mode='auto'`,
  `sort_order=0`, `archived=false`, and the five nullable columns null.
  Step 2.2's "name and two taps" flow depends on these.
- **(E)** All nine check constraints reject bad values with a 4xx —
  including `target_days: [0]` and `[8]` (invalid ISO weekdays) and
  `bound_lower > bound_upper`; a valid `[1,3,5]` is accepted.
- **(F)** `target_value` accepts `2000.5` and `50000`. The old column was
  `smallint`, which overflows at 32767 — a calorie or step target would
  have silently failed.
- **(G)** A second plain insert for the same `(trackable_id, entry_date)`
  is rejected **409**; the `Prefer: resolution=merge-duplicates` upsert
  succeeds and updates the value. This de-risks Step 1.1, whose core
  operation is exactly that upsert.
- **(H)** Entries cascade on parent delete — two entries, delete the
  trackable, zero entries remain. This is what stops orphaned rows
  accumulating in the live database run after run.
- **(I)** The `updated_at` trigger fires: a re-upsert produces a strictly
  later `updated_at`. `DATA_MODEL.md` previously told the app to set this
  by hand; that footgun is now removed and the doc corrected.
- **(J)** The entry guard rejects a non-`__test__` parent, a null parent,
  and a parent with no name — no network call occurs. Entries have no
  `name` column, so the parent trackable is the only thing that can prove
  an entry is test data.

*Post-run isolation check (orchestrator, direct SQL):* `trackables` 0
rows, `entries` 0 rows, `app_settings` 1 row, `counter` 1 row. No
`__test__` residue and no orphaned entries.

---

## Step 0.3 — App shell: replace the tap counter

**Status:** DONE (2026-08-22)

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

Suite after this step: **212 tests green** — 165 unit, 34 integration,
13 e2e.

**Deviation from the plan's file list:** `parseHash` was split out into a
new `js/router.js` rather than living in `main.js`. `main.js` bootstraps
on import (DOM wiring, service-worker registration), which makes it
unimportable in the Node unit tier. Splitting the pure route parser out
made 32 router cases testable without a browser, which is where the real
routing bugs live. `main.js` remains the entry point and the only file
`index.html` references as a module.

**Pinned CDN versions:** `chart.js@4.5.1` and
`chartjs-plugin-annotation@3.1.0`. Both were verified to resolve (HTTP
200 via HEAD) at implementation time rather than trusted from the example
version written in this plan, per the Architecture decision requiring it.

*Verified by unit tests (`tests/unit/router.test.mjs`, 32 cases):*
- All five named routes plus `''` / `'#'` / `'#/'` → home.
- `#/t/5` → detail with `params.id === '5'` **as a string**, explicitly
  asserted not coerced to a number — a numeric id would break `#/t/:id`
  lookups in Step 2.3.
- Trailing-slash equivalence; `#/t` and `#/t/` → notfound rather than a
  detail view with an empty id; `#/t/5/extra` → notfound.
- Percent-decoded ids; a malformed escape returns notfound instead of
  throwing.
- Case sensitivity; eight non-string inputs each returning notfound
  without throwing; a fresh result object per call.

*Verified by unit tests (`tests/unit/sw-assets.test.mjs`, 20 cases):*
- `CACHE` is exactly `daily-v4` and matches `/^daily-v\d+$/`.
- **The high-value guard:** every `.js` file actually present in `js/` is
  enumerated from disk and asserted to appear in `sw.js`. Forgetting the
  cache list when adding a module is the most-repeated gotcha in
  `PROJECT_NOTES.md`, and it only ever surfaces as an installed phone
  silently serving a stale app.
- Every jsDelivr URL in `index.html` also appears in `sw.js` — otherwise
  charts work online and vanish offline.
- No floating CDN version: each extracted URL must carry an explicit
  `@x.y.z` pin. Version *numbers* are deliberately not hardcoded so the
  test does not need editing when they are bumped.
- `js/app.js` is absent from disk, from `index.html`, and from `sw.js`.

*Verified by e2e (`tests/e2e/shell.test.mjs`, 10 cases):* page loads with
title `Daily` and no uncaught errors; `#app` carries the right
`data-route` for home / settings / compare / new / detail / notfound;
`#/t/42` shows the id; `#/nope` renders a real notfound view **without
silently redirecting** (the hash stays `#/nope`); clicking a nav link
re-routes **without a full page reload**, proven by a `window` sentinel
surviving the click; `aria-current="page"` marks only the active link;
`window.Chart` is defined, proving the pinned UMD script executed; and
the fixed bottom nav's bounding box sits inside the 390×844 viewport —
a nav rendered under the home indicator is a real iPhone failure mode.

*Fix cycle — three failures, judged individually:*
1. **`parseHash('/settings')` returned `settings`.** Code wrong: the
   leading `#` was optional, so a History-API-style path appeared to
   route correctly. That is actively misleading in a hash-routed app
   where such a URL 404s on refresh from Pages. Fixed to require `#`.
2. **`GET /js/app.js` expected 200.** Test wrong — a *stale fixture*, not
   a real defect. That assertion was written in Step 0.0 when `app.js`
   was the only JS file; this step correctly deleted it. The property
   (`.js` served as `text/javascript`) still matters, so the fixture was
   repointed at `js/main.js` rather than the case being deleted. This
   recurred in `tests/e2e/smoke.test.mjs`, which the first fix pass
   missed — an orchestrator scoping error, fixed the same way.
3. **`index.html` contains `@latest`.** Test wrong, and *too crude*: the
   only match was inside a comment explaining why `@latest` is avoided.
   Replaced with a URL-level check that extracts each jsDelivr URL and
   requires an explicit `@x.y.z` pin — **strictly stronger**, since the
   old substring check would have passed a floating `chart.js@4` range,
   which is the actual hazard.

*Deferred, deliberately:* `sw.js`'s CDN caching does `cache.put(url, res)`
without checking `res.ok`, so a CDN error response would be cached and
then served offline. The pinned URLs return 200 today, and **Step 5.1 is
the dedicated service-worker pass** — recorded there rather than fixed
mid-step.

**Not verifiable from this machine:** Safari's service-worker behavior,
Add to Home Screen, standalone launch, and how the safe-area padding
actually renders on the physical device. Deferred to the Phase 0 gate.

---

## ⛔ PHASE 0 GATE — hard stop

Full suite green, pushed, Pages live. Hand the user a manual checklist:
the renamed URL loads, Add to Home Screen works from the **new** URL
(the old icon is dead and must be deleted), and the app shell renders
with working navigation. **Wait for their verdict before Phase 1.**

**PASSED — 2026-08-22, verified on the user's iPhone.**

The new URL loads; nav swaps views with no reload; taps feel immediate;
`#/nope` renders a real not-found view without redirecting; Add to Home
Screen, standalone launch and the icon all work from the new URL; the
shell still opens in Airplane Mode.

Two layout bugs were found on the device, both invisible to the suite,
and both fixed before Phase 1 began:

1. **Header overlapped the status bar** — no `env(safe-area-inset-top)`
   was applied. Fixed with padding (not margin) so the header background
   still paints through the inset.
2. **A 59pt strip of bare screen below the nav in standalone mode.**
   This took three attempts and the first two fixes were wrong, so the
   sequence is recorded in `PROJECT_NOTES.md` → Attempt 6 as a lesson.
   Root cause: `apple-mobile-web-app-status-bar-style="black-translucent"`
   makes iOS position the web view at the physical top but size it as
   `screenHeight - statusBarHeight`, so the deficit falls off the bottom,
   **outside the view** — no CSS could ever paint it. Changed to
   `"black"`. Confirmed by on-device measurement, not inference:
   `screen.height 852` vs `innerHeight 793` (= the 59pt
   `safe-area-inset-top`), with `innerHeight - nav.bottom = 0.0` proving
   the nav had been flush all along.

**The transferable lesson:** for standalone-only iOS layout bugs,
**instrument before theorising.** Playwright emulates neither standalone
display mode nor safe-area insets, so `env()` evaluates to `0` and the
e2e "nav is inside the viewport" test passed happily on broken markup.
A temporary diagnostic readout produced the answer in one screenshot
after two wrong remote diagnoses had already shipped.

Cache versions this phase: `memtest-v2` → `daily-v9`, every bump forced
by a real cached-asset change.

---

# PHASE 1 — Data layer

## Step 1.1 — PostgREST client (`api.js`) + offline store (`store.js`)

**Status:** DONE (2026-08-22)

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

Suite after this step: **429 tests green** — 373 unit, 43 integration, 13
e2e (up from 221 at the Phase 0 close). New this step: 159 unit cases for
`api.js`, 40 unit cases for `store.js`, 9 integration cases against the
live database. `sw.js` `CACHE` bumped `daily-v9` → `daily-v10` with
`./js/api.js` and `./js/store.js` added to `ASSETS`.

The outbox was kept in this step rather than split out, as the plan
permitted. It is the part of `store.js` most likely to lose data, so it
got the heaviest test coverage.

*Contract decisions made here that the plan did not settle, recorded so a
later step does not re-litigate them:*

- **Three typed error classes, distinguished by a `retryable` flag** —
  `ValidationError` (thrown before any network call), `NetworkError`
  (`fetch` itself rejected), `ApiError` (non-2xx, carrying the PostgREST
  `message`/`code`/`details`/`hint`). The store queues a write only when
  `isRetryable(err)`. Without that split the outbox would either retry a
  permanently-rejected 400 forever or drop a recoverable offline write.
  `retryable` is `status >= 500 || 408 || 429`.
- **`assertValidEntry()` is shared by `api.js` and `store.js`** and
  rejects any key outside `trackable_id`/`entry_date`/`value`/`note`.
  This turns the `updated_at` footgun (the column is owned by a database
  trigger, per `DATA_MODEL.md`) into a hard validation failure rather
  than a comment nobody reads.
- **Dependency injection: `createStore({ api, storage, now })`**, with
  `getStore()` as the app-facing singleton. A module-level `localStorage`
  reference would have made the store untestable in the fast unit tier,
  since Node has no `localStorage` — which is where the plan wants
  coverage concentrated.
- **Reconnect rule made explicit:** on a successful entry load the server
  is authoritative **for the requested window only**, and pending outbox
  ops are then re-applied on top. Without the overlay an offline log
  visibly vanishes on reconnect; without the window scoping, loading one
  month would wipe cached data for every other month.
- **Outbox dedupe replaces in place, preserving queue position** — at
  most one pending op per `(trackable_id, entry_date)`, with ordering
  between different days left stable.

*Verified by unit tests (`tests/unit/api.test.mjs`, 159 cases), against a
stubbed `globalThis.fetch` that records method/URL/headers/body:*

- Every one of the nine functions issues the exact method and full URL,
  including query-parameter order, and sends `apikey` + `Authorization` +
  `Accept`. GET requests are asserted **not** to send `Content-Type`.
- **`upsertEntry` sends `on_conflict=trackable_id,entry_date` with
  `Prefer: resolution=merge-duplicates,return=representation`** — the
  single line the whole re-log design rests on; without it, re-logging a
  day 409s against the unique constraint.
- `updated_at`, `id`, `created_at` and any unknown key in an entry
  payload throw `ValidationError` with **zero** fetches issued (call
  count asserted, not just the throw).
- `deleteEntry` always carries both `trackable_id=eq.` and
  `entry_date=eq.`; a missing or hostile argument throws with zero
  fetches, fuzzed across `null`/`''`/`0`/`-1`/`1.5`/`'*'`/`'eq.1'`/
  `'1;drop table'`/`'1,2'`/`{}`/`[]`/`true`. Returns `0` rather than
  throwing when nothing matched.
- **`listEntries({trackableIds: []})` throws** — an empty id list must
  never degrade into an unfiltered query over the whole table. Injection-
  shaped ids (`'1)'`, `'1,2'`, `'*'`) and `from > to` likewise throw.
- Error mapping: a 400 with a PostgREST JSON body carries all four
  fields and `retryable === false`; 500/408/429 are retryable; a non-JSON
  error body (an HTML 502 page) lands in `.body` as raw text without
  throwing while the error is built; a `fetch` rejection becomes a
  `NetworkError` preserving `.cause`; a missing `globalThis.fetch` gives
  a `NetworkError`, not a `TypeError`.
- **Structural guard:** `js/api.js` is read from disk and asserted to
  contain exactly one `'DELETE'` request method. This mirrors the guard
  that caught the Step 0.0 data-loss bug; a comment records that it must
  not be "simplified" away.

*Verified by unit tests (`tests/unit/store.test.mjs`, 40 cases):*

- **Cache never overwrites server:** cache seeded with `value: 5`, server
  returns `9` for the same day → the store reads `9` after the load.
- A cached entry inside the loaded window that the server omits is
  dropped; one **outside** the window survives.
- **A pending outbox op survives a network reload** and stays marked
  `pending` even when the server response lacks it.
- The three save outcomes: success → `saved`, server row cached, outbox
  emptied; retryable failure → `queued`, optimistic value kept with
  `pending: true`; non-retryable 400 → `failed`, cache **reverted**, and
  where no prior entry existed the row is absent afterward rather than
  left as a ghost. Invalid input throws and mutates nothing.
- `flushOutbox` replays FIFO, **stops dead at the first retryable
  failure** (call count asserted, remaining ops left in order), and drops
  a non-retryable op before continuing.
- Hydration is defensive: corrupt JSON, a `v: 2` payload, and a bare JSON
  array are each discarded with the bad key removed; a `storage` whose
  `getItem`/`setItem` always throw (iOS Safari private mode) leaves the
  store fully functional in memory.

*Verified by integration tests (`tests/integration/api.test.mjs`, 9 cases,
against the live database):*

- Full trackable lifecycle: create → list → update → archive, with
  `listTrackables()` excluding the archived row and
  `{includeArchived: true}` including it.
- **Upsert round-trip:** a second call for the same
  `(trackable_id, entry_date)` updates instead of 409-ing, and
  `updated_at` advances strictly — proving the database trigger fires and
  that the client is correctly *not* sending that column.
- Inclusive-both-ends range filtering across seeded boundary rows;
  cross-trackable scoping; `deleteEntry` returning `1` then `0`.
- Error mapping proven against the real server, not a stub: an FK
  violation and a check-constraint violation both surface as `ApiError`
  with a real PostgREST code, 4xx status, and `retryable === false`.
- **`app_settings` has no `name` column and therefore no `__test__`
  guard**, so `updateSettings` is exercised as a read-modify-write with
  **no net change** — read `rolling_window_days` into `V`, write `V`
  back, assert it is still `V`. A comment in the test records that no
  other value may ever be written to that table.

*Bug found by the orchestrator reading the diff, now a permanent
regression test:*

**A satisfied outbox op was dropped from memory but never from storage.**
`dequeueByKey()` reassigned the in-memory `outbox`, but both call sites
(`saveEntry` and `removeEntry` success paths) called only
`persistCache()`, never `persistOutbox()`. Failure sequence: log a value
offline → op queued *and persisted*; later save a newer value
successfully → in-memory outbox cleared, `localStorage` outbox still
holding the stale op; relaunch the app → `hydrate()` reads it back;
`flushOutbox()` replays it and **overwrites the newer server value with
the stale one.** That is a cached value clobbering a server value — the
exact invariant `store.js`'s header comment forbids.

**Fix:** `dequeueByKey()` now calls `persistOutbox()` itself, so no
future call site can forget, with a comment recording why the line must
not be hoisted back out to the callers.

**The regression test was verified to actually catch it**, not merely to
pass: the fix was temporarily reverted, both new cases failed, and the
file was restored. Notably **no other test in the 429-case suite failed**
during that revert — the bug was invisible to everything else, which is
why it needed a dedicated test asserting on the *persisted* payload
rather than on `store.getOutbox()`. An in-memory-only assertion passes
under the buggy code, because the bug is precisely that memory and
storage disagree.

*One fix cycle, judged individually:*

1. **`removeEntry` queued a delete op whose `trackable_id` was a string**
   (`'1'`), because it built the payload from `assertId()`'s return
   value, while an upsert op for the same id queued a number. **This was
   an orchestrator contract gap, not a subagent error** — the contract
   pinned upsert payloads to "preserved as given" and said nothing about
   delete payloads, so both agents implemented an under-specified spec
   faithfully. Same class of error as the Step 0.0 wildcard bug.
   Judged **code wrong, test right**: sibling op types disagreeing about
   the type of the same field is a latent bug generator, since any future
   `op.payload.trackable_id === row.trackable_id` comparison would work
   for upserts and silently fail for deletes. Fixed by preserving the raw
   argument in the delete payload; validation behavior unchanged.

*Post-run isolation check (orchestrator, direct SQL):* `trackables` 0
rows, `entries` 0 rows, `app_settings` 1 row still at
`rolling_window_days = 90` (the no-op write left it untouched), `counter`
1 row (keepalive intact). No `__test__` residue.

*Not wired into the UI yet, deliberately:* neither module is imported by
`js/main.js` — they are consumed starting at Step 2.1. They are in
`sw.js`'s `ASSETS` so an installed phone caches them ahead of that.

---

## Step 1.2 — `dates.js` and `aggregate.js` (pure logic)

**Status:** DONE (2026-08-22)

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

Suite after this step: **635 tests green** — 579 unit, 43 integration, 13
e2e (up from 429 after Step 1.1). New this step: 109 unit cases for
`dates.js`, 42 for the timezone tier, 55 for `aggregate.js`. `sw.js`
`CACHE` bumped `daily-v10` → `daily-v11`.

**Zero fix cycles.** Both agents converged on the contract exactly, with
no fixture disagreements in either direction. That is attributable to the
fixtures below being computed rather than asserted from memory — see the
note on method.

*Method note, worth repeating on future steps:* every ISO-week,
month-grid and percentile expectation in the contract was **computed and
cross-checked before the contract was written**, not recalled. A wrong
expected value in an orchestrator's contract becomes a wrong test that
both agents implement faithfully — which is precisely how the Step 0.0
wildcard bug and the Step 1.1 payload-type mismatch happened. Both agents
were also explicitly instructed that if their own reasoning disagreed
with a fixture they must report it rather than silently "fix" it. Neither
needed to. The ISO fixtures were additionally sanity-checked against
independent anchors: 2026-01-01 is a Thursday, so its ISO week is
2026-W01 starting Mon 2025-12-29; 2015, 2020 and 2026 are 53-week ISO
years.

*Additions beyond the plan's "at minimum" list, and why:*

- **`startOfIsoWeek()` and `isoWeeksInRange()`** in `dates.js`. Step 3.2
  requires zero-entry weeks to render as explicit gaps rather than
  vanishing, which needs the weeks that *should* exist to be
  enumerable. The plan also forbids hand-rolling week math per chart, so
  this belongs here rather than in each chart module.
- **`fillSeries(buckets, keys, fillValue)`** in `aggregate.js` — the
  other half of that requirement. `rollup` deliberately does *not*
  invent empty buckets; `fillSeries` projects real buckets onto a
  complete key list, with `fillValue: null` for a true gap rather than a
  misleading zero.
- **`formatLocal()`** exported alongside `todayLocal()`, since
  `todayLocal` is just `formatLocal(now)` and the inverse of
  `parseLocal` is needed throughout.

*Contract decisions made here:*

- **`todayLocal(now = new Date())` takes an injectable clock.** Without
  the parameter the function is untestable deterministically, and this is
  the single function where the date trap bites hardest.
- **`monthGrid(year, month)` is 1-based** (1 = January), deliberately
  diverging from JS's 0-based `getMonth()`. The whole app speaks
  `'YYYY-MM-DD'`, where the month is 1-based; a 0-based parameter here
  would be a permanent off-by-one source. Documented loudly in the
  module.
- **`parseLocal` rejects dates that do not exist** instead of letting JS
  roll them over. `new Date(2026, 1, 30)` silently becomes March 2, so
  the constructed date's components are verified against the input.
- **Percentile pinned to the "R-7" / Excel `PERCENTILE.INC`
  definition** with worked examples in the contract. "10th percentile" is
  ambiguous across at least nine standard definitions; leaving it
  unpinned would have guaranteed a divergence.
- **`deriveBounds`'s `asOf` defaults to the latest `entry_date` in the
  data, not the real current date** — that is what keeps the function
  pure and its tests deterministic.
- **`rollup`'s per-bucket `count` field is the raw entry count, while
  `count`/`average` *aggregation* divide by distinct logged days.** These
  can differ, and the contract did not spell out that they were two
  separate counters; the implementer resolved it as the only reading
  consistent with all three requirements, and the test author
  independently agreed. Recorded here because it is a genuine ambiguity a
  later reader could trip on.

*Verified by unit tests (`tests/unit/dates.test.mjs`, 109 cases):*

- **Every row of the ISO-week fixture table asserted individually**,
  including the year-boundary traps where the ISO week year differs from
  the calendar year: `'2025-12-29'` → `'2026-W01'`, `'2027-01-03'` →
  `'2026-W53'`, `'2021-01-01'` → `'2020-W53'`, `'2016-01-01'` →
  `'2015-W53'`. Getting these wrong silently merges or splits New Year
  weeks. Also asserted that a `Date` and its `'YYYY-MM-DD'` string give
  the same key.
- `parseLocal` rejects `'2026-02-30'`, `'2026-13-01'`, `'2026-00-10'`,
  `'2026-01-00'`, `'2026-01-32'` and `'2026-02-29'` (2026 is not a leap
  year) while accepting `'2024-02-29'`; and rejects malformed shapes
  (`'2026-1-1'`, `'26-01-01'`, `'2026/01/01'`, `''`, `null`, a number, a
  `Date`). Returned dates assert all four time components are zero.
- `addDays` across month, year and leap-day boundaries, `n = 0`, and
  ±400.
- **Every row of the `monthGrid` fixture table** — first cell, last cell,
  `inMonth` count, index of the first in-month cell — plus, per month:
  exactly 42 cells, `dow` starting at 1 (Monday) and cycling 1..7, dates
  consecutive with no gaps, and the `inMonth` cells being exactly that
  month's days. Includes February 2021, which **begins on a Monday** and
  therefore has no leading days at all — the case a naive implementation
  special-cases wrongly.
- `isoWeeksInRange` across the year boundary
  (`'2026-12-21'`..`'2027-01-11'` → `['2026-W52','2026-W53','2027-W01','2027-W02']`),
  and a full-year range asserted to be strictly ascending with no
  duplicates and no gaps.

*Verified by the timezone tier (`tests/unit/dates-tz.test.mjs`, 42
cases) — the highest-value file in this step:*

Each case runs in a **child Node process with `TZ` forced at process
start**, across `UTC`, `America/Toronto`, `Pacific/Kiritimati` (UTC+14),
`Pacific/Pago_Pago` (UTC-11), `Asia/Kolkata` (UTC+05:30) and
`Australia/Lord_Howe` (a 30-minute DST shift). Failures are tagged with
the zone. Covered per zone: `todayLocal` at local 23:30 and 00:30 landing
on the correct day, `parseLocal`→`formatLocal` round-tripping without a
shift, `isoWeekKey` being zone-independent, `rangeDays` returning exactly
5 consecutive days across both 2026 `America/Toronto` DST transitions
(spring-forward 2026-03-08 and fall-back 2026-11-01), and `addDays`
straddling spring-forward.

**This tier was verified to actually catch the trap, not merely to
pass.** The orchestrator temporarily replaced `todayLocal` with the
forbidden `new Date().toISOString().slice(0,10)`: `TZ=UTC` passed (as it
must — the naive version is correct there, which is exactly why this bug
survives on a developer machine), while **all five non-UTC zones failed**,
and the failure direction confirmed the real mechanism — negative-offset
zones failed the 23:30 case by rolling forward to tomorrow, positive-
offset zones failed the 00:30 case by rolling back to yesterday.
Separately, replacing `parseLocal`'s component construction with
`new Date(str)` (UTC-midnight parsing) failed every non-UTC zone. The
file was restored from backup and the full suite re-run green after each
probe.

*Verified by unit tests (`tests/unit/aggregate.test.mjs`, 55 cases):*

- **`rollup` by week merges two entries from different calendar years
  into one ISO-week bucket** (2025-12-31 and 2026-01-01 are both
  `2026-W01`) — asserted to land in a single bucket.
- **`count` vs `sum` asserted against the same data**: values `5` and `3`
  yield `count = 2` and `sum = 8`. Conflating these is the easiest
  mistake in the module.
- **`average` divides by days-with-an-entry, not by 7**: `2000` and
  `2400` in one week average `2200`, not `628.57` — the "starvation week"
  bug the plan calls out.
- `last` picks the latest `entry_date` from deliberately shuffled input
  (not the last array element), with same-date ties going to the later
  element; buckets return sorted ascending from shuffled input; entries
  with `null`/`undefined`/`NaN`/`Infinity`/string values are ignored and
  do not inflate `count`; no empty buckets are invented between two
  distant entries; unknown period and aggregation each throw.
- **`normalizeSeries` `min === max` guard**: both a flat multi-element
  series and a single-element series return `50` for every element, with
  `Number.isNaN` explicitly asserted false on every output. Non-finite
  entries become `null` while output length is preserved so indices stay
  aligned with their labels.
- **`deriveBounds` percentile against the three worked examples**
  (`[1..10]` → 1.9 / 9.1; `[70..80]` → 71 / 79; `[2,4]` → 2.2 / 3.8) at
  ≤1e-9 tolerance; values outside the rolling window excluded even when
  seeded to visibly move the bounds; `asOf` defaulting to the latest
  entry date rather than today; `{lower: null, upper: null}` for zero
  entries and for a single finite value; `minmax` mode; unknown method
  throws; `lower <= upper` holds.
- **`applyRelog`, all three semantics exhaustively** — boolean idempotent
  (`(1,1)`, `(null,1)`, `(1,0)`, `(1,undefined)` all → `1`); numeric
  cumulative adding (`320 + 500 = 820`, with null/undefined/NaN existing
  treated as `0`, plus negatives and decimals); numeric state replacing
  (`78.4` → `79.1`). Plus every error path: non-finite `newValue`,
  missing/non-object trackable, unknown `value_shape`, unknown
  `relog_semantic`.

*Not wired into the UI yet, deliberately:* like Step 1.1's modules,
neither file is imported by `js/main.js`. They are consumed from Phase 2
onward, and are in `sw.js`'s `ASSETS` so an installed phone caches them
ahead of that.

---

## ⛔ PHASE 1 GATE — hard stop

Mostly invisible to the user (no UI yet), so the gate is evidence-based
rather than tap-based: show the unit test results for `dates.js` /
`aggregate.js` — especially the ISO-week year boundary, the three re-log
semantics, and the `min === max` normalization guard — plus a
demonstrated round-trip write to Supabase. **Wait before Phase 2.**

**PASSED — 2026-08-22.** Suite 635 green. Evidence presented: every
ISO-week year-boundary fixture (`2025-12-29` → `2026-W01`, `2027-01-03` →
`2026-W53`, `2021-01-01` → `2020-W53`, `2016-01-01` → `2015-W53`), all
three re-log semantics, `normalizeSeries([5,5,5])` → `[50,50,50]` with
`Number.isNaN` asserted false, and a live round-trip through the real
`api.js`/`aggregate.js`: logged 320 kcal, re-logged with
`applyRelog(320, 500, cumulative)` → 820, upsert **edited the existing
row** (same id, no unique-constraint error) with `updated_at` advanced by
the DB trigger; a boolean re-logged twice stayed `1`;
`rollup(week, count)` → `[{key:'2026-W34', value:3, count:3}]`; teardown
left 0 `__test__` rows.

The timezone tier was additionally verified **adversarially**: reverting
`todayLocal` to `toISOString().slice(0,10)` passed under `TZ=UTC` and
failed all five other zones, and reverting `parseLocal` to
`new Date(str)` failed every non-UTC zone. Both were restored and the
suite re-run green.

**Caveat carried into Phase 2:** none of the four Phase 1 modules has
ever run in a browser — only in Node. The e2e tests load `index.html`,
which does not import them. Step 2.1 is their first execution in Mobile
Safari.

---

# PHASE 2 — Core UI

## Step 2.1 — Home: trackable list + quick-log

**Status:** DONE (2026-08-22)

> **⚠ EXTRA DEPLOY CHECKPOINT AT THE END OF THIS STEP (user decision,
> 2026-08-22).** Normally the protocol says keep moving within a phase
> and only stop at the Phase 2 gate. The user explicitly asked to stop
> after **this step**: finish 2.1, run the full suite, commit, **push**,
> and hand them a manual test script for their phone — then wait for
> their verdict before starting 2.2.
>
> Reason: 2.1 is the screen they use daily, and it is the first time the
> Phase 1 data layer runs in a browser at all. If `store.js`'s
> `localStorage` handling or `dates.js`'s local-date logic misbehaves on
> iOS, that should surface with one step of work on top of it, not
> three. This does **not** replace the Phase 2 gate, which still applies
> after 2.3.

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

Suite after this step: **770 tests green** — 698 unit, 43 integration, 29
e2e (up from 635 at the Phase 1 close). New this step: 119 unit cases for
`home-model.js`, 16 e2e cases for the home view. `sw.js` `CACHE` bumped
`daily-v11` → `daily-v12` with `./js/views/home.js` and
`./js/views/home-model.js` added to `ASSETS`.

**Deviation from the plan's file list:** the pure logic was split into a
new `js/views/home-model.js`, leaving `js/views/home.js` as DOM + store
wiring only. Same rationale as the `router.js` split in Step 0.3 —
`home.js` cannot be imported headlessly (it touches `document`), so
without the split every formatting, parsing and re-log-dispatch rule would
have been testable only through a browser. The split moved 119 cases into
the fast tier, which is where `ORCHESTRATION.md` §5 wants coverage
concentrated.

*Contract decisions made here that the plan did not settle:*

- **Clearing a boolean day is a DELETE (`store.removeEntry`), never
  `saveEntry({value: 0})`.** `applyRelog`'s header comment in
  `aggregate.js` explicitly forbids an un-toggle path through it, and a
  stored `0` would be a real logged row that inflates every `count`
  rollup downstream. E5 asserts a DELETE with both filters and **zero**
  POSTs.
- **Refresh order is `loadTrackables` → `flushOutbox` → `loadEntries`,
  pinned as non-reorderable.** Reading today's state before flushing lets
  a stale server read mask a write that is still sitting in the outbox.
- **The view always passes the raw `trackable.id` to the store**, looked
  up through a `Map<String(id), trackable>`, never the string parsed out
  of `data-trackable-id`. Step 1.1 recorded a real bug caused by upsert
  and delete payloads disagreeing about the type of the same id.
- **The numeric input is `type="text"` + `inputmode="decimal"`, not
  `type="number"`.** `inputmode` is what raises the iOS numeric keypad,
  and `type="number"` would discard a decimal comma before
  `parseNumericInput` ever saw it. A comment in `home.js` records this so
  it is not "fixed" later.
- **`parseNumericInput` accepts a single decimal comma** (some iOS locale
  keypads emit `,`), but rejects a string containing both `,` and `.`, or
  more than one `,`, rather than guessing a thousands separator.

*Method note:* every worked example in the interface contract — the
`toFixed(2)`-then-trim table, all 23 `parseNumericInput` fixtures, and the
cumulative-add cases — was **computed and cross-checked before the
contract was written**, not recalled. The decimal add case was chosen as
`1.5 + 2.25 = 3.75` specifically because both operands are dyadic
rationals, so the assertion cannot be perturbed by float error. Both
agents were told to report rather than silently "fix" any fixture they
disagreed with; neither needed to, and the step took **zero fix cycles
from the contract itself**.

*Verified by unit tests (`tests/unit/home-model.test.mjs`, 119 cases):*

- Every worked example in the contract asserted individually across
  `visibleTrackables`, `formatValue`, `relogHint`, `parseNumericInput`,
  `nextValueFor` and `rowModel`.
- `visibleTrackables` drops archived rows, sorts by `(sort_order, id)`
  with a missing `sort_order` treated as `0`, and is asserted **not to
  mutate its input** — it returns a new array holding the same element
  references.
- **`parseNumericInput` never returns a non-finite number**, asserted as
  `Number.isFinite(result) || result === null` across the whole fixture
  table. `'1e3'`, `'Infinity'`, `'NaN'`, `'+5'`, `'0x10'`, `'1.2.3'` and
  `'1,2,3'` all return `null`.
- **`nextValueFor` delegates to `applyRelog` rather than reimplementing
  it**: cumulative `320 + 500 = 820`, state `78.4 → 79.1`, boolean
  idempotent at `1` for `(null, undefined)`, `({value:1}, undefined)` and
  `({value:0}, undefined)`.
- The `has` predicate distinguishes shapes correctly: a numeric `{value:0}`
  counts as logged (logging 0 kcal is a real log) while a boolean
  `{value:0}` does not.
- Hostile-input sweeps (`null, undefined, 0, '', [], {}, true, NaN` in
  each position) prove `formatValue` / `relogHint` / `rowModel` never
  throw.

*Verified by e2e (`tests/e2e/home.test.mjs`, 16 cases) — the first time
any Phase 1 module has ever executed in a browser:*

Every PostgREST call is intercepted with `page.route`, so the tier makes
**zero real Supabase calls**. That is asserted, not assumed: a catch-all
`**/rest/v1/**` guard is registered *first* (lowest Playwright priority),
records and aborts anything the narrow fixtures do not claim, and every
test ends with `expect(unexpected).toEqual([])`.

**`test.use({ serviceWorkers: 'block' })` is mandatory in this file and
must not be removed.** `sw.js` installs a `fetch` handler that proxies
requests, and requests originating inside a service worker are invisible
to `page.route()`. Without blocking it the fixtures silently stop
applying and the tests hit the **live** database — a failure mode that
leaves the suite green while testing nothing.

- E1 empty state → `data-home-state="empty"`, an `a[href="#/new"]`, no list.
- E2 rows sorted `1,2,3` from deliberately shuffled input, archived row absent.
- E3 boolean unlogged: `—`, `Tap to log today`, `aria-pressed="false"`.
- **E4 the tap feels instant**: the POST is delayed ~400ms and the row is
  asserted `data-logged="true"` / `data-state="pending"` *while the
  request is still open*, then `idle` / `Done` after. The POST is asserted
  to carry `on_conflict=trackable_id,entry_date`, the
  `resolution=merge-duplicates,return=representation` Prefer header, and a
  body deep-equal to `{trackable_id:1, entry_date:TODAY, value:1}`.
- **E5 un-toggle is a DELETE, not a zero-save** — one DELETE carrying both
  `trackable_id=eq.1` and `entry_date=eq.<today>`, and zero POSTs.
- E6 cumulative adds: `320 kcal` + typed `500` posts `820`, not `500`.
- E7 state replaces: `78.4` + typed `79.1` posts `79.1`, **not** `157.5`.
- E8 invalid input `abc` → zero requests, editor stays open with the text
  intact, `.trow-error` reads `Enter a number`, row is **not** `failed`.
- **E9 offline outbox (highest-value case in the step)** — a 503 leaves
  the row `pending` with the optimistic value, and
  `localStorage['daily.outbox.v1']` is asserted to hold exactly one op
  keyed `1|<today>` with the right payload. Asserted on the **persisted**
  payload, not in-memory state, for the same reason as the Step 1.1
  regression test: the dangerous bug is memory and storage disagreeing.
- E10 a 400 reverts the row to its pre-tap value, shows
  `.trow-error[role=alert]`, and leaves the outbox empty.
- E11 offline read: cache pre-seeded, trackables GET aborted → the row
  still renders and `p.home-offline` appears.
- E12 no listener leak across `#/` → `#/settings` → `#/`: exactly one
  `section.home`, and one tap issues exactly one POST.
- E13 an open editor survives a re-render triggered by another row, draft
  text preserved.
- E14 no uncaught page errors; `documentElement.scrollWidth <= 390`.
- E15 every `.trow-log` is ≥44px tall.

*Bug found by the orchestrator reading the diff, now a permanent
regression test:*

**A superseded async render could clobber the nav.** `render()` became
`async` in this step (it awaits the home view's `mount()`, which performs
network round trips), but `updateNav(route.name)` still ran at the *end*
of the function, after that await. Sequence: tap Home → `render#1`
suspends at `await mount()`; tap Settings before it resolves →
`render#2` runs start-to-finish and correctly marks the Settings nav link
`aria-current="page"`; `render#1` then resumes and calls
`updateNav('home')`. Result: the Settings screen is displayed and
`#app[data-route]` is correct, but the bottom nav highlights **Home**.
Reachable on a real phone on a slow connection, which is the target
device. The bug did not exist before this step — the old `render()` was
synchronous.

**Fix:** `updateNav(route.name)` moved up to run synchronously alongside
`app.setAttribute('data-route', ...)`, before the await, so nav updates
happen in trigger order and the last render to start wins the nav too.
A comment records why it must not be moved back.

**The regression test was verified to actually catch it**, not merely to
pass: the fix was temporarily reverted and the `NAV-RACE` case failed,
with the failure confirming the exact mechanism — the Settings link ended
up with **no** `aria-current` at all, because the stale render had
stripped it and moved it to Home. `main.js` was then restored and the
full suite re-run green. This mattered because the test was written
*after* the fix landed and had only ever been observed passing; an
unverified regression test is decoration.

The test's wait is deliberately not an immediate assertion — Playwright's
`toHaveAttribute` retries until it passes, so asserting too early would
catch the transient *correct* state and pass against broken code. It
waits for the delayed response to be served, then lets the superseded
render resume, then asserts. A comment records this so it is not
"simplified" into a false-passing test.

*Not verifiable from this machine — needs the user's device:* how the
list renders at real iPhone width, whether `inputmode="decimal"` actually
raises the numeric keypad in Mobile Safari, whether `localStorage`
survives iOS storage pressure and PWA backgrounding, and whether the
outbox behaves on a genuinely flaky connection rather than a mocked 503.
Deferred to the extra deploy checkpoint this step carries.

**DEPLOY CHECKPOINT PASSED — 2026-08-22, verified on the user's iPhone.**

Three real trackables were seeded first, with the user's explicit
approval, because the create form is Step 2.2 and the screen was
otherwise empty: `Workout` (boolean), `Calories` (numeric/cumulative,
kcal), `Weight` (numeric/state, kg) — ids 365–367. Real user rows, not
`__test__` fixtures, so the suite's sweep cannot delete them.

**REVISED by Step 2.1b (2026-08-22), after the user used it.** Two
product changes came out of the device session, both recorded in
`APP_CONCEPT.md`: additive re-logging was removed (migration `0004` —
numerics now replace), and the home screen now uses the `direction`
column it had been ignoring, so good vs. bad is visible. Governing rule:
**a green check means "today is good", not "logged"** — an unlogged
`break` habit shows the green check, which is deliberate. Suite after
2.1b: **882 green** (802 unit, 43 integration, 37 e2e). `sw.js` `CACHE`
`daily-v12` → `daily-v13`. New home-model exports: `verdict`,
`statusWord`, `statusSymbol`, `directionLabel`. Key regression guards:
E/V6 asserts a numeric re-log posts `500`, **not** `2500`, and a unit
case asserts two `relogHint` inputs differing only in `relog_semantic`
produce byte-identical strings — proving additive wording is genuinely
gone rather than merely defaulted away.

All four device-only unknowns above came back clean: the keypad is
numeric rather than QWERTY, cumulative added (320 → 500 → **820**), state
replaced (78.4 → 79.1 → **79.1**, not 157.5), and **an Airplane-Mode log
survived a force-quit and reconnect** — the first real-world proof the
outbox works on iOS rather than against a mocked 503. The nav-race fix
also held on device. No new bugs found. Full write-up in
`PROJECT_NOTES.md` → Attempt 7.

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

## ⛔ PHASE 2 GATE — hard stop

**The most important gate — this is the first time the app is actually
usable.** Ask the user to create one real trackable of each shape (a
boolean like "workout", a numeric like "weight"), log both from their
phone, re-log the same day to confirm the cumulative/state behavior
reads correctly, and edit a past day. Their feel for the quick-log flow
matters more here than any test result. **Wait before Phase 3.**

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

## ⛔ PHASE 3 GATE — hard stop

All four chart types on a real phone screen. Charts are the payoff of
the whole reframing, so this gate is about *legibility*, not
correctness: are they readable on a phone-sized viewport, do the CDN
chart scripts load, and does the two-bars chart actually make the
oscillation visible the way `APP_CONCEPT.md` describes? **Wait before
Phase 4.**

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

## ⛔ PHASE 4 GATE — hard stop

The user changes the rolling window and confirms bounds visibly move,
then exports a CSV **from the installed home-screen app, not a Safari
tab** — iOS blob-download behavior differs between the two and this
cannot be verified from this machine. **Wait before Phase 5.**

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
- **Carried over from Step 0.3 (found on review, deliberately deferred to
  here):** the install handler's CDN branch calls `cache.put(url, res)`
  without checking `res.ok`. A 404 or 5xx from jsDelivr would be cached
  as if it were the real script, and then served from cache offline —
  producing a broken chart library with no network error to point at.
  Guard it with `if (res.ok)` and let a failed fetch simply leave that
  URL uncached, since the `fetch` handler already falls back to the
  network. The pinned URLs returned 200 when Step 0.3 shipped, so this is
  latent rather than active.

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

**→ The full protocol lives in `docs/ORCHESTRATION.md`. Read it before
executing any step.** It defines the model policy (Opus orchestrator,
Sonnet subagents), the four roles, the implement→test→fix loop, the
prompt templates, and the escalation rules. Only the plan-specific bits
are repeated here.

**One step = one subagent task.** Each step above is scoped to be
completable by an agent with a bounded context: the step's own entry,
the Ground Rules, the Architecture decisions, and the files it names.
That is why steps carry redundant detail rather than cross-referencing
heavily — a cold subagent should not need to read the whole plan to do
one step.

**Parallelism.** Within a step, the Implementer and Test Author always
run in parallel (see `ORCHESTRATION.md` §2). Across steps, most are
strictly sequential. The genuinely parallel-safe pairs: 0.1 ∥ 0.2
(rename vs. schema touch nothing in common), and 3.1 ∥ 3.2 once their
shared plumbing exists. **Do not parallelize Phase 1** — later steps
depend on the exact function signatures earlier ones establish.

**Phase gates are hard stops.** Every phase ends with a ⛔ gate block
above. Deploy, hand the user a concrete manual checklist, and wait for
their verdict before starting the next phase. Within a phase, keep
moving without pausing between steps.

**When a subagent hits a gray area**, it stops and surfaces it rather
than guessing — a guess that contradicts `APP_CONCEPT.md` costs more to
unwind than to ask about.

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
  orchestrator derives the required cases per step (`ORCHESTRATION.md`
  §5) and the executing session records the results.
- **2026-08-21** — Orchestration protocol defined in
  `docs/ORCHESTRATION.md`: Opus orchestrator, Sonnet subagents,
  Implementer and Test Author running in parallel behind a strict file
  boundary so tests describe the contract rather than the
  implementation.
- **2026-08-21** — Test stack: Node's built-in runner for pure logic
  (zero deps), Playwright as a **test-only** devDependency for E2E.
  Permitted because the "no build step" rule governs the deploy path,
  and nothing under `tests/` ever ships. Suite is cumulative and always
  run in full.
- **2026-08-21** — Test data isolated by `__test__*` naming convention
  with teardown plus a stale-row sweep, rather than a second Supabase
  project. Nothing may modify a row without that prefix.
- **2026-08-21** — Phase gates are **hard stops** awaiting user
  verification; momentum is preserved *within* a phase. Escalate to the
  user after 5 failed fix cycles on the same failure.
- **2026-08-21** — Added Step 0.0 (test harness) as the true first
  step — nothing else in the plan is verifiable until it exists.

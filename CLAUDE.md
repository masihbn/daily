# This project

A personal PWA skill/habit tracker for the iPhone (no App Store). The
user logs skills/habits they don't necessarily do every day (e.g.
"workout" 3-4x/week, "calories", "smoking"), and sees:
- a **monthly calendar view** — days marked (e.g. green) when logged
- a **weekly chart** — count/amount per week over time, to see trends

**Currently mid-build — Phases 0 and 1 complete as of 2026-08-22.**
Hosting and backend plumbing are live and verified. The placeholder
tap-counter is **gone**: `index.html` boots a real app shell with a hash
router (`#/`, `#/t/:id`, `#/new`, `#/compare`, `#/settings`) and a bottom
nav.

**The data layer is built but not yet wired to any UI.** `js/api.js`,
`js/store.js`, `js/dates.js` and `js/aggregate.js` are complete and
tested, but **nothing imports them yet** — `js/main.js` still renders
placeholder views. So the app on the phone looks exactly like it did at
the Phase 0 close. Wiring starts at Step 2.1, which is the next step.

**Consequence worth knowing before you trust the suite:** those four
modules have only ever run in **Node**, never in a browser. The e2e tests
load `index.html`, which does not import them. Step 2.1 is the first time
they execute in Mobile Safari, so treat browser-specific behaviour
(`localStorage` under iOS storage rules, the offline outbox on a real
flaky connection, backgrounding the PWA mid-write) as unverified. Supabase
CORS from the browser is the exception — the Phase 0 tap-counter already
proved that path.

There is a cumulative regression suite: `npm test` runs unit →
integration → e2e and must be green before any step is marked DONE.
**635 tests at Phase 1 close** (579 unit, 43 integration, 13 e2e). See
`docs/ORCHESTRATION.md`.

**User decision on record (2026-08-22):** the user asked for an **extra
deploy checkpoint after Step 2.1** — build 2.1, then stop, push, and hand
them a manual test script, rather than running straight through 2.2 and
2.3 to the Phase 2 gate. Reason: 2.1 is the screen they use daily and the
first time the Phase 1 modules run in a browser at all, so an iOS
surprise should surface after one step instead of three. Honor this; it
is an addition to the protocol's normal "keep moving within a phase"
rule, not a replacement for the Phase 2 gate, which still stands.

**The concept was reframed and the design is now resolved.** It went from
a narrow "skill/habit tracker" to a more general personal logging +
charts platform (generic bounded-metric "two bars" tracking, flexible
aggregation, etc.), and the product is named **"Daily."** See
**docs/APP_CONCEPT.md** for the design decisions. The live schema has
since been migrated to match (migration `0003`, applied 2026-08-22) —
`docs/DATA_MODEL.md` describes what is actually live.

**→ If you are here to build something, read `docs/ORCHESTRATION.md`
first, then `docs/BUILD_PLAN.md`.**

- `ORCHESTRATION.md` — **how the session runs.** Model policy (this
  session must be **Opus**; all subagents **Sonnet**), the four
  subagent roles, the implement→test→fix loop, prompt templates,
  escalation rules. Read it before spawning anything.
- `BUILD_PLAN.md` — **what to build, in order.** Numbered steps with
  preconditions, deliverables, technical notes, and a status field.
  Find the first step that isn't `DONE` and work that one.

Don't implement from `APP_CONCEPT.md` directly — it's the *what*;
`BUILD_PLAN.md` is the *how* and the *in what order*.

**Two rules that override normal autonomy:** phase gates are hard stops
(deploy, hand the user a manual checklist, wait for their verdict), and
no subagent may weaken or delete a test to make it pass.

## Stack

- **Frontend**: plain HTML/CSS/JS, no build step, no framework. Deliberate
  choice — keeps the "edit → push → phone updates" loop as simple as
  possible. Don't introduce a bundler/framework without discussing it
  first; it's a real tradeoff against that goal.
- **Hosting**: GitHub Pages, serving from `main` branch root.
  Live at: https://masihbn.github.io/daily/
- **Backend**: Supabase (Postgres + PostgREST), called directly from the
  client via `fetch` — no Supabase JS client library in use.
- **Repo**: https://github.com/masihbn/daily (public — required
  for free GitHub Pages). Renamed from `memory-test-pwa` on 2026-08-22
  (Step 0.1). GitHub redirects the old URL for git operations, but the
  old **Pages** URL does not redirect reliably — treat
  `https://masihbn.github.io/daily/` as the only canonical URL.

## Folder structure

```
index.html          entry point (stays at root — GitHub Pages/PWA convention)
manifest.json        PWA manifest (stays at root)
sw.js                 service worker (stays at root — its cache scope covers
                       everything at or below wherever it's served from)
css/styles.css       all styles
js/main.js           entry point: router wiring, view render, SW registration.
                      The only file index.html loads as type="module".
js/router.js         pure parseHash(hash) -> {name, params}. Split out of
                      main.js so it is unit-testable in Node (main.js
                      bootstraps on import and cannot be imported headlessly).
js/config.js         SUPABASE_URL / SUPABASE_ANON_KEY — single source of
                      truth, imported by the app AND by tests/helpers/.
                      (js/app.js, the old tap-counter, was deleted in 0.3.)
js/api.js            PostgREST client (Step 1.1). The ONLY module allowed
                      to fetch() Supabase. Nine named operations, three
                      typed errors (ValidationError/NetworkError/ApiError)
                      split by a `retryable` flag. Not yet imported by any
                      view.
js/store.js          In-memory cache + localStorage mirror + an outbox
                      that queues writes made offline and replays them
                      (Step 1.1). Network is the source of truth; the
                      cache never overwrites a server value. Injectable
                      via createStore({api, storage, now}); getStore() is
                      the app-facing singleton. Not yet imported.
js/dates.js          PURE local-calendar date math (Step 1.2): todayLocal,
                      parseLocal, formatLocal, addDays, isoWeekKey,
                      startOfIsoWeek, isoWeeksInRange, rangeDays,
                      monthGrid. Read its header before touching it — the
                      UTC/DST traps are documented there.
js/aggregate.js      PURE rollup/normalization/bound math (Step 1.2):
                      rollup, fillSeries, normalizeSeries, deriveBounds,
                      applyRelog. applyRelog is the heart of the data
                      model. Imports only dates.js.
icons/               PWA icons
supabase/migrations/ one .sql file per schema change, applied in order
                      (numbered, e.g. 0001_..., 0003_...) — see docs/DATA_MODEL.md
tests/               test-only, never deployed (see ORCHESTRATION.md)
  unit/                node --test, pure functions, zero dependencies
  integration/         real PostgREST calls against __test__* rows
  e2e/                 Playwright (test-only devDependency)
  helpers/             static server + Supabase test-row lifecycle
package.json         TEST-ONLY (Playwright devDep + scripts). Does NOT
                      make this a Node project — there is still no build
                      step; GitHub Pages ignores it. node_modules/ is
                      gitignored and must never reach Pages.
docs/                 all notes/reference docs live here (see below)
  ORCHESTRATION.md     HOW SESSIONS RUN — Opus orchestrator, Sonnet
                        subagents, the implement→test→fix loop, phase
                        gates. Read before executing any build step.
  BUILD_PLAN.md        THE EXECUTION PLAN — numbered, ordered steps from
                        today's placeholder to shipped v1. Read this to
                        find out what to build next. Update step statuses
                        as you go.
  APP_CONCEPT.md       resolved design decisions — the *what*. Supersedes
                        the data model below in spirit even though the
                        schema hasn't caught up yet
  DATA_MODEL.md        schema reference for what's actually live (pre-dates
                        the reframing in APP_CONCEPT.md)
  PROJECT_NOTES.md      deployment/ops history and the GitHub blueprint
                        (gh auth mechanics, Pages setup, keepalive workflow,
                        security posture) — read before touching CI/deploy/git
.github/workflows/   supabase-keepalive.yml — pings the DB every ~5 days
                      so the free Supabase project doesn't auto-pause
```

**Convention: all notes/reference `.md` files live in `docs/`.** `CLAUDE.md`
is the one exception — it must stay at the repo root because Claude Code
auto-loads it from there. Any new project notes, design docs, or history
files go in `docs/`, not the root.

## Data model (high level — see docs/DATA_MODEL.md for full detail)

Live on the Supabase project as of 2026-08-22 (migration `0003`). The old
`skills` / `skill_entries` tables were **renamed**, not recreated:

- **`trackables`** — one row per thing being tracked. `value_shape`
  (`boolean`/`numeric`), `relog_semantic` (`cumulative`/`state` — what
  re-logging the same day does), `aggregation`
  (`sum`/`count`/`average`/`last`), `direction` (`build` = floor,
  `break` = ceiling), target and bounds config, `color`, `sort_order`,
  `archived`.
- **`entries`** — one row per day a trackable was logged
  (`trackable_id`, `entry_date`, `value`, `note`). **Unique on
  `(trackable_id, entry_date)`** — the whole re-log design depends on
  exactly one row per trackable per day. `updated_at` is maintained by a
  trigger; the app must NOT set it by hand. Calendar/weekly views are
  date-range queries aggregated client-side.
- **`app_settings`** — single row (`check (id = 1)`), holds
  `rolling_window_days` (default 90).
- **`counter`** — legacy, from the original plumbing test. **Do not
  drop it**: the keepalive workflow pings it, and dropping it silently
  auto-pauses the free project about a week later.

**Known gap, deliberate and scheduled**: every table uses the wide-open
`using (true)` RLS pattern, gated only by the public anon key. This is a
recorded v1 tradeoff (`docs/APP_CONCEPT.md`), closed in **Step 5.3** —
do not "helpfully" harden it early, that breaks every step in between.
It does mean anyone with the anon key can read/write until then, so
don't add sensitive fields (health specifics, journal-style notes)
without revisiting that decision first.

## Conventions worth knowing before editing

- Use **PowerShell**, not the Bash tool, for anything that needs to bind
  to a real local network interface (test servers) — Bash here runs in
  an isolated network namespace on this machine.
- If you touch `sw.js` or any cached asset, **bump the `CACHE` constant**
  in `sw.js` — otherwise phones that already installed the app may keep
  serving stale cached files.
- `.mcp.json` is intentionally gitignored (local machine's Supabase MCP
  connector config, not app code) — don't try to force-add it.
- Schema changes go in `supabase/migrations/` as a new numbered `.sql`
  file, applied via the Supabase MCP `apply_migration` tool — keep this
  as the running record of what's actually live, don't hand-edit tables
  via the dashboard without adding the matching migration file here.

Full history, every gotcha hit so far, and the exact `gh`/GitHub Pages/
keepalive setup steps live in **docs/PROJECT_NOTES.md** — read it before
doing anything with git, GitHub, or CI on this project.

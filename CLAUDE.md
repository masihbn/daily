# This project

A personal PWA skill/habit tracker for the iPhone (no App Store). The
user logs skills/habits they don't necessarily do every day (e.g.
"workout" 3-4x/week, "calories", "smoking"), and sees:
- a **monthly calendar view** — days marked (e.g. green) when logged
- a **weekly chart** — count/amount per week over time, to see trends

**v1 is built and in daily use — read this before touching anything.**
Every step of `docs/BUILD_PLAN.md` through 5.4 is `DONE` as of
2026-09-14 (Phases 0–5 plus the inserted Phase D). **The database holds
real, irreplaceable data**: three years of history imported from CSV on
2026-09-04 (about 2,000 rows) plus everything logged on the phone since
2026-08-25. Anything you change ships into an app the user opens every
day; a deploy reaches the phone after one relaunch (Step 5.1).

What is built and device-verified: the calendar heatmap, weekly trend
chart with target line, Daily/Weekly/Monthly granularity, the two-bars
Range chart with an overlay (another trackable's bars vs its target or
line vs its band), the normalised Compare screen, Settings (rolling
window that drives the auto bands, reorder, archived, CSV export via the
share sheet, Face ID lock, sign out), daily off-site backups with a
verified restore, the test suite on a second Supabase project, entry
provenance, the one-off CSV import, outbox durability, paged history,
single-user Supabase Auth with owner-scoped RLS, a service worker that
caches only app assets and updates after one relaunch, and an offline
indicator. Routes: `#/`, `#/t/:id`, `#/t/:id/edit`, `#/new`, `#/compare`,
`#/settings`.

**Next work: the design pass — `docs/DESIGN_PLAN.md`** (Phase U, started
2026-09-14). Find the first step there that is not `DONE` and run it
under `docs/ORCHESTRATION.md` exactly like a `BUILD_PLAN.md` step. It
restyles every screen (neutral accent, one component kit) and adds
full-screen sideways-scrolling charts; no data-flow changes.
`BUILD_PLAN.md` itself has no open step.

**Three things that will bite an unwary session during the park:**

1. **The silence problem.** GitHub disables a public repo's scheduled
   workflows after ~60 days without a push. `masihbn/daily` is public
   and its last push was 2026-09-13, so its keepalive is expected to be
   switched off around **2026-11-12**. That is tolerated, not a fault:
   the private backup repo commits every day (its workflow uses
   `--allow-empty`), so it never goes quiet, and since 2026-09-13 it
   runs a second keepalive job of its own. If the app ever fails one
   morning with no code change, the free Supabase project has
   auto-paused: check the backup repo's Actions tab first, then the
   Supabase dashboard. Re-enable the public repo's keepalive from its
   Actions tab when the build resumes.
2. **Any migration that bulk-updates `entries` fires the `updated_at`
   trigger.** Migration `0009` did exactly that on every row. Disable
   the trigger around a backfill (`alter table entries disable trigger
   set_updated_at`) and re-enable it after.
3. **Production writes from this machine are gated twice.** The
   auto-mode permission classifier refuses `apply_migration` against
   the production project; the user pastes migration SQL into the
   dashboard SQL editor instead. Secret-store writes (`gh secret set`)
   are refused too. Plan for both rather than retrying.

There is a cumulative regression suite: `npm test` runs unit →
integration → e2e and must be green before any step is marked DONE.
**4661 tests as of Step U.3** (4376 unit, 54 integration, 231 e2e). See
`docs/ORCHESTRATION.md`.

**User decisions on record (2026-08-25), all in `BUILD_PLAN.md`'s
decision log:** backups go to a **separate private repo** (never this
public one); tests move to a **second Supabase project**; Smoking becomes
a **numeric count per day**; RLS hardening moves from Step 5.3 to **D.7**
but does **not** block the user from starting to log; and **CSV import is
not an app feature** — the user hands over files, the orchestrator
transforms and pushes them. That last one was stated twice after an
earlier draft got it backwards; do not re-scope it into an in-app
importer.

**Earlier user decision (2026-08-22), now satisfied:** an extra deploy
checkpoint after Step 2.1 rather than running straight to the Phase 2
gate. Kept here because it shows the standing preference — when a step is
the first time something runs on the device, stop and let the user check
it before stacking more on top.

**The concept was reframed and the design is resolved.** It went from
a narrow "skill/habit tracker" to a more general personal logging +
charts platform (generic bounded-metric "two bars" tracking, flexible
aggregation, etc.), and the product is named **"Daily."** See
**docs/APP_CONCEPT.md** for the design decisions; `docs/DATA_MODEL.md`
describes what is actually live.

**→ If you are here to build something, read `docs/ORCHESTRATION.md`
first, then `docs/BUILD_PLAN.md`.**

- `ORCHESTRATION.md` — **how the session runs.** Model policy (this
  session must be a **top-tier model — Fable 5.1 or Opus**; all
  subagents **Sonnet**), the four
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
                       everything at or below wherever it's served from).
                       Since 5.1: intercepts ONLY same-origin GETs and the two
                       CDN scripts (never Supabase), bypasses the HTTP cache,
                       caches only OK responses; classic worker, unit-tested
                       in a vm sandbox (tests/unit/sw-handlers.test.mjs).
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
                      to fetch() /rest/v1/. Named operations, typed
                      errors re-exported from errors.js, split by a
                      `retryable` flag. Attaches the session bearer and
                      retries a 401 once after a token refresh (D.7).
                      listEntries pages past the 1,000-row cap (D.6b).
js/errors.js         ValidationError / NetworkError / ApiError / AuthError
                      and isRetryable. Split out of api.js in D.7 so
                      auth.js can throw them without an import cycle.
js/auth.js           Supabase Auth over raw fetch (D.7). The ONLY module
                      allowed to call /auth/v1/. Session in localStorage
                      (`daily.auth.v1`), single-flight refresh, offline
                      relaunch keeps the session. getAuth() singleton.
js/store.js          In-memory cache + localStorage mirror + an outbox
                      that queues writes made offline and replays them
                      (Step 1.1). Network is the source of truth; the
                      cache never overwrites a server value. Injectable
                      via createStore({api, storage, now}); getStore() is
                      the app-facing singleton. Since 4.1 also holds the
                      app_settings row (rolling window; writes are
                      online-only) and updateTrackable().
js/outbox-sync.js    Replays the outbox on reconnect / visibility /
                      interval (D.6). Flushes are gated on isSignedIn().
js/icons.js          Icon set for trackables (Step 2.5).
js/ui-icons.js       U.0: the app's own chrome icons (tabs, back, expand,
                      close, …) — inline SVG, currentColor only.
js/export-csv.js     CSV export (4.2): pure row/CSV builders plus the
                      share → download → textarea delivery chain.
js/net-status.js     5.1: the global offline indicator (navigator.onLine +
                      online/offline events) and requestAppVersion(), which
                      asks the controlling worker for its cache name.
js/applock.js        5.2: opt-in local Face ID lock over WebAuthn (platform
                      credential id in localStorage, "unlocked" in
                      sessionStorage). The assertion is not server-verified;
                      the OS user-verification gate is the property.
js/views/            home.js (+ home-model.js), trackable.js (create/
                      edit form), detail.js (calendar + charts + range),
                      compare.js (3.5: #/compare, normalised multi-series),
                      settings.js (4.1/4.2/5.2: rolling window, reorder,
                      archived, export, app lock, sign out), signin.js
                      (email + password, Show/Hide), lock.js (5.2: the lock
                      screen with "Sign out instead" as the escape hatch).
js/charts/           theme.js (U.3: Chart.js option fragments read from
                      the CSS tokens — axes, tooltip, labels, gradient
                      line fill; injectable reader, unit-tested);
                      heatmap.js, weekly.js, bounds.js — pure chart
                      builders over Chart.js; overlay.js (3.4–3.4c) —
                      one other trackable on the bounds chart's right
                      axis: bars vs its target (count/sum) or a dashed
                      line vs its bounds (average/last), plus the picker;
                      compare.js (3.5) — pure model + Chart.js render for
                      the compare screen (each series 0–100% of its own
                      range in the window).
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
                      (0001 … 0010 as of D.7) — see docs/DATA_MODEL.md
scripts/             NOT deployed. screenshots.mjs (U.0: every screen at
                      phone size, dark + light, from fixtures — the design
                      pass's visual check). backup.mjs / restore.mjs (D.3; the
                      private backup repo checks this repo out and runs
                      backup.mjs daily), import-csv.mjs (D.5, one-off),
                      bootstrap-test-project.sql (D.4; recreates the
                      test project's schema, migrations 0002–0010).
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
  ORCHESTRATION.md     HOW SESSIONS RUN — top-tier orchestrator, Sonnet
                        subagents, the implement→test→fix loop, phase
                        gates. Read before executing any build step.
  DESIGN_PLAN.md       THE DESIGN PASS (Phase U, 2026-09-14 →) — tokens,
                        kit, per-screen restyle steps U.0–U.7, full-screen
                        charts (U.4). Same step contract as BUILD_PLAN.md.
  BUILD_PLAN.md        THE EXECUTION PLAN — numbered, ordered steps from
                        today's placeholder to shipped v1. Read this to
                        find out what to build next. Update step statuses
                        as you go.
  APP_CONCEPT.md       resolved design decisions — the *what*. Supersedes
                        the data model below in spirit even though the
                        schema hasn't caught up yet
  DATA_MODEL.md        schema reference for what's actually live, migration
                        by migration (0001–0010), incl. security status
  PROJECT_NOTES.md      deployment/ops history and the GitHub blueprint
                        (gh auth mechanics, Pages setup, keepalive workflow,
                        security posture) — read before touching CI/deploy/git
.github/workflows/   supabase-keepalive.yml — pings the DB every ~5 days
                      so the free Supabase project doesn't auto-pause.
                      Expected to be auto-disabled ~2026-11-12 (see the
                      silence problem above); the backup repo covers it.
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

**Security, since Step D.7 (2026-09-13)**: Supabase Auth, single user,
email + password. `trackables`, `entries` and `app_settings` carry a
`user_id` (default `auth.uid()`, the app never sends it) and every
policy is `(select auth.uid()) = user_id` for the `authenticated` role.
The anon key can read exactly one thing: `counter`, for the keepalive.
`js/auth.js` is the only module that may call `/auth/v1/`; `js/api.js`
attaches the session bearer and retries a 401 once after a refresh.
The test tiers sign in as the test project's own user
(`DAILY_TEST_EMAIL` / `DAILY_TEST_PASSWORD` in the gitignored
`.env.test`, which also holds the test project's URL and anon key; the
test project is `dftqrsngiroitugbwtaz` and holds no real data). The
backup workflow uses a secret key stored only in the private backup
repo `masihbn/daily-backups`; never put one in this repo. The
production password is the user's alone: never ask for it.

## Conventions worth knowing before editing

- Use **PowerShell**, not the Bash tool, for anything that needs to bind
  to a real local network interface (test servers) — Bash here runs in
  an isolated network namespace on this machine.
- If you touch `sw.js` or any cached asset, **bump the `CACHE` constant**
  in `sw.js` — otherwise phones that already installed the app may keep
  serving stale cached files. Since 5.1 a bump reaches the phone after
  one relaunch (the page reloads itself when the new worker takes
  control); before 5.1 there was a 10-minute HTTP-cache lag on top.
- `.mcp.json` is intentionally gitignored (local machine's Supabase MCP
  connector config, not app code) — don't try to force-add it.
- Schema changes go in `supabase/migrations/` as a new numbered `.sql`
  file, applied via the Supabase MCP `apply_migration` tool — keep this
  as the running record of what's actually live, don't hand-edit tables
  via the dashboard without adding the matching migration file here.

Full history, every gotcha hit so far, and the exact `gh`/GitHub Pages/
keepalive setup steps live in **docs/PROJECT_NOTES.md** — read it before
doing anything with git, GitHub, or CI on this project.

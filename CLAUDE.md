# This project

A personal PWA skill/habit tracker for the iPhone (no App Store). The
user logs skills/habits they don't necessarily do every day (e.g.
"workout" 3-4x/week, "calories", "smoking"), and sees:
- a **monthly calendar view** — days marked (e.g. green) when logged
- a **weekly chart** — count/amount per week over time, to see trends

Currently mid-build: hosting and backend plumbing are live and verified;
the actual tracking UI has not been built yet — today's app is still the
placeholder tap-counter used to prove the plumbing.

**The concept has moved beyond what's described below, and design is now
resolved.** It was reframed from a narrow "skill/habit tracker" into a
more general personal logging + charts platform (generic bounded-metric
"two bars" tracking, flexible aggregation, etc.), and the product is
named **"Daily."** See **docs/APP_CONCEPT.md** for the design decisions
before assuming the schema/data model sections below are still the
target — the schema live on Supabase (`docs/DATA_MODEL.md`) predates
this reframing and hasn't been migrated to match it yet.

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
  Live at: https://masihbn.github.io/memory-test-pwa/
- **Backend**: Supabase (Postgres + PostgREST), called directly from the
  client via `fetch` — no Supabase JS client library in use.
- **Repo**: https://github.com/masihbn/memory-test-pwa (public — required
  for free GitHub Pages)

## Folder structure

```
index.html          entry point (stays at root — GitHub Pages/PWA convention)
manifest.json        PWA manifest (stays at root)
sw.js                 service worker (stays at root — its cache scope covers
                       everything at or below wherever it's served from)
css/styles.css       all styles
js/app.js            all client JS (will split into modules as features grow)
icons/               PWA icons
supabase/migrations/ one .sql file per schema change, applied in order
                      (numbered, e.g. 0001_..., 0002_...) — see docs/DATA_MODEL.md
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

Two tables, live on the Supabase project as of 2026-08-21:

- **`skills`** — one row per habit the user is tracking (name, whether
  it's logged as done/not-done or as a number, a weekly target, a
  color, etc).
- **`skill_entries`** — one row per day a skill was logged (`skill_id`,
  `entry_date`, `value`). Calendar/weekly views are just date-range
  queries against this table, aggregated client-side — no materialized
  views needed at this scale.

**Known gap, not yet fixed**: both tables currently use the same
wide-open RLS pattern as the original test counter (`using (true)` for
everything, gated only by the public anon key). Fine for solo use
against an unlisted URL; must be replaced with per-user, auth-scoped
policies before this app is ever used for something the user wouldn't
want exposed if the URL or key leaked. Don't add more sensitive fields
(health data, journal-style notes) without revisiting this first.

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

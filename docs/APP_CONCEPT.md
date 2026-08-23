# App concept — personal tracking & charts platform

**Status: live design discussion, not yet implemented.** Nothing in this
file has been built. The schema currently live on Supabase
(`supabase/migrations/0002_skills_tracker.sql`) predates this reframing
and will need a new migration once the design below is finalized — don't
treat that file as authoritative over this one. This doc is the running
record of the conversation; keep appending/editing as the design evolves
rather than building from it prematurely.

## The core idea

Started as a habit/skill tracker (log things you don't necessarily do
every day — workout 3-4x/week, calories, smoking) but reframed mid-design
into something broader: **a general personal logging platform where
charts are just different lenses on the same underlying logged entries.**
The point is to log everything that matters to the user, in whatever
shape it naturally comes in, and let a handful of reusable chart types
reveal patterns — not to build a single-purpose "habit streak" app.

## Motivating example: the "two bars" mechanic

The user's own example: body weight tends to oscillate between two
subconscious thresholds (e.g. 78kg–85kg). Near the lower bar, behavior
subconsciously drifts toward overeating/under-exercising; near the upper
bar, it flips toward diet/exercise — pulling weight back toward the
other bar, and the cycle repeats. The goal is to make this normally-
invisible loop visible: show the metric over time with its two
threshold "bars," and optionally overlay related habit logs (gym,
overeating) on the same chart to see the cause-and-effect directly.

This matches a real, named concept in weight-regulation research: the
**dual intervention point model** — rather than one fixed weight
"set point," the body has a *range* bounded by upper/lower intervention
points, with compensation only kicking in once a bound is crossed, and
freer drift in between. (Sources: [Set point theory —
Wikipedia](https://en.wikipedia.org/wiki/Set_point_theory), [Obesity and
Set-Point Theory — NCBI
StatPearls](https://www.ncbi.nlm.nih.gov/books/NBK592402/).)

Decided: this mechanic should be **generic**, not weight-specific — any
numeric metric can have two bounds and this same oscillation chart.

## Entity model (as currently discussed — not yet built)

- **Trackable** — the thing being logged (workout, calories, expenses,
  weight, smoking, ...). Has:
  - a name
  - a value shape: `boolean` (done/not-done) or `numeric` (a quantity)
  - for numeric trackables, a **re-log semantic** (see table below):
    `cumulative` (adds) or `state` (replaces)
  - an **aggregation function** used when rolling entries up into a
    weekly/monthly chart: sum, count, average, or last-value
  - optionally, a **target** (see Targets & streaks below)
  - optionally, **bounded-metric config**: upper/lower thresholds
    (manual or auto-derived — see Bounded metrics below), which turns on
    the two-bars chart for that trackable
- **Entry** — one logged data point: trackable + date + value + optional
  note. **One entry per trackable per day** (not one row per individual
  log action — see re-log semantics below for what happens when you log
  twice in the same day).

## Re-log semantics (what happens if you log the same trackable twice in one day)

Resolved by trackable value-shape/semantic, keeps the "one entry per day"
data model intact even for things logged multiple times a day:

| Trackable kind | Same-day re-log behavior | Example |
|---|---|---|
| `boolean` | Idempotent — logging again does nothing new | Workout (done is done) |
| `numeric`, `cumulative` | **Adds** to today's existing value | Expenses, calories, cigarettes |
| `numeric`, `state` | **Replaces** today's existing value | Weight, mood score |

## Aggregation for rollup views

Same daily entries, different aggregation function per trackable when
viewed at a coarser grain (week/month):

- **Expenses** → weekly **sum**
- **Gym sessions** → weekly **count**
- **Calories** → weekly/monthly **average**
- **Weight** → typically viewed as-is (a `state` line chart), not
  aggregated, since the two-bars view wants the actual trend, not a sum

## Targets & streaks

- **Target model: per-trackable, mixed.** Each trackable picks its own
  target style when created: a weekly count (e.g. "4x/week," any days),
  specific days of the week, or no target at all. Matches workout
  (weekly count), calories (arguably no target, just logged), and
  smoking (no target, just logged) simultaneously.
- **Streak logic: forgiving weekly rollup.** For trackables with a
  weekly-count target, only whether the weekly total was hit by week's
  end matters — not which specific days. Chosen to avoid daily
  streak-anxiety; matches how the user described workout ("3-4 days a
  week," not a fixed schedule).

## Bounded metrics ("two bars")

- Generic feature, usable on any numeric trackable, not just weight.
- Thresholds can be **set manually** or **auto-derived**.
- Auto-derivation method: **rolling window**, default **90 days**, but
  the window length should be **changeable in settings** (per the
  user's explicit answer — not a hardcoded global constant).
- **Auto-derivation statistic: 10th / 90th percentile of the window**
  (resolved 2026-08-21). The window's raw `min`/`max` was rejected: it
  is determined by exactly two readings — the single highest and single
  lowest day in 90 days — which are precisely the readings most likely
  to be measurement noise rather than signal (weighing post-meal, while
  dehydrated, on a different scale). One bad reading would permanently
  widen the band and make the whole chart lie. Percentiles describe the
  range the metric *actually lives in*, which is what the dual
  intervention point model is about: where compensating behavior kicks
  in, not the absolute extremes ever recorded. With a typical sparse
  series (~25 weigh-ins per 90 days) p10/p90 still sits ~2-3 readings in
  from each end, so it stays responsive without being noise-driven.
- Bound behavior for v1: **visual only** — the chart shades zones as
  the value approaches a bound (e.g. color gradient toward a bound
  color). No push notifications for v1 (noted as a possible future
  addition, but adds real complexity — iOS PWA notification permissions
  + a way to trigger them — and wasn't chosen for v1).
- **Correlation overlay**: other trackables' entries (e.g. gym-day
  markers) can be drawn on top of a bounded metric's chart, so the
  user can visually connect habit logs to the metric's movement.

## Chart types confirmed for v1

All four selected by the user (multi-select, all chosen):

1. **Calendar heatmap** — month grid, days filled/colored based on
   whether+how-much was logged. Good fit for boolean trackables.
2. **Weekly bar/trend chart** — one point/bar per week, aggregated per
   the trackable's aggregation function.
3. **Two-bars threshold chart** — line chart with upper/lower bound
   lines and zone shading (the weight-oscillation view, generalized).
4. **Correlation overlay** — other trackables' markers drawn on a
   bounded-metric chart.

## Navigation / home layout

**Trackable list + quick-log.** Home shows all trackables as a list with
a fast way to log today's entry for each. Tapping into a trackable shows
its enabled chart(s).

## Numeric input (resolved)

Native numeric keypad — `inputmode="decimal"` (or `type="number"`), never
the full QWERTY keyboard. Decimals allowed by default (needed for things
like weight, e.g. `78.4`); no per-trackable integer-only restriction
requested.

## Correlation/comparison charts — turned out bigger than first scoped

Originally scoped (earlier in this doc) as "overlay habit markers on a
bounded metric's chart" — e.g. gym-day dots drawn on the weight chart.
The user's calorie-vs-money example is a different, harder case: two
independent numeric trackables with completely different units and
scales (calories ~2000/day, money ~$50/day) that need to be compared for
*correlated movement over time*, not just marker placement.

This is really **two distinct features** under one name:
1. **Marker overlay on a bounded-metric chart** — discrete events (e.g.
   "logged gym today") drawn as markers on a continuous metric's chart.
   Originally scoped, still wanted.
2. **Normalized multi-series comparison chart** — **resolved**: any
   number of numeric trackables (not capped at 2) can be selected at
   once, each aggregated to a common period via its own aggregation
   function (count/sum/average), then normalized to its own historical
   min–max range (0–100%) — reusing the same min/max mechanism already
   designed for the bounded-metric feature — so differently-scaled
   series (calories vs. dollars) share one chart. Raw values stay
   visible via tooltip/legend; only the plotted line position is
   normalized. Note for later UI design: readability will degrade as
   more series are added at once — worth a "recommended max" or visual
   decluttering pass when building this, but no hard cap.

## Target lines (refines the earlier "forgiving weekly rollup" framing)

Targets are a **reference line drawn directly on the trackable's chart**
— e.g. a horizontal line at `3` on the weekly workout-count bar chart, or
at `2000` on the calories chart — not just an abstract streak counter.
Hitting/missing is visually obvious from where the bar/point falls
relative to the line. (This is the concrete visual form of the earlier
"forgiving weekly rollup" decision, not a contradiction of it.)

**Resolved**: per-trackable choice, reusing the `build`/`break` field
already in the live schema — `build` = floor (hit-or-exceed is good, e.g.
workouts), `break` = ceiling (stay under is good, e.g. a calorie diet
limit).

## Face ID / auth — needs scope clarification before building

Read of the request: a **lightweight local app-lock** (WebAuthn platform
authenticator — Face ID — gating the installed PWA when it's opened),
not full Supabase user accounts. Important distinction to confirm before
building either piece: **a local Face ID lock does not, by itself, make
the backend secure.** The anon key + open RLS policies (tracked as a
known gap in `docs/DATA_MODEL.md`) would still let anyone who obtained
the key read/write the data over the network — Face ID only stops
someone picking up the unlocked phone from opening the installed app.
These are two separate problems (device-level access vs. data-level
security) and may need two separate answers.

**Researched and confirmed feasible**: Apple supports WebAuthn for PWAs
added to the Home Screen specifically, with Face ID/Touch ID as the
platform authenticator and automatic fallback to device passcode if
biometrics aren't available. One caveat: since 2024, standalone PWA mode
is disabled entirely in the EU under the Digital Markets Act (installed
PWAs there just open as a Safari tab) — irrelevant unless used from the
EU. (Source: [Biometric Login for PWAs —
weblogtrips.com](https://weblogtrips.com/technology/biometric-login-pwa-facial-recognition-2026/))

## Face ID / auth scope (resolved)

Local app-lock only, confirmed. Backend stays as-is (anon key + open
RLS) for now — explicitly not treated as a substitute for the still-open
RLS-hardening item below.

## Product name: "Daily" (chosen)

**Resolved**: yes, rename the repo and Pages URL to match (not just the
in-app name). **Not yet executed** — this is a real, disruptive action
(breaks the URL already tested/added to the home screen; needs
redoing on the phone afterward) and is being held until we move from
discussion into actually building, per the explicit instruction to not
implement yet. When it happens: rename the GitHub repo (currently
`memory-test-pwa`), which changes the Pages URL to match, update
`.mcp.json`'s local reference if needed, and re-verify the deploy
pipeline end to end (see `docs/PROJECT_NOTES.md`'s GitHub blueprint).

## Rolling window (confirmed)

Global setting (not per-metric), default 90 days, changeable in
settings. No change from the earlier decision.

## Data export (resolved)

Simple CSV export wanted — a way to dump entries (per-trackable or
everything) to a downloadable CSV. Scoped as a real v1 feature, not
"someday."

## Reminders/notifications (resolved)

No reminders for v1. Purely pull-based — open the app when you want to
log. Revisit only if the no-reminders approach turns out to hurt actual
usage.

## RLS/auth hardening timing (resolved — with a noted tradeoff)

Decided: build v1 features first against the current open-RLS setup,
harden RLS afterward, once the feature set stabilizes. **Accepted
tradeoff, not an oversight**: this means real personal data (weight,
expenses, calories) will sit behind the same wide-open `using (true)`
policy as the original test counter for the duration of v1 development
— acceptable because only the user has the URL/key and it's solo use,
but this should not be treated as "fine indefinitely." Revisit before
this is ever shared, exposed more broadly, or treated as finished.

## Open questions — not yet decided, come back to these

- How "specific days of week" targets actually render/feel in the UI
  (calendar-exact scheduling wasn't picked as the sole model, but is
  available per-trackable — needs its own design pass). Lower priority:
  no trackable discussed so far actually needs this over a weekly-count
  target.

## Decision log (dated, append rather than rewrite)

- **2026-08-21** — Reframed from "skill/habit tracker" to a general
  logging + charts platform, after the user described the weight
  two-bars oscillation concept. Confirmed via research that this matches
  the "dual intervention point model" in weight-regulation literature.
- **2026-08-21** — Re-log semantics fixed: boolean = idempotent,
  numeric/cumulative = adds, numeric/state = replaces. Keeps the
  existing one-entry-per-day schema shape intact.
  - **SUPERSEDED 2026-08-22 (Step 2.1b), after the user tried both on
    device: additive re-logging is removed from the product.** Re-logging
    a numeric trackable REPLACES the day's value. Migration `0004` makes
    `state` the default and converted every existing row.
    `applyRelog()`'s `cumulative` branch and the `'cumulative'` value in
    the check constraint are deliberately **kept** — existing entry rows
    were written under the additive semantic, so removing it would make
    both the code and the schema lie about how that data was produced.
    The capability is simply never offered in the UI.
- **2026-08-22** — **Good/bad must be visible on the home screen, and the
  checked state must be much more obvious** (user request). Resolved by
  finally using the `direction` column the schema has always had:

  > **A green check means "today is good" — NOT "logged."**

  | | Not logged | Logged |
  |---|---|---|
  | `build` (Workout) | ○ *Not yet* — muted | ✓ *Done* — green |
  | `break` (Smoking) | ✓ *Clean* — green | ✕ *Logged* — red |

  Rationale, from research rather than taste:
  - **WCAG 1.4.1** forbids colour as the only cue, so every state carries
    a distinct **shape and word** as well as a colour and survives
    greyscale/colourblindness.
  - **Loop Habit Tracker** (`iSoron/uhabits`, the most established
    open-source tracker) refuses bad-habit tracking outright, arguing you
    should rephrase to *"Did you have a smoke-free day today?"* — because
    ticking a box reads as an achievement and rewards the behaviour the
    user is trying to stop.
  - Apps that **do** support bad habits (Streaks' "negative tasks",
    Quitzilla, Simple Streak) resolve that by **inverting the reward** —
    the clean day is the win, counted as days *since* the last slip.
  - So the tick is kept (the user wants to log the slip) but is made to
    look like a slip, and the reward signal points at the desired
    behaviour in both directions. This is why an unlogged `break` habit
    shows the green check — it is deliberate, not a bug.

  **Numeric trackables stay verdict-neutral for now**: without a target
  there is no honest way to call a number good or bad. They show a
  plain-English `direction` label ("less is better") instead, and real
  good/bad colouring arrives with target lines in Step 3.2.
- **2026-08-21** — Target model = per-trackable, mixed (weekly count /
  specific days / none). Streak logic = forgiving weekly rollup.
- **2026-08-21** — Auto-threshold method = rolling window; default 90
  days, changeable in settings.
- **2026-08-21** — v1 chart types confirmed: calendar heatmap, weekly
  bar/trend chart, two-bars threshold chart, correlation overlay.
- **2026-08-21** — Home layout = trackable list + quick-log.
- **2026-08-21** — Numeric input = native numeric keypad
  (`inputmode="decimal"`), decimals allowed. Rolling window confirmed
  global (not per-metric), 90-day default stands.
- **2026-08-21** — Targets are reference lines drawn on the chart, not
  just an abstract streak number — direction (ceiling/floor) still
  needs a per-trackable setting.
- **2026-08-21** — Correlation overlay split into two features: marker
  overlay (as originally scoped) + a new normalized multi-series
  comparison chart (from the calorie-vs-money example) — normalization
  method proposed (own-history min–max) but not yet confirmed.
- **2026-08-21** — Face ID requested; scoped as likely a local app-lock
  only, not full account auth — flagged that this doesn't replace the
  still-needed RLS hardening. Researched and confirmed technically
  feasible (WebAuthn on installed iOS PWAs); scope (local-lock only vs.
  also wanting account-level security) still needs confirmation.
- **2026-08-21** — Product name chosen: "Daily." Repo/URL rename scope
  not yet decided.
- **2026-08-21** — Target direction = per-trackable choice, reusing
  build/break. Comparison-chart normalization confirmed (own min–max,
  0–100%), uncapped number of series comparable at once. Face ID scope
  confirmed as local app-lock only, not a substitute for RLS hardening.
- **2026-08-21** — Repo/URL rename to "Daily" confirmed but deliberately
  not executed yet (holding for the move from discussion to building).
  CSV export scoped in for v1. No reminders/notifications for v1. RLS
  hardening deferred until after v1 features stabilize — explicitly
  flagged as an accepted tradeoff, not indefinite.
- **2026-08-21** — Moved from design into execution. `docs/BUILD_PLAN.md`
  (ordered steps) and `docs/ORCHESTRATION.md` (how sessions run those
  steps) created. Charting resolved: Chart.js v4 + annotation plugin via
  pinned CDN tags, calendar heatmap hand-rolled in CSS Grid.
- **2026-08-21** — Auto-bound statistic resolved as **p10/p90 of the
  rolling window**, closing the one gap the bounded-metrics section had
  left unspecified. Rationale recorded above under Bounded metrics.
- **2026-08-21** — "Specific days of week" targets stay the single open
  design question. Resolution for v1: ship the schema column
  (`target_days`), defer the UI. Nothing discussed so far needs it over
  a weekly-count target, so it must not block v1.

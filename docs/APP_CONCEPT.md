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

## Open questions — not yet decided, come back to these

- Numeric input UX per trackable: keypad entry vs. +/- stepper vs.
  letting each trackable choose. Leaning toward defaulting to keypad
  entry unless discussed further.
- Exact correlation-overlay UI: how many trackables can be overlaid on
  one chart at once, and how the user picks which ones.
- Whether the auto-threshold rolling-window length is a single global
  setting or configurable per bounded metric (leaning per-metric, with
  a global default of 90 days, but not confirmed).
- How "specific days of week" targets actually render/feel in the UI
  (calendar-exact scheduling wasn't picked as the sole model, but is
  available per-trackable — needs its own design pass).
- Data export/backup format (mentioned as a general concern in
  `docs/PROJECT_NOTES.md`'s Security posture section, not yet discussed
  for this app specifically).
- Notifications/reminders strategy — explicitly deferred out of v1 for
  the bounded-metric feature; whether it's wanted anywhere else in the
  app (e.g. a daily reminder to log) hasn't been discussed.
- RLS/auth hardening — still an open item from `docs/DATA_MODEL.md`'s
  Security status section, now more urgent given this app will hold
  actual personal health/financial data (weight, expenses), not just a
  placeholder counter.
- Product name — still called "memory-test-pwa" / "Memory Test"
  everywhere; not yet renamed to reflect the real concept.

## Decision log (dated, append rather than rewrite)

- **2026-08-21** — Reframed from "skill/habit tracker" to a general
  logging + charts platform, after the user described the weight
  two-bars oscillation concept. Confirmed via research that this matches
  the "dual intervention point model" in weight-regulation literature.
- **2026-08-21** — Re-log semantics fixed: boolean = idempotent,
  numeric/cumulative = adds, numeric/state = replaces. Keeps the
  existing one-entry-per-day schema shape intact.
- **2026-08-21** — Target model = per-trackable, mixed (weekly count /
  specific days / none). Streak logic = forgiving weekly rollup.
- **2026-08-21** — Auto-threshold method = rolling window; default 90
  days, changeable in settings.
- **2026-08-21** — v1 chart types confirmed: calendar heatmap, weekly
  bar/trend chart, two-bars threshold chart, correlation overlay.
- **2026-08-21** — Home layout = trackable list + quick-log.

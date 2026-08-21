# Data model — skill/habit tracker

Full schema reference and design rationale. See `CLAUDE.md` for the
one-paragraph summary; this file has the detail behind it.

Applied to the live Supabase project (`okwzgmvnsdlheuolcthn`) on
2026-08-21 via `supabase/migrations/0002_skills_tracker.sql`. If you
change the schema, add a new numbered migration file rather than editing
this doc's SQL in place — this doc should always describe what's
*actually* live.

## `skills`

One row per habit/skill being tracked.

| column            | type      | notes                                                              |
|-------------------|-----------|---------------------------------------------------------------------|
| `id`              | bigint    | identity primary key                                                |
| `name`            | text      | e.g. "Workout", "Calories", "Smoking"                                |
| `tracking_type`   | text      | `'boolean'` (done/not-done) or `'numeric'` (a quantity per day)     |
| `direction`       | text      | `'build'` (more is better, e.g. workout) or `'break'` (less is better, e.g. smoking) — flips how a chart should read as "improving" |
| `unit`            | text      | nullable; e.g. `'kcal'`, `'cigarettes'` — null for boolean skills   |
| `target_per_week` | smallint  | nullable; e.g. `4` for "3-4x a week." Null = no target set          |
| `color`           | text      | nullable hex color for calendar/chart display; null = client picks a default |
| `sort_order`      | integer   | for the user's preferred ordering in the skill list                |
| `archived`        | boolean   | soft-delete — hide from the active list without losing history     |
| `created_at`      | timestamptz | default `now()`                                                   |

**Why `tracking_type` instead of two separate tables?** Boolean and
numeric skills share every other column (name, target, color, entries
shape) — splitting them into separate tables would just mean querying
both everywhere. A single `value` column on `skill_entries` covers both:
boolean skills store `1` for "done," numeric skills store the actual
amount.

**Why `direction`?** So a calendar/chart can show "green = good" for both
a workout (present = good) and smoking (absent, or a low number = good)
without hardcoding per-skill logic in the UI — the UI just reads this
column to decide which direction counts as improvement.

## `skill_entries`

One row per day a skill has a logged value.

| column       | type        | notes                                                    |
|--------------|-------------|-----------------------------------------------------------|
| `id`         | bigint      | identity primary key                                       |
| `skill_id`   | bigint      | FK -> `skills.id`, `on delete cascade`                     |
| `entry_date` | date        | the day being logged (not a timestamp — one entry per day) |
| `value`      | numeric     | boolean skills: `1` = done. numeric skills: the amount     |
| `note`       | text        | nullable free-text note                                    |
| `created_at` | timestamptz | default `now()`                                             |
| `updated_at` | timestamptz | default `now()` — bump on edit (not automatic yet, app must set it) |

**Unique constraint**: `(skill_id, entry_date)` — enforces one entry per
skill per day. The app should `upsert` (`on_conflict=skill_id,entry_date`
via PostgREST, or a plain `POST` with `Prefer: resolution=merge-duplicates`)
rather than always `INSERT`, so re-logging the same day edits it instead
of erroring or duplicating.

**Index**: `(skill_id, entry_date)` — supports both the calendar query
(all entries for one skill across a date range) and the weekly-aggregate
query (same, grouped by week) efficiently.

## How the planned views read from this

Nothing materialized — both views are a single date-range `SELECT`
against `skill_entries`, aggregated client-side. At personal-app scale
(one user, a handful of skills, a few years of daily rows at most) this
needs no further optimization.

- **Monthly calendar**: `select entry_date, value from skill_entries
  where skill_id = :id and entry_date between :month_start and
  :month_end` — map each date to a cell, color it if a row exists
  (boolean) or by magnitude (numeric).
- **Weekly trend chart**: same query over a longer range, then group
  client-side by ISO week — count rows (boolean) or sum `value`
  (numeric) per week, plot as a bar/line chart.

## Security status (see also PROJECT_NOTES.md → "Security posture")

Both tables currently have a single permissive RLS policy each
(`for all using (true) with check (true)`) — the anon/publishable key
embedded in the client can read, insert, update, and delete anything in
either table. This mirrors the original counter table's pattern and is
being carried forward *as a known, tracked gap*, not an oversight:

- Fine for now: single user, unlisted URL, no sign-in flow exists yet.
- **Must change before this app stores anything the user would mind
  being exposed if the URL/key leaked** — the fix is Supabase Auth (even
  a single-user email/password or magic-link setup) plus a `user_id`
  column + RLS policies scoped to `auth.uid()`, replacing the `using
  (true)` policies here. Not implemented yet — do this before adding
  more sensitive skills (health specifics, journal-style notes) or
  before ever sharing the URL with anyone else.

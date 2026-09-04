# Data model — Daily

Full schema reference and design rationale. See `CLAUDE.md` for the
one-paragraph summary and `docs/APP_CONCEPT.md` for the product design
this schema implements; this file has the schema detail.

Applied to the live Supabase project (`okwzgmvnsdlheuolcthn`):
- `supabase/migrations/0002_skills_tracker.sql` (2026-08-21) — original
  `skills` / `skill_entries` tables.
- `supabase/migrations/0008_restorable_identity.sql` (2026-08-25) — made
  `trackables.id` / `entries.id` `GENERATED **BY DEFAULT**` and added
  `daily_resync_identity()` (Step D.3). See "Restorability" below.
- `supabase/migrations/0007_entry_source_blank_fix.sql` (2026-08-25) —
  fixed `0006`'s blank guard (`btrim` trims spaces only, so a tab passed).
- `supabase/migrations/0006_entry_source.sql` (2026-08-25) — added
  `entries.source` for import provenance (Step D.2).
- `supabase/migrations/0005_target_average_and_icon.sql` (2026-08-23) —
  added the `weekly_average` target type and the `icon` column.
- `supabase/migrations/0004_replace_only_relog.sql` (2026-08-23) — made
  `'state'` the `relog_semantic` default and converted every row.
- `supabase/migrations/0003_trackables.sql` (2026-08-22) — renamed
  `skills` → `trackables` and `skill_entries` → `entries` (and
  `skill_id` → `trackable_id`), added the columns needed for flexible
  re-log semantics, weekly aggregation, targets, and chart bounds; added
  `app_settings`; added an `updated_at` trigger.

If you change the schema, add a new numbered migration file rather than
editing this doc's SQL in place — this doc should always describe
what's *actually* live.

## `trackables`

One row per metric/habit being tracked.

| column            | type      | notes                                                              |
|-------------------|-----------|---------------------------------------------------------------------|
| `id`              | bigint    | identity primary key                                                |
| `name`            | text      | e.g. "Workout", "Calories", "Smoking"                                |
| `value_shape`     | text      | `'boolean'` (done/not-done) or `'numeric'` (a quantity per day)     |
| `direction`       | text      | `'build'` (floor — hit-or-exceed `target_value` is good, e.g. workout) or `'break'` (ceiling — stay under `target_value` is good, e.g. smoking) |
| `unit`            | text      | nullable; e.g. `'kcal'`, `'cigarettes'` — null for boolean trackables |
| `target_value`    | numeric   | nullable. Meaning depends on `target_type` (see below). Null = no target |
| `color`           | text      | nullable hex color for calendar/chart display; null = client picks a default |
| `sort_order`      | integer   | for the user's preferred ordering in the trackable list            |
| `archived`        | boolean   | soft-delete — hide from the active list without losing history     |
| `created_at`      | timestamptz | default `now()`                                                   |
| `relog_semantic`  | text      | `'cumulative'` (re-logging the same day adds to the existing value, e.g. calories) or `'state'` (re-logging replaces it). Boolean trackables are idempotent regardless of this setting — logging twice stays "done." |
| `aggregation`     | text      | how entries roll up into a weekly figure: `'sum'` or `'average'` of `value`, `'count'` of days with an entry (**not** a sum of values), or `'last'` entry in the period |
| `target_type`     | text      | `'none'` (no target), `'weekly_count'` (`target_value` is a count of qualifying days per week), or `'specific_days'` (`target_days` lists which weekdays count) |
| `target_days`     | smallint[] | nullable; ISO weekdays (1=Mon..7=Sun) this trackable is expected to be logged on, when `target_type = 'specific_days'`. Null otherwise |
| `bounds_enabled`  | boolean   | whether chart axes/coloring should clamp to an explicit range instead of auto-scaling |
| `bounds_mode`     | text      | `'auto'` (bounds derived from the data) or `'manual'` (use `bound_lower`/`bound_upper` as-is) |
| `bound_lower`     | numeric   | nullable; used when `bounds_enabled` and `bounds_mode = 'manual'` |
| `bound_upper`     | numeric   | nullable; used when `bounds_enabled` and `bounds_mode = 'manual'`. Table check: `bound_lower < bound_upper` whenever both are set |

**Why `value_shape` instead of two separate tables?** Boolean and
numeric trackables share every other column (name, target, color,
entries shape) — splitting them into separate tables would just mean
querying both everywhere. A single `value` column on `entries` covers
both: boolean trackables store `1` for "done," numeric trackables store
the actual amount.

**Why `direction`?** So a calendar/chart can show "green = good" for
both a workout (present = good) and smoking (absent, or a low number =
good) without hardcoding per-trackable logic in the UI — the UI just
reads this column to decide which direction counts as improvement.
`direction` also doubles as the target direction: `build` = floor,
`break` = ceiling.

**Why `relog_semantic`?** Logging the same day twice means different
things for different trackables — a second "500 kcal" entry for
calories should add to the day's total (`cumulative`), but a second
"true" for a boolean habit, or correcting a numeric reading like
weight, should replace the existing value (`state`). This column tells
the client which behavior to use when it re-logs a day; the actual
upsert still goes through the `(trackable_id, entry_date)` unique
constraint below.

> **Migration `0004` (applied 2026-08-22) changed the default to
> `'state'` and converted every existing row.** The user tried both
> behaviours on device and chose replace-only, so **additive re-logging
> is no longer offered anywhere in the UI** and every live row is
> `'state'`.
>
> `'cumulative'` is deliberately still **legal** in the check constraint,
> and `applyRelog()` in `js/aggregate.js` keeps its `cumulative` branch
> and all its Phase 1 tests. Entry rows written before this migration
> were produced additively; narrowing the constraint or deleting the code
> path would make the schema and the code misdescribe how that historical
> data came to exist. Treat `'cumulative'` as dormant-but-supported, not
> as dead — and do not "clean it up" without re-reading this note.

**Why `aggregation` is separate from `value_shape`?** They answer
different questions. `value_shape` is about what a single day's value
looks like; `aggregation` is about how a *range* of days rolls up into
one number for the weekly chart. `count` is called out explicitly
because it is easy to confuse with `sum`: `count` means "how many days
had an entry," not "the sum of their values."

## `entries`

One row per day a trackable has a logged value.

| column         | type        | notes                                                    |
|----------------|-------------|-------------------------------------------------------------|
| `id`           | bigint      | identity primary key                                       |
| `trackable_id` | bigint      | FK -> `trackables.id`, `on delete cascade`                  |
| `entry_date`   | date        | the day being logged (not a timestamp — one entry per day) |
| `value`        | numeric     | boolean trackables: `1` = done. numeric trackables: the amount |
| `note`         | text        | nullable free-text note                                    |
| `created_at`   | timestamptz | default `now()`                                             |
| `updated_at`   | timestamptz | default `now()` — kept current automatically by the `set_updated_at` trigger (see below); the app never needs to set it |
| `source`       | text        | nullable provenance (migration `0006`, 2026-08-25). **`NULL` = logged in the app**; non-null = the id of the import batch that created the row, e.g. `'import:calories-2026-08-25'`. Check constraint `entries_source_nonblank_check` forbids an empty/whitespace value |

**`source` — read this before writing an import or touching
`assertValidEntry`.** The column exists so a bulk CSV import is
reversible. Two non-obvious properties, both verified live on 2026-08-25
rather than assumed:

1. **The app never writes it, and must not start.** `ENTRY_KEYS` in
   `js/api.js` rejects any key outside
   `trackable_id`/`entry_date`/`value`/`note`, so "logged in the app" is
   exactly "`source is null`". Imports are one-off scripts that bypass
   `api.js` entirely.
2. **An app edit to an imported day PRESERVES the batch id.** PostgREST's
   `resolution=merge-duplicates` compiles to `INSERT ... ON CONFLICT DO
   UPDATE SET <only the columns in the request body>`; `source` is never
   in the body, so it is left unchanged. A `BEFORE UPDATE` trigger cannot
   distinguish this case either — in that form `NEW.source` already
   carries the old value.

Consequence: **the naive undo is wrong.**

```sql
-- WRONG: also deletes imported days the user later corrected by hand
delete from public.entries where source = '<batch>';

-- RIGHT: updated_at is bumped by the set_updated_at trigger on every
-- update, so this spares any row touched after the import finished.
delete from public.entries
where source = '<batch>'
  and updated_at < '<the batch's finish timestamp>';
```

Record the finish timestamp when running an import, or only the naive
form is available.

**Unique constraint**: `entries_trackable_id_entry_date_key` on
`(trackable_id, entry_date)` — enforces one entry per trackable per
day. The app should `upsert` (`on_conflict=trackable_id,entry_date` via
PostgREST, or a plain `POST` with `Prefer:
resolution=merge-duplicates`) rather than always `INSERT`, so
re-logging the same day edits it instead of erroring or duplicating —
what that upsert *does* with the incoming value (replace vs. add) is
driven client-side by the parent trackable's `relog_semantic`.

**Index**: `entries_trackable_date_idx` on `(trackable_id, entry_date)`
— supports both the calendar query (all entries for one trackable
across a date range) and the weekly-aggregate query (same, grouped by
week) efficiently.

**`updated_at` trigger**: `set_updated_at()` (a `security definer`-free
`plpgsql` function with `search_path = ''`) fires `before update` on
`entries` and unconditionally sets `new.updated_at = now()`. The app
must not, and does not need to, set `updated_at` itself.

## `app_settings`

Single-row global app configuration — currently just the rolling
window used by default aggregations/views (Step 4.1).

| column                 | type        | notes                                                        |
|------------------------|-------------|---------------------------------------------------------------|
| `id`                   | smallint    | primary key, `check (id = 1)` — exactly one row ever exists   |
| `rolling_window_days`  | integer     | not null, default `90`, `check (rolling_window_days between 14 and 730)` |
| `updated_at`           | timestamptz | not null, default `now()` — kept current by the same `set_updated_at` trigger as `entries` |

Seeded with its one row (`id = 1`) by the migration that created it, so
the client never has to handle a missing-settings case.

## How the planned views read from this

Nothing materialized — both views are a single date-range `SELECT`
against `entries`, aggregated client-side. At personal-app scale (one
user, a handful of trackables, a few years of daily rows at most) this
needs no further optimization.

- **Monthly calendar**: `select entry_date, value from entries where
  trackable_id = :id and entry_date between :month_start and
  :month_end` — map each date to a cell, color it if a row exists
  (boolean) or by magnitude (numeric).
- **Weekly trend chart**: same query over a longer range (bounded by
  `app_settings.rolling_window_days` by default), then group
  client-side by ISO week and roll up per the trackable's
  `aggregation` column (`sum`, `average`, `count` of days logged, or
  `last`).

**What the shipped detail screen actually does (Step D.6b,
2026-09-04).** Opening a trackable loads that trackable's *entire*
`entries` history in one logical request — `js/api.js`'s
`listEntries` pages through PostgREST's 1,000-row `db-max-rows` cap
with `offset`/`limit` under the total order `entry_date, trackable_id`
— and the 3M/6M/1Y/All control and the calendar's month navigation
are then purely client-side filters over that array. Two sizes worth
knowing:

- **Per detail open**: about 100 bytes per row on the wire, so ~100 KB
  and two pages for a trackable with 1,000 daily rows; four pages at
  ten years of daily logging.
- **The localStorage mirror** (`js/store.js`'s `persistCache`)
  serialises every cached entry across all trackables. With ~2,100
  rows (the D.5 import) it is roughly 250 KB; at one row per
  trackable per day it grows about 150 KB/year for four trackables.
  The iOS quota is ~5 MB, so this is fine for well over a decade —
  but it is the number to revisit if trackables multiply or a
  `note`-heavy trackable appears.

## Restorability (migration `0008`, Step D.3)

`trackables.id` and `entries.id` are **`GENERATED BY DEFAULT AS
IDENTITY`**, not `GENERATED ALWAYS`. This is load-bearing, not
cosmetic:

- Postgres rejects an `INSERT` supplying an explicit value for a
  `GENERATED ALWAYS` identity column unless the statement says
  `OVERRIDING SYSTEM VALUE`, and **PostgREST has no way to emit that**.
  Under `ALWAYS`, `scripts/restore.mjs` could not put a row back with its
  original id, so `entries.trackable_id` would have pointed at
  re-assigned trackable ids and every entry would have been orphaned.
- The backup would have looked healthy right up to the moment it was
  needed. This was found by *running* a restore, not by reading the
  schema — which is why Step D.3 requires an executed restore.

**The hazard that comes with `BY DEFAULT`:** restoring explicit ids does
not advance the identity sequence, so the next insert reuses an existing
id and fails on the primary key. `public.daily_resync_identity()` moves
each sequence past the largest id present; `scripts/restore.mjs` calls it
as its final step so it cannot be forgotten. It is safe to run at any
time, including on empty tables.

`app_settings.id` is not an identity column at all — it is a hardcoded
singleton (`check (id = 1)`) — so it needed no change.

## Security status (see also docs/PROJECT_NOTES.md → "Security posture")

`trackables`, `entries`, and `app_settings` each currently have a
single permissive RLS policy (`for all using (true) with check
(true)`) — the anon/publishable key embedded in the client can read,
insert, update, and delete anything in any of them. This mirrors the
original `counter` table's pattern and is being carried forward *as a
known, tracked gap*, not an oversight:

- Fine for now: single user, unlisted URL, no sign-in flow exists yet.
- **Must change before this app stores anything the user would mind
  being exposed if the URL/key leaked** — the fix is Supabase Auth (even
  a single-user email/password or magic-link setup) plus a `user_id`
  column + RLS policies scoped to `auth.uid()`, replacing the `using
  (true)` policies here. Not implemented yet — do this (Step 5.3)
  before adding more sensitive trackables (health specifics,
  journal-style notes) or before ever sharing the URL with anyone else.

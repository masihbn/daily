-- scripts/bootstrap-test-project.sql
--
-- Step D.4. Brings a FRESH, EMPTY Supabase project to exactly the schema
-- that production is on, so the test suite has somewhere to write that is
-- not the database holding the user's only copy of their data.
--
-- HOW TO RUN: Supabase dashboard -> your NEW project -> SQL Editor ->
-- New query -> paste this whole file -> Run. It is one script; run it once.
--
-- WHY THIS IS A REPLAY OF THE MIGRATION HISTORY RATHER THAN A TIDY
-- CONSOLIDATED SCHEMA: this is literally the sequence of statements that
-- produced the live database, concatenated in order. A hand-written
-- "clean" schema would be a second description of the same thing, free to
-- drift from the real one — and a test project whose schema quietly differs
-- from production is worse than no test project, because the suite would go
-- green against the wrong shape. It does mean the script creates `skills`
-- and `skill_entries` and then renames them to `trackables`/`entries`. That
-- detour is the point: same path, same destination.
--
-- DO NOT run this against the production project. It creates tables that
-- already exist there and will fail — harmlessly, but it is not for that.



-- ============================================================
-- 0001_init_counter.sql
-- ============================================================

-- Run this once in the Supabase dashboard: SQL Editor -> New query -> Run.

create table counter (
  id int primary key default 1,
  value int not null default 0,
  updated_at timestamptz not null default now()
);

insert into counter (id, value) values (1, 0);

-- Supabase blocks all table access by default once RLS is on; these
-- policies let the app's anon key read and update the single row.
alter table counter enable row level security;

create policy "anon can read counter"
  on counter for select
  using (true);

create policy "anon can update counter"
  on counter for update
  using (true);


-- ============================================================
-- 0002_skills_tracker.sql
-- ============================================================

-- Skill/habit tracker core schema.
-- Applied live via Supabase MCP on 2026-08-21 — this file is the record
-- of what was run, matching supabase/migrations/0001_init_counter.sql's
-- convention. Run future schema changes as new numbered files here.

create table skills (
  id bigint generated always as identity primary key,
  name text not null,
  -- 'boolean': done/not-done per day (e.g. workout).
  -- 'numeric': a quantity per day (e.g. calories, cigarettes).
  tracking_type text not null default 'boolean'
    check (tracking_type in ('boolean', 'numeric')),
  -- 'build': more is better (workout, reading).
  -- 'break': less is better (smoking) — flips how progress reads on charts.
  direction text not null default 'build'
    check (direction in ('build', 'break')),
  unit text, -- e.g. 'kcal', 'cigarettes'; null for boolean skills
  target_per_week smallint, -- e.g. 4 for "3-4x a week"; null = no target
  color text, -- hex color for calendar/chart display; null = client default
  sort_order integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table skill_entries (
  id bigint generated always as identity primary key,
  skill_id bigint not null references skills(id) on delete cascade,
  entry_date date not null,
  -- boolean skills: 1 = done. numeric skills: the actual amount logged.
  value numeric not null default 1,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (skill_id, entry_date)
);

create index skill_entries_skill_date_idx on skill_entries (skill_id, entry_date);

-- RLS: same permissive pattern as the counter table (anon key = full
-- access, no per-user scoping). Documented as a known gap in
-- PROJECT_NOTES.md / docs/DATA_MODEL.md — fine for solo use against an
-- unlisted URL, must be replaced with auth-scoped policies before this
-- is ever shared or exposed more broadly.
alter table skills enable row level security;
alter table skill_entries enable row level security;

create policy "anon full access to skills"
  on skills for all
  using (true)
  with check (true);

create policy "anon full access to skill_entries"
  on skill_entries for all
  using (true)
  with check (true);


-- ============================================================
-- 0003_trackables.sql
-- ============================================================

-- 0003_trackables.sql
--
-- Reframe "skills" / "skill_entries" into the more general "Daily"
-- vocabulary: trackables / entries. Adds the columns needed for
-- flexible re-log semantics, weekly aggregation, targets (weekly-count
-- or specific-days), and bounded ranges for charting. Also adds a
-- single-row app_settings table (Step 4.1's rolling window) and a
-- trigger so `updated_at` on entries is maintained automatically
-- instead of relying on the app to set it.
--
-- RLS stays permissive (`using (true)`) on every table in this
-- migration — that is an accepted, tracked gap until Step 5.3, not an
-- oversight. Do not tighten it here.
--
-- `public.counter` is untouched — it backs the keepalive workflow.

-- ---------------------------------------------------------------------
-- 1a/1b. Rename tables and columns.
-- ---------------------------------------------------------------------

alter table public.skills rename to trackables;
alter table public.skill_entries rename to entries;

alter table public.trackables rename column tracking_type to value_shape;
alter table public.trackables rename column target_per_week to target_value;
-- Widen: a target can be a large numeric quantity (e.g. 2000 kcal), not
-- just a small weekly count.
alter table public.trackables alter column target_value type numeric;

alter table public.entries rename column skill_id to trackable_id;

-- ---------------------------------------------------------------------
-- 1a. New trackables columns.
-- ---------------------------------------------------------------------

alter table public.trackables
  add column relog_semantic text not null default 'cumulative',
  add column aggregation text not null default 'sum',
  add column target_type text not null default 'none',
  add column target_days smallint[],
  add column bounds_enabled boolean not null default false,
  add column bounds_mode text not null default 'auto',
  add column bound_lower numeric,
  add column bound_upper numeric;

alter table public.trackables
  add constraint trackables_relog_semantic_check
    check (relog_semantic in ('cumulative', 'state')),
  add constraint trackables_aggregation_check
    check (aggregation in ('sum', 'count', 'average', 'last')),
  add constraint trackables_target_type_check
    check (target_type in ('none', 'weekly_count', 'specific_days')),
  -- ISO weekday 1-7 (Mon=1). A subquery/unnest is not legal in a CHECK,
  -- so containment against the full set of valid weekdays is used
  -- instead of validating each array element individually.
  add constraint trackables_target_days_check
    check (target_days is null or target_days <@ array[1,2,3,4,5,6,7]::smallint[]),
  add constraint trackables_bounds_mode_check
    check (bounds_mode in ('manual', 'auto')),
  add constraint trackables_bounds_order_check
    check (bound_lower is null or bound_upper is null or bound_lower < bound_upper);

comment on column public.trackables.value_shape is
  'How a day''s value is captured: ''boolean'' (done/not-done) or ''numeric'' (a quantity).';
comment on column public.trackables.target_value is
  'Nullable numeric target. Meaning depends on target_type (weekly_count: count per week; specific_days: expected value on each target day). Null = no target.';
comment on column public.trackables.relog_semantic is
  'What re-logging the same day does: ''cumulative'' -> new value adds to the existing one (numeric skills like calories); ''state'' -> new value replaces it. Boolean trackables are idempotent regardless (logging twice stays "done").';
comment on column public.trackables.aggregation is
  'How entries roll up into a weekly figure: ''sum'' or ''average'' of value, ''count'' of days with an entry (not a sum of values), or ''last'' entry in the period.';
comment on column public.trackables.target_type is
  '''none'': no target. ''weekly_count'': target_value is a count of qualifying days per week. ''specific_days'': target_days lists which ISO weekdays count.';
comment on column public.trackables.target_days is
  'ISO weekdays (1=Mon..7=Sun) this trackable is expected to be logged on, when target_type = ''specific_days''. Null otherwise.';
comment on column public.trackables.bounds_enabled is
  'Whether chart axes/coloring should clamp to an explicit [bound_lower, bound_upper] range instead of auto-scaling.';
comment on column public.trackables.bounds_mode is
  '''auto'': bounds are derived from the data. ''manual'': bound_lower/bound_upper below are used as-is.';
comment on column public.trackables.bound_lower is
  'Nullable lower bound for charting, used when bounds_enabled and bounds_mode = ''manual''.';
comment on column public.trackables.bound_upper is
  'Nullable upper bound for charting, used when bounds_enabled and bounds_mode = ''manual''.';
comment on column public.trackables.direction is
  'Target direction: ''build'' = floor (hit-or-exceed target_value is good, e.g. workouts). ''break'' = ceiling (stay under target_value is good, e.g. smoking).';

-- ---------------------------------------------------------------------
-- 1c. Rename carried-over constraint/index/sequence/policy names so
-- they match the new table names (renaming a table does not rename
-- these dependent objects).
-- ---------------------------------------------------------------------

alter table public.trackables rename constraint skills_pkey to trackables_pkey;
alter table public.trackables rename constraint skills_tracking_type_check to trackables_value_shape_check;
alter table public.trackables rename constraint skills_direction_check to trackables_direction_check;

alter table public.entries rename constraint skill_entries_pkey to entries_pkey;
alter table public.entries rename constraint skill_entries_skill_id_fkey to entries_trackable_id_fkey;
alter table public.entries rename constraint skill_entries_skill_id_entry_date_key to entries_trackable_id_entry_date_key;

-- skill_entries_skill_date_idx is a plain (non-constraint-backed) index,
-- so unlike the pkey/unique indexes above it is not renamed by the
-- constraint renames and needs an explicit rename.
alter index public.skill_entries_skill_date_idx rename to entries_trackable_date_idx;

alter sequence public.skills_id_seq rename to trackables_id_seq;
alter sequence public.skill_entries_id_seq rename to entries_id_seq;

alter policy "anon full access to skills" on public.trackables rename to "anon full access to trackables";
alter policy "anon full access to skill_entries" on public.entries rename to "anon full access to entries";

-- ---------------------------------------------------------------------
-- 1d. updated_at trigger — removes the "app must set it manually"
-- footgun described in docs/DATA_MODEL.md.
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at
  before update on public.entries
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- 1e. app_settings — single-row global config (Step 4.1's rolling
-- window and any future global settings).
-- ---------------------------------------------------------------------

create table public.app_settings (
  id smallint primary key default 1,
  rolling_window_days integer not null default 90,
  updated_at timestamptz not null default now(),
  constraint app_settings_single_row_check check (id = 1),
  constraint app_settings_rolling_window_days_check
    check (rolling_window_days between 14 and 730)
);

comment on table public.app_settings is
  'Single-row global app configuration. Exactly one row (id = 1) ever exists.';
comment on column public.app_settings.rolling_window_days is
  'How many trailing days the app''s rolling views/aggregations consider by default.';

create trigger set_updated_at
  before update on public.app_settings
  for each row
  execute function public.set_updated_at();

insert into public.app_settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------
-- 1f. RLS — app_settings gets the same permissive policy as every
-- other table in this app during v1. A table with RLS enabled and no
-- policy is stricter than intended here (blocks anon entirely) and a
-- table with RLS disabled gets flagged by the security advisor; the
-- permissive policy is the deliberate, recorded v1 tradeoff (Step 5.3
-- hardens all of this to auth.uid()-scoped policies).
-- ---------------------------------------------------------------------

alter table public.app_settings enable row level security;

create policy "anon full access to app_settings"
  on public.app_settings
  for all
  using (true)
  with check (true);


-- ============================================================
-- 0004_replace_only_relog.sql
-- ============================================================

-- 0004_replace_only_relog.sql
--
-- Replace-only re-logging (user decision 2026-08-22, Step 2.1b). The user
-- tried both additive and replace-only re-logging on device and chose
-- replace-only: re-logging a numeric trackable now REPLACES the day's
-- value going forward. `state` becomes the default for new trackables,
-- and every existing row is switched to it.
--
-- The check constraint (trackables_relog_semantic_check, added in 0003)
-- is deliberately left as-is, still allowing both 'cumulative' and
-- 'state'. Existing entry rows were written under the old additive
-- semantic, and narrowing the constraint would make the schema lie
-- about how that historical data was produced. `applyRelog()` in
-- js/aggregate.js keeps its 'cumulative' branch and all its tests for
-- the same reason — this migration is a data default change, not a
-- removal of the semantic itself.
--
-- `entries` is untouched: a stored value (e.g. Calories = 2000) is
-- still correct under replace semantics — it just reads as "today's
-- total" rather than "the sum of today's logs so far", which was
-- already how a single log of the day looked.
--
-- `public.counter` is untouched — it backs the keepalive workflow.

alter table public.trackables
  alter column relog_semantic set default 'state';

update public.trackables
  set relog_semantic = 'state'
  where relog_semantic <> 'state';


-- ============================================================
-- 0005_target_average_and_icon.sql
-- ============================================================

-- 0005_target_average_and_icon.sql
--
-- Step 2.4 defect fixes (user device testing, 2026-08-23):
--
-- 1. Target type must depend on value_shape (defect 4). Numeric
--    trackables get a new target type, 'weekly_average' ("Average per
--    week") — "Times per week" never made sense for a numeric metric
--    like calories. 'specific_days' stays legal: its UI is still
--    deliberately deferred (see docs/APP_CONCEPT.md), this migration
--    only adds a value to the constraint, it doesn't touch that one.
--
-- 2. An `icon` column is added now so the icon picker planned for the
--    next step needs no second migration. Nothing writes it yet.
--
-- Verified live before writing this file (via the Supabase MCP
-- execute_sql tool, introspecting pg_constraint): the existing check
-- constraint on trackables.target_type is in fact named
-- trackables_target_type_check, with definition
--   CHECK (target_type = ANY (ARRAY['none','weekly_count','specific_days']))
-- so the DROP below targets the real name, not an assumed one. The
-- `drop constraint if exists` is kept anyway as a defensive no-op guard
-- consistent with house style, not because the name was in doubt.
--
-- `entries` and `public.counter` are untouched.

alter table public.trackables
  drop constraint if exists trackables_target_type_check;

alter table public.trackables
  add constraint trackables_target_type_check
  check (target_type in ('none', 'weekly_count', 'specific_days', 'weekly_average'));

alter table public.trackables
  add column if not exists icon text;


-- ============================================================
-- 0006_entry_source.sql
-- ============================================================

-- 0006_entry_source.sql
--
-- Step D.2 (Phase D — daily-use readiness, 2026-08-25).
--
-- Adds provenance to `entries` so the one-off CSV import (Step D.5) is
-- reversible. Without this column, imported rows and hand-logged rows are
-- indistinguishable, and a bad import can only be undone by hand-picking
-- rows the user may have since edited.
--
-- CONTRACT
--   source IS NULL  ->  the row was logged in the app.
--   source = '...'  ->  the row came from an import batch, and the value
--                       is that batch's id, e.g. 'import:calories-2026-08-25'.
--
-- WHY NULL RATHER THAN A DEFAULT LIKE 'app':
-- js/api.js's assertValidEntry() rejects any key outside
-- trackable_id/entry_date/value/note, deliberately — it is what turned the
-- `updated_at` footgun into a hard validation failure. The app therefore
-- never sends `source`, and must not start. A NOT NULL default would mean
-- every app write depends on a database default to fill a column the client
-- pretends does not exist; NULL says the same thing without that coupling.
--
-- WHY NO INDEX:
-- The only query against this column is the undo below, run at most a
-- handful of times ever, against a table expected to hold a few thousand
-- rows after three months of daily logging. A seq scan is instant at that
-- size and an index on a mostly-NULL column is pure write overhead. If
-- `entries` ever grows by an order of magnitude, revisit with a partial
-- index (`where source is not null`), not a full one.
--
-- THE UNDO — and a trap in it worth reading before you use it.
--
-- The naive undo is:
--     delete from public.entries where source = '<batch>';
--
-- That is WRONG if the user has hand-edited any imported day, and here is
-- why. The app upserts via PostgREST `Prefer: resolution=merge-duplicates`,
-- which compiles to INSERT ... ON CONFLICT DO UPDATE SET <only the columns
-- in the request body>. `source` is never in that body, so on conflict it
-- is LEFT UNCHANGED. An imported day the user later corrects in the app
-- therefore keeps its import batch id, and the naive undo would delete the
-- user's correction along with the import.
--
-- A BEFORE UPDATE trigger cannot fix this: in that ON CONFLICT form, NEW.source
-- already carries the old value, so the trigger cannot tell an app edit from
-- an import re-run.
--
-- The safe undo uses `updated_at`, which the existing set_updated_at trigger
-- bumps on every update, to spare rows touched after the import finished:
--
--     delete from public.entries
--     where source = '<batch>'
--       and updated_at < '<the import batch's finish timestamp>';
--
-- Record that timestamp when running an import (Step D.5) — without it the
-- safe form is not available and only the naive one is.

alter table public.entries
  add column if not exists source text;

-- >>> SUPERSEDED BY 0007: the constraint added below uses btrim(), which
-- >>> trims ONLY SPACES, so a tab or newline slipped through. 0007 replaces
-- >>> it with a POSIX-class check. Left here unedited so the migration list
-- >>> stays an honest record of what was actually applied, in order.

-- Guard against an empty or whitespace-only source. Such a row is the worst
-- case: it matches neither `source is null` (so it does not read as an app
-- row) nor `source = '<batch>'` (so it cannot be undone) — it is silently
-- unattributable and unremovable. Cheap to forbid outright.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entries_source_nonblank_check'
      and conrelid = 'public.entries'::regclass
  ) then
    alter table public.entries
      add constraint entries_source_nonblank_check
      check (source is null or length(btrim(source)) > 0);
  end if;
end $$;

comment on column public.entries.source is
  'Provenance. NULL = logged in the app (the app never sets this column; '
  'js/api.js rejects it). Non-null = the id of the import batch that '
  'created the row, e.g. ''import:calories-2026-08-25''. See migration '
  '0006 for the safe-undo query and why the naive one is wrong.';


-- ============================================================
-- 0007_entry_source_blank_fix.sql
-- ============================================================

-- 0007_entry_source_blank_fix.sql
--
-- Step D.2 fix, 2026-08-25. Applied minutes after 0006, in the same session.
--
-- THE BUG: 0006's guard was
--     check (source is null or length(btrim(source)) > 0)
-- and `btrim(text)` with one argument trims ONLY SPACES — not tabs, not
-- newlines, not any other whitespace. So a source of E'\t' or E'\n' has
-- length 1 after btrim, passed the check, and was accepted.
--
-- Why that matters rather than being cosmetic: such a row matches neither
-- `source is null` (so it does not read as an app-logged row) nor
-- `source = '<batch>'` (so no import undo can find it). It is silently
-- unattributable AND unremovable — precisely the state 0006's guard existed
-- to make impossible.
--
-- Found by tests/integration/entry-source.test.mjs, which fuzzes the guard
-- with '', '   ', E'\t' and E'\n  ' rather than just the empty string. The
-- tab case failed. Recorded here because "btrim trims spaces only" is the
-- kind of thing that reads as correct in review and is not.
--
-- THE FIX: require at least one non-whitespace character, using a POSIX
-- class so every whitespace character is covered rather than an enumerated
-- list that will miss one.
--
--   source ~ '[^[:space:]]'
--
-- No table rewrite concern: `entries` holds 0 rows at the time this is
-- applied, and even at three months of daily logging it is a few thousand.

alter table public.entries
  drop constraint if exists entries_source_nonblank_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'entries_source_nonblank_check'
      and conrelid = 'public.entries'::regclass
  ) then
    alter table public.entries
      add constraint entries_source_nonblank_check
      check (source is null or source ~ '[^[:space:]]');
  end if;
end $$;


-- ============================================================
-- 0008_restorable_identity.sql
-- ============================================================

-- 0008_restorable_identity.sql
--
-- Step D.3, 2026-08-25. Makes the database restorable from a backup.
--
-- THE PROBLEM, found by actually trying to restore rather than by reading:
-- trackables.id and entries.id were GENERATED ALWAYS AS IDENTITY. Postgres
-- rejects an INSERT that supplies an explicit value for such a column unless
-- the statement says OVERRIDING SYSTEM VALUE — and PostgREST has no way to
-- emit that. So scripts/restore.mjs could not put a row back with its
-- original id, and any FK relationship in the dump (entries.trackable_id ->
-- trackables.id) would have been broken by re-assignment.
--
-- The backup would have looked perfectly healthy and been unusable at
-- exactly the moment it was needed. This is why Step D.3 requires the
-- restore to be executed, not just written.
--
-- THE FIX: GENERATED BY DEFAULT AS IDENTITY. Identical behaviour when the
-- client omits `id` (the app always does), but an explicit id is now
-- accepted. This is the normal choice for any table that must survive a
-- dump/restore cycle.
--
-- THE SEQUENCE HAZARD THAT COMES WITH IT: restoring explicit ids does not
-- advance the identity sequence, so the next app insert would reuse an id
-- that already exists and fail on the primary key. Anyone who has restored a
-- Postgres dump has hit this. daily_resync_identity() below fixes it, and
-- scripts/restore.mjs calls it as its last step so it cannot be forgotten.
--
-- app_settings.id is deliberately NOT an identity column (it is a hardcoded
-- singleton with `check (id = 1)`), so it needs neither change.

alter table public.trackables alter column id set generated by default;
alter table public.entries    alter column id set generated by default;

-- Re-points each identity sequence just past the largest id present, so the
-- next generated id cannot collide with a restored row. Safe to run any time,
-- including when a table is empty (setval falls back to 1 with is_called
-- false, so the next value is 1).
--
-- search_path is pinned to '' and every name is schema-qualified: an
-- unpinned search_path on a function is a standing privilege-escalation
-- footgun and Supabase's own advisors flag it.
create or replace function public.daily_resync_identity()
returns table (table_name text, next_id bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t text;
  max_id bigint;
begin
  foreach t in array array['trackables', 'entries'] loop
    execute format('select coalesce(max(id), 0) from public.%I', t) into max_id;
    perform setval(
      pg_get_serial_sequence(format('public.%I', t), 'id'),
      greatest(max_id, 1),
      max_id > 0
    );
    table_name := t;
    next_id := max_id + 1;
    return next;
  end loop;
end;
$$;

comment on function public.daily_resync_identity() is
  'Re-points trackables/entries identity sequences past the largest existing '
  'id. Called by scripts/restore.mjs after a restore, because restoring '
  'explicit ids does not advance the sequence. See migration 0008.';

-- NOTE FOR STEP D.7 (RLS hardening): this function is currently executable by
-- PUBLIC, which matches the wide-open policies on every table today. It only
-- resyncs sequences and leaks nothing, but revoke it from anon along with the
-- rest of the tightening rather than leaving it as the one thing still open.

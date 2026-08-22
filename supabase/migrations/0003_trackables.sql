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

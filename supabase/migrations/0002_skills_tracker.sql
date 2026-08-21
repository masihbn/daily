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

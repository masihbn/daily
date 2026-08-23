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

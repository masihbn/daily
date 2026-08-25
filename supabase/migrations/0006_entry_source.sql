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

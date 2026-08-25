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

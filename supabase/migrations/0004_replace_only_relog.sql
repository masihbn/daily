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

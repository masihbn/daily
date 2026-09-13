-- 0010_owner_policies.sql — Step D.7 part 2. Replaces every using (true) policy with
-- owner-scoped ones. counter keeps an anon READ policy: the keepalive workflow in
-- .github/workflows/supabase-keepalive.yml pings it with the anon key, and if that
-- starts failing the free project auto-pauses about a week later with no other symptom.
--
-- (select auth.uid()) rather than auth.uid(): Postgres evaluates the subquery once per
-- statement instead of once per row (Supabase advisor 0003_auth_rls_initplan).

drop policy if exists "anon full access to trackables"   on public.trackables;
drop policy if exists "anon full access to entries"      on public.entries;
drop policy if exists "anon full access to app_settings" on public.app_settings;
drop policy if exists "anon can update counter"          on public.counter;
-- "anon can read counter" is intentionally kept.

create policy "owner can select trackables" on public.trackables for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert trackables" on public.trackables for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update trackables" on public.trackables for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete trackables" on public.trackables for delete to authenticated using ((select auth.uid()) = user_id);

create policy "owner can select entries" on public.entries for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert entries" on public.entries for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update entries" on public.entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete entries" on public.entries for delete to authenticated using ((select auth.uid()) = user_id);

create policy "owner can select app_settings" on public.app_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "owner can insert app_settings" on public.app_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "owner can update app_settings" on public.app_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owner can delete app_settings" on public.app_settings for delete to authenticated using ((select auth.uid()) = user_id);

-- Belt and braces: the anon role loses the tables at the grant level too, so a signed-out
-- request fails loudly (401/403) instead of returning an empty list that looks like "no data".
revoke all on table public.trackables, public.entries, public.app_settings from anon;
revoke update on table public.counter from anon;

-- Migration 0008 left this callable by PUBLIC. It leaks nothing, but close it with the rest.
revoke execute on function public.daily_resync_identity() from public, anon;
grant  execute on function public.daily_resync_identity() to authenticated, service_role;

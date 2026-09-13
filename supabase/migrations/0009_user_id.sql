-- 0009_user_id.sql — Step D.7 part 1 (additive). See docs/BUILD_PLAN.md Step D.7.
-- Adds user_id to the three data tables, backfills it with the ONLY auth user, then
-- makes it NOT NULL. Policies are untouched here (0010 flips them), so an app that
-- has not yet updated keeps working between the two migrations.
--
-- PRECONDITION: exactly one row in auth.users. The account is created in the Supabase
-- dashboard (Authentication -> Users -> Add user, "Auto Confirm User" on) BEFORE this runs.

do $$
declare n integer;
begin
  select count(*) into n from auth.users;
  if n <> 1 then
    raise exception 'migration 0009 expects exactly one row in auth.users, found %', n;
  end if;
end $$;

alter table public.trackables   add column user_id uuid references auth.users(id) on delete restrict default auth.uid();
alter table public.entries      add column user_id uuid references auth.users(id) on delete restrict default auth.uid();
alter table public.app_settings add column user_id uuid references auth.users(id) on delete restrict default auth.uid();

update public.trackables   set user_id = (select id from auth.users) where user_id is null;
update public.entries      set user_id = (select id from auth.users) where user_id is null;
update public.app_settings set user_id = (select id from auth.users) where user_id is null;

alter table public.trackables   alter column user_id set not null;
alter table public.entries      alter column user_id set not null;
alter table public.app_settings alter column user_id set not null;

create index if not exists trackables_user_id_idx on public.trackables (user_id);
create index if not exists entries_user_id_idx    on public.entries (user_id);

comment on column public.trackables.user_id   is 'Owner. Defaults to auth.uid(); the app never sends it. Step D.7.';
comment on column public.entries.user_id      is 'Owner. Defaults to auth.uid(); the app never sends it. Step D.7.';
comment on column public.app_settings.user_id is 'Owner. Defaults to auth.uid(); the app never sends it. Step D.7.';

-- on delete restrict is deliberate: deleting the auth user must fail while data
-- exists, not cascade three years of history away.

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

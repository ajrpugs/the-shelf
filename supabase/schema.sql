-- Run this in the Supabase SQL editor (or `supabase db push` after saving as a migration).

-- 1. Tables --------------------------------------------------------------

create table if not exists public.shelf_state (
  id int primary key,
  data jsonb not null default '{"roster":[],"eliminated":[],"history":[],"cycleNumber":1}'::jsonb,
  updated_at timestamptz default now()
);

insert into public.shelf_state (id, data)
values (1, '{"roster":[],"eliminated":[],"history":[],"cycleNumber":1}'::jsonb)
on conflict (id) do nothing;

create table if not exists public.shelf_submissions (
  member_name text primary key,
  book text not null,
  updated_at timestamptz default now()
);

-- 2. Row-Level Security --------------------------------------------------

alter table public.shelf_state enable row level security;
alter table public.shelf_submissions enable row level security;

-- Anyone can read shelf_state; only the edge function (service role) writes.
drop policy if exists "shelf_state read for all" on public.shelf_state;
create policy "shelf_state read for all"
  on public.shelf_state for select
  to anon, authenticated
  using (true);

-- Anyone can read submissions; anyone can insert/update/delete their own book pick.
-- This is the honor-system entry point: identity is not verified, but it means
-- book recommendations don't require the admin password.
drop policy if exists "shelf_submissions read for all" on public.shelf_submissions;
create policy "shelf_submissions read for all"
  on public.shelf_submissions for select
  to anon, authenticated
  using (true);

drop policy if exists "shelf_submissions write for all" on public.shelf_submissions;
create policy "shelf_submissions write for all"
  on public.shelf_submissions for insert
  to anon, authenticated
  with check (true);

drop policy if exists "shelf_submissions update for all" on public.shelf_submissions;
create policy "shelf_submissions update for all"
  on public.shelf_submissions for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "shelf_submissions delete for all" on public.shelf_submissions;
create policy "shelf_submissions delete for all"
  on public.shelf_submissions for delete
  to anon, authenticated
  using (true);

-- 3. Realtime ------------------------------------------------------------

alter publication supabase_realtime add table public.shelf_state;
alter publication supabase_realtime add table public.shelf_submissions;

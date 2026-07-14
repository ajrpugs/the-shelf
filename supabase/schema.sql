-- The Shelf — Supabase schema.
-- Run this in the SQL editor (or `supabase db push` after saving as a migration).

-- 1. shelf_state -----------------------------------------------------------

create table if not exists public.shelf_state (
  id int primary key,
  data jsonb not null default '{"eliminated":[],"history":[],"roundNumber":1}'::jsonb,
  updated_at timestamptz default now()
);

insert into public.shelf_state (id, data)
values (1, '{"eliminated":[],"history":[],"roundNumber":1}'::jsonb)
on conflict (id) do nothing;

alter table public.shelf_state enable row level security;

drop policy if exists "shelf_state read for all" on public.shelf_state;
create policy "shelf_state read for all"
  on public.shelf_state for select
  to anon, authenticated
  using (true);

-- 2. shelf_users -----------------------------------------------------------
-- One row per signed-in reader. Populated by the client on first sign-in.

create table if not exists public.shelf_users (
  id uuid primary key references auth.users(id) on delete cascade,
  discord_username text not null default 'Reader',
  avatar_url text,
  book text,
  updated_at timestamptz default now()
);

alter table public.shelf_users enable row level security;

drop policy if exists "shelf_users read for all" on public.shelf_users;
create policy "shelf_users read for all"
  on public.shelf_users for select
  to anon, authenticated
  using (true);

drop policy if exists "shelf_users insert self" on public.shelf_users;
create policy "shelf_users insert self"
  on public.shelf_users for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "shelf_users update self" on public.shelf_users;
create policy "shelf_users update self"
  on public.shelf_users for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 3. Drop the old shelf_submissions table (books live on shelf_users now) --

drop table if exists public.shelf_submissions cascade;

-- 4. Reset shelf_state so old name-based eliminated entries don't stick ----

update public.shelf_state
set data = '{"eliminated":[],"history":[],"roundNumber":1}'::jsonb
where id = 1;

-- 5. Realtime --------------------------------------------------------------

alter publication supabase_realtime add table public.shelf_state;
alter publication supabase_realtime add table public.shelf_users;

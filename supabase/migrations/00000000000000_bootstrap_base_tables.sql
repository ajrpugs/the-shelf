-- Bootstrap: the two tables every later migration assumes already exist.
--
-- Phase 4 prep. `supabase/migrations/` was never a complete history: the app's
-- original tables were created by pasting supabase/schema.sql into the SQL
-- editor (README step 2), and the first real migration
-- (20260714021113_add_discord_id_column) opens with `alter table
-- public.shelf_users`. So a from-scratch apply -- `supabase db reset`, or
-- standing up a second environment -- died immediately with
-- `relation "public.shelf_users" does not exist`.
--
-- That mattered the moment Phase 4 started: Phase 4 is about *creating clubs*,
-- so it needs somewhere to make throwaway clubs, invites and second-club
-- fixtures that isn't the live book club. There was no such place.
--
-- This migration is deliberately the minimum that lets the existing chain
-- replay: `shelf_state` and `shelf_users` exactly as they were BEFORE migration
-- 20260714021113 -- note no `discord_id` on shelf_users, since that migration is
-- what adds it, and no `version`/`club_id` on shelf_state, added later by
-- 20260724150000 and 20260724160000. Everything after this point is already
-- described by the migrations that follow, so nothing here should ever be
-- extended; new schema goes in a new migration.
--
-- Safe if it ever runs against a populated database: every statement is
-- `if not exists` or `on conflict do nothing`, and there are no updates or
-- deletes. On production it is recorded as already-applied via
-- `supabase migration repair --status applied 00000000000000` rather than run,
-- because production has had these tables since before the repo existed.

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

-- One row per signed-in reader. discord_id is added by 20260714021113.
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

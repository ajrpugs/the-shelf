-- Phase 1 of docs/multi-tenant-plan.md: profiles, one of the two remaining
-- schema gaps flagged in that doc's Phase 1 status line. Identity separate
-- from any one club, matching the sketch in the plan's §2.
--
-- Additive only, same pattern as club_members slice 2
-- (20260724170000_add_club_members_table.sql): a one-time snapshot backfill,
-- NOT a live mirror. shelf_users stays the live source of truth for reads/
-- writes until something (Phase 5, more auth providers) actually consumes
-- this table -- whichever slice starts consuming it must refresh this
-- backfill (or add real dual-writes) first, or it'll be working from stale
-- data.
--
-- Purely additive; safe to re-run.

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Reader',
  avatar_url   text,
  discord_id   text unique,
  updated_at   timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles read for all" on public.profiles;
create policy "profiles read for all"
  on public.profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "profiles insert self" on public.profiles;
create policy "profiles insert self"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles update self" on public.profiles;
create policy "profiles update self"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

insert into public.profiles (id, display_name, avatar_url, discord_id)
select id, discord_username, avatar_url, discord_id
from public.shelf_users
on conflict (id) do nothing;

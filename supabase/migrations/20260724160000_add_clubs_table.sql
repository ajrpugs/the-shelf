-- Phase 1 of docs/multi-tenant-plan.md, slice 1: additive club scoping.
-- Adds a `clubs` table and a `club_id` column (constant-defaulted, so it's
-- invisible to the running app) on the tables that hold actual per-club
-- content. No RLS changes, no query scoping, no application code changes --
-- this is schema-only groundwork. The real "prove isolation between clubs"
-- work (RLS rewrite + policy tests) is a deliberately separate later slice.
--
-- The one existing club gets a fixed, hardcoded id (not gen_random_uuid())
-- so every `default` clause below can reference the exact same value --
-- same pattern as shelf_state's fixed `id = 1` singleton.
--
-- Purely additive; safe to re-run.

create table if not exists public.clubs (
  id         uuid primary key,
  slug       text not null unique,
  name       text not null,
  created_at timestamptz default now()
);

insert into public.clubs (id, slug, name)
values ('8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8', 'the-shelf', 'The Shelf')
on conflict (id) do nothing;

alter table public.clubs enable row level security;

drop policy if exists "clubs read for all" on public.clubs;
create policy "clubs read for all"
  on public.clubs for select
  to anon, authenticated
  using (true);

-- club_id on every table that holds actual per-club content. A constant
-- default means Postgres back-fills every existing row AND every future
-- insert automatically -- no manual UPDATE, and no application code needs to
-- know this column exists yet. shelf_users/shelf_librarians are deliberately
-- untouched: splitting them into profiles/club_members only matters once a
-- person can join a second club (Phase 4 territory), not before.

alter table public.reads
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_state
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_reviews
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_comments
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

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
  discord_id text,
  updated_at timestamptz default now()
);
create index if not exists shelf_users_discord_id_idx on public.shelf_users(discord_id);

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

-- 5. shelf_reviews ---------------------------------------------------------
-- One rubric review per (read, reader). A "read" is a shelf_state.history
-- entry, keyed by its ts. Each category scores 1..20 (The Bibliomancer's Guild
-- Review Rubric); the app averages them into a /100 Guild score. Writes go
-- through the set-review edge function, but self-write policies are kept for
-- parity with shelf_users.

create table if not exists public.shelf_reviews (
  book_ts text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  plot int2 not null check (plot between 1 and 20),
  characters int2 not null check (characters between 1 and 20),
  pacing int2 not null check (pacing between 1 and 20),
  language int2 not null check (language between 1 and 20),
  themes int2 not null check (themes between 1 and 20),
  note text,
  updated_at timestamptz default now(),
  primary key (book_ts, user_id)
);
create index if not exists shelf_reviews_book_ts_idx on public.shelf_reviews(book_ts);

alter table public.shelf_reviews enable row level security;

drop policy if exists "shelf_reviews read for all" on public.shelf_reviews;
create policy "shelf_reviews read for all"
  on public.shelf_reviews for select
  to anon, authenticated
  using (true);

drop policy if exists "shelf_reviews insert self" on public.shelf_reviews;
create policy "shelf_reviews insert self"
  on public.shelf_reviews for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "shelf_reviews update self" on public.shelf_reviews;
create policy "shelf_reviews update self"
  on public.shelf_reviews for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "shelf_reviews delete self" on public.shelf_reviews;
create policy "shelf_reviews delete self"
  on public.shelf_reviews for delete
  to authenticated
  using (auth.uid() = user_id);

-- 6. shelf_comments --------------------------------------------------------
-- Per-book discussion threads, keyed to a read by its history ts. Writes go
-- through the post-comment edge function.

create table if not exists public.shelf_comments (
  id uuid primary key default gen_random_uuid(),
  book_ts text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz default now()
);
create index if not exists shelf_comments_book_ts_idx on public.shelf_comments(book_ts, created_at);

alter table public.shelf_comments enable row level security;

drop policy if exists "shelf_comments read for all" on public.shelf_comments;
create policy "shelf_comments read for all"
  on public.shelf_comments for select
  to anon, authenticated
  using (true);

drop policy if exists "shelf_comments insert self" on public.shelf_comments;
create policy "shelf_comments insert self"
  on public.shelf_comments for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "shelf_comments delete self" on public.shelf_comments;
create policy "shelf_comments delete self"
  on public.shelf_comments for delete
  to authenticated
  using (auth.uid() = user_id);

-- 7. shelf_librarians ------------------------------------------------------
-- Who may perform admin actions. Presence of a row = librarian; this replaces
-- the old shared ADMIN_PASSWORD. Roles deliberately do NOT live on shelf_users:
-- that table has an "update self" policy, so a member could self-promote by
-- patching their own row. This table has NO write policy at all, so grants and
-- revokes are service-role only (unspoofable from the anon/authenticated API).
-- Any signed-in user may read the librarian list (the Admin grant/revoke UI
-- needs it, and who the librarians are isn't sensitive).

create table if not exists public.shelf_librarians (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz default now()
);

alter table public.shelf_librarians enable row level security;

drop policy if exists "shelf_librarians read for authenticated" on public.shelf_librarians;
create policy "shelf_librarians read for authenticated"
  on public.shelf_librarians for select
  to authenticated
  using (true);

-- 8. reads -------------------------------------------------------------
-- Phase 0 of docs/multi-tenant-plan.md: replaces shelf_state.data.history as
-- the source of truth for past reads. `ts` is plain TEXT (not timestamptz) --
-- shelf_reviews.book_ts / shelf_comments.book_ts already store this exact
-- string from the client's toISOString() calls, and a timestamptz would
-- re-serialize differently (+00:00 vs Z) on read, silently breaking every
-- review/comment join. The backfill is idempotent (on conflict (ts) do
-- nothing) and tolerant of legacy shapes (name-based winner_id,
-- cycle/cycleNumber) the same way normalizeState is; the regex is a
-- data-quality guard, not a cast-safety requirement.

create table if not exists public.reads (
  id               uuid primary key default gen_random_uuid(),
  round            int not null,
  winner_id        uuid references auth.users(id) on delete set null,
  winner_username  text not null default 'Reader',
  book             text not null default '',
  ts               text not null unique,
  rating           jsonb,
  ratings_open     boolean not null default false,
  meetings         jsonb,
  created_at       timestamptz default now()
);

insert into public.reads (round, winner_id, winner_username, book, ts, rating, ratings_open, meetings)
select
  coalesce((h->>'round')::int, (h->>'cycle')::int, 1),
  case
    when h->>'winner_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then (h->>'winner_id')::uuid
    else null
  end,
  coalesce(nullif(h->>'winner_username', ''), nullif(h->>'winner', ''), 'Reader'),
  coalesce(h->>'book', ''),
  h->>'ts',
  h->'rating',
  coalesce((h->>'ratingsOpen')::boolean, false),
  h->'meetings'
from public.shelf_state, jsonb_array_elements(coalesce(data->'history', '[]'::jsonb)) as h
where id = 1
  and h->>'ts' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
on conflict (ts) do nothing;

alter table public.reads enable row level security;

drop policy if exists "reads read for all" on public.reads;
create policy "reads read for all"
  on public.reads for select
  to anon, authenticated
  using (true);

-- 9. shelf_state.version ----------------------------------------------------
-- Optimistic-locking token for shelf_state, guarding against two concurrent
-- admin actions clobbering each other now that history has moved out to a
-- table of its own (shelf_state.data shrinks to just eliminated/roundNumber).

alter table public.shelf_state add column if not exists version int not null default 0;

-- 10. clubs ------------------------------------------------------------
-- Phase 1 of docs/multi-tenant-plan.md, slice 1: additive club scoping. A
-- `clubs` table plus a `club_id` column (constant-defaulted, so existing rows
-- and the running app are unaffected) on every table holding per-club
-- content. No RLS changes, no query scoping yet -- see the migration's header
-- comment for the full rationale. shelf_users/shelf_librarians are
-- deliberately untouched (that split only matters once a second club exists).

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

alter table public.reads
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_state
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_reviews
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

alter table public.shelf_comments
  add column if not exists club_id uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id);

-- 11. Realtime --------------------------------------------------------------

alter publication supabase_realtime add table public.shelf_state;
alter publication supabase_realtime add table public.shelf_users;
alter publication supabase_realtime add table public.shelf_reviews;
alter publication supabase_realtime add table public.shelf_comments;
alter publication supabase_realtime add table public.reads;

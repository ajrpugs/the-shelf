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

-- 6b. shelf_comment_reactions ----------------------------------------------
-- Emoji reactions on comments. No service-role logic or Discord side effects,
-- so signed-in readers write these straight to the table under RLS (add/remove
-- only their own). See migration 20260725120000_add_comment_reactions.sql.

create table if not exists public.shelf_comment_reactions (
  comment_id uuid not null references public.shelf_comments(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  club_id    uuid not null default '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8' references public.clubs(id),
  primary key (comment_id, user_id, emoji)
);
create index if not exists shelf_comment_reactions_comment_idx
  on public.shelf_comment_reactions(comment_id);

alter table public.shelf_comment_reactions enable row level security;

drop policy if exists "comment_reactions read for all" on public.shelf_comment_reactions;
create policy "comment_reactions read for all"
  on public.shelf_comment_reactions for select
  to anon, authenticated
  using (true);

drop policy if exists "comment_reactions insert self" on public.shelf_comment_reactions;
create policy "comment_reactions insert self"
  on public.shelf_comment_reactions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "comment_reactions delete self" on public.shelf_comment_reactions;
create policy "comment_reactions delete self"
  on public.shelf_comment_reactions for delete
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
values ('8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8', 'the-guild', 'The Guild')
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

-- 11. club_members -----------------------------------------------------
-- Phase 1 of docs/multi-tenant-plan.md, slice 2: backing table for the
-- is_member()/is_librarian() RLS policy functions a later slice will add.
-- Additive only -- no RLS policy elsewhere reads this table yet, and nothing
-- writes to it yet (shelf_users/shelf_librarians stay the live source of
-- truth). This backfill is a one-time snapshot, not a live mirror -- see the
-- migration file for why, and what must happen before anything relies on it.

create table if not exists public.club_members (
  club_id    uuid not null references public.clubs(id),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('librarian', 'member')),
  book       text,
  joined_at  timestamptz default now(),
  primary key (club_id, user_id)
);

insert into public.club_members (club_id, user_id, role, book, joined_at)
select
  '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8',
  su.id,
  case when sl.user_id is not null then 'librarian' else 'member' end,
  su.book,
  su.updated_at
from public.shelf_users su
left join public.shelf_librarians sl on sl.user_id = su.id
on conflict (club_id, user_id) do nothing;

alter table public.club_members enable row level security;

drop policy if exists "club_members read for all" on public.club_members;
create policy "club_members read for all"
  on public.club_members for select
  to anon, authenticated
  using (true);

-- 12. Realtime --------------------------------------------------------------

alter publication supabase_realtime add table public.shelf_state;
alter publication supabase_realtime add table public.shelf_users;
alter publication supabase_realtime add table public.shelf_reviews;
alter publication supabase_realtime add table public.shelf_comments;
alter publication supabase_realtime add table public.shelf_comment_reactions;
alter publication supabase_realtime add table public.reads;

-- 13. shelf_reviews.dnf ------------------------------------------------
-- A reader can flag a read as "didn't finish" instead of scoring it. DNF
-- rows carry no rubric scores, so the five score columns become nullable;
-- the check constraint keeps a scored review (all five present) and a DNF
-- review (none present) mutually exclusive.

alter table public.shelf_reviews
  alter column plot drop not null,
  alter column characters drop not null,
  alter column pacing drop not null,
  alter column language drop not null,
  alter column themes drop not null;

alter table public.shelf_reviews
  add column if not exists dnf boolean not null default false;

alter table public.shelf_reviews
  drop constraint if exists shelf_reviews_dnf_scores_chk;
alter table public.shelf_reviews
  add constraint shelf_reviews_dnf_scores_chk
  check (
    (dnf and plot is null and characters is null and pacing is null and language is null and themes is null)
    or
    (not dnf and plot is not null and characters is not null and pacing is not null and language is not null and themes is not null)
  );

-- 14. Club scoping, for real -------------------------------------------
-- Phase 1 of docs/multi-tenant-plan.md, slice 3. See
-- 20260726180000_club_scoping_rls.sql for the full rationale: adds
-- clubs.visibility (defaulted 'public' so the existing club stays
-- anon-readable), is_member() (is_librarian() deferred to Phase 2, unused
-- until then), a fresh live club_members backfill, and swaps the
-- `using (true)` select policy on reads/shelf_state/shelf_reviews/
-- shelf_comments/shelf_comment_reactions/club_members for one that checks
-- club membership or public visibility. clubs itself and
-- shelf_users/shelf_librarians are untouched.

alter table public.clubs
  add column if not exists visibility text not null default 'public'
  check (visibility in ('public', 'private'));

create or replace function public.is_member(club uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.club_members
    where club_id = club and user_id = auth.uid()
  );
$$;

insert into public.club_members (club_id, user_id, role, book, joined_at)
select
  '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8',
  su.id,
  case when sl.user_id is not null then 'librarian' else 'member' end,
  su.book,
  su.updated_at
from public.shelf_users su
left join public.shelf_librarians sl on sl.user_id = su.id
on conflict (club_id, user_id) do update
  set role = excluded.role,
      book = excluded.book;

drop policy if exists "reads read for all" on public.reads;
create policy "reads read for all"
  on public.reads for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

drop policy if exists "shelf_state read for all" on public.shelf_state;
create policy "shelf_state read for all"
  on public.shelf_state for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

drop policy if exists "shelf_reviews read for all" on public.shelf_reviews;
create policy "shelf_reviews read for all"
  on public.shelf_reviews for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

drop policy if exists "shelf_comments read for all" on public.shelf_comments;
create policy "shelf_comments read for all"
  on public.shelf_comments for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

drop policy if exists "comment_reactions read for all" on public.shelf_comment_reactions;
create policy "comment_reactions read for all"
  on public.shelf_comment_reactions for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

drop policy if exists "club_members read for all" on public.club_members;
create policy "club_members read for all"
  on public.club_members for select
  to anon, authenticated
  using (
    is_member(club_id)
    or exists (select 1 from public.clubs c where c.id = club_id and c.visibility = 'public')
  );

-- 15. Threaded replies ---------------------------------------------------
-- Single-level threaded replies on shelf_comments. See
-- 20260726190000_add_comment_parent.sql for the full rationale.

alter table public.shelf_comments
  add column if not exists parent_id uuid references public.shelf_comments(id) on delete cascade;

-- 16. profiles ------------------------------------------------------------
-- Phase 1 of docs/multi-tenant-plan.md: identity separate from any one club.
-- Additive only -- a one-time snapshot backfill from shelf_users, not a live
-- mirror; shelf_users stays the live source of truth until something
-- (Phase 5, more auth providers) actually consumes this table. See
-- 20260726200000_add_profiles_table.sql for the full rationale.

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

-- 17. club_secrets --------------------------------------------------------
-- Phase 1 of docs/multi-tenant-plan.md: per-club secrets (Discord webhook,
-- calendar token), unreachable from anon/authenticated -- no RLS policies at
-- all, service-role only. Additive only -- nothing reads discord_webhook_url
-- or calendar_token yet (Phase 6). See
-- 20260726210000_add_club_secrets_table.sql for the full rationale.

create table if not exists public.club_secrets (
  club_id             uuid primary key references public.clubs(id),
  discord_webhook_url text,
  calendar_token      text not null unique default gen_random_uuid()::text
);

alter table public.club_secrets enable row level security;

insert into public.club_secrets (club_id)
values ('8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8')
on conflict (club_id) do nothing;

-- 18. Rename the seeded club -----------------------------------------------
-- "The Shelf" -> "The Guild" (the app itself keeps the name "The Shelf";
-- see 20260727120000_rename_default_club.sql for the full rationale).

update public.clubs
set name = 'The Guild'
where id = '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8';

-- 19. Rename the seeded club's slug ----------------------------------------
-- 'the-shelf' -> 'the-guild', to match the name change above. See
-- 20260727130000_rename_default_club_slug.sql for the full rationale.

update public.clubs
set slug = 'the-guild'
where id = '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8';

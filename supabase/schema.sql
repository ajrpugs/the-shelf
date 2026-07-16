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

-- 7. Realtime --------------------------------------------------------------

alter publication supabase_realtime add table public.shelf_state;
alter publication supabase_realtime add table public.shelf_users;
alter publication supabase_realtime add table public.shelf_reviews;
alter publication supabase_realtime add table public.shelf_comments;

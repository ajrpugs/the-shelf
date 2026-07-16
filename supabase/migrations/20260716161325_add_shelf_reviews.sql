-- Member rubric reviews. One row per (read, reader); a "read" is a
-- shelf_state.history entry keyed by its ts. Each category scores 1..20
-- (The Bibliomancer's Guild Review Rubric); the app averages them into a
-- /100 Guild score. Additive only — does not touch existing data.

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

-- Add to the realtime publication (idempotent guard).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shelf_reviews'
  ) then
    alter publication supabase_realtime add table public.shelf_reviews;
  end if;
end $$;

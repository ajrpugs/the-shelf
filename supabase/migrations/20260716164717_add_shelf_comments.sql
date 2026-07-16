-- Per-book discussion threads. One row per comment, keyed to a read by its
-- history ts. Writes go through the post-comment edge function; self-write
-- policies kept for parity with the other tables.

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

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shelf_comments'
  ) then
    alter publication supabase_realtime add table public.shelf_comments;
  end if;
end $$;

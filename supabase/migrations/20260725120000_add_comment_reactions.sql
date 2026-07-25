-- Emoji reactions on discussion comments.
-- Unlike comments (which post through an edge function), reactions carry no
-- service-role logic or Discord side effects, so a signed-in reader writes them
-- straight to the table under RLS — insert / delete only their own rows.

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

alter publication supabase_realtime add table public.shelf_comment_reactions;

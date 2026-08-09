-- Phase 3.5 of docs/multi-tenant-plan.md: club_members becomes the source of
-- truth for club membership and for a reader's current book.
--
-- Until now `draw` pulled its eligible-reader pool straight from shelf_users,
-- which has no club_id at all -- so club #2's wheel would have spun up every
-- reader of every club, and one person could only ever hold one book across all
-- their clubs. club_members already carries both (role and book) and has been
-- dual-written best-effort since Phase 1 slice 3. Two things have to be true
-- before anything can *read* from it:
--
--   1. Every existing reader needs a row. The dual-writes only fire when
--      someone sets a book or has their role changed, so a reader who signed in
--      after slice 3 and never set a book has no membership row at all -- they
--      would silently vanish from the shelf (and from the wheel) the moment the
--      client starts sourcing membership here. Hence the fresh backfill below,
--      same shape as slice 3's.
--
--   2. New readers need a way to create their own row. club_members has no
--      insert policy on purpose (same reasoning as shelf_librarians' write
--      side), and a blanket "insert yourself into any club" policy is exactly
--      what Phase 4's invite flow has to gate. join_default_club() is the
--      narrow version: security-definer, takes no arguments, and can only ever
--      add *the caller* to *the one seeded club* as a plain member. That
--      preserves today's behavior, where signing in puts you on the shelf.
--      Phase 4 replaces it with an invite-gated join.
--
-- shelf_users keeps its `book` column and keeps being written as a legacy
-- mirror -- see the edge functions. It is no longer read for the draw pool.

insert into public.club_members (club_id, user_id, role, book, joined_at)
select
  '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8',
  su.id,
  case when sl.user_id is not null then 'librarian' else 'member' end,
  su.book,
  su.updated_at
from public.shelf_users su
left join public.shelf_librarians sl on sl.user_id = su.id
-- shelf_users wins on conflict: it is still the authoritative side at the
-- moment this runs (the club_members dual-writes are best-effort, so they are
-- the copy that can have silently missed an update, not the other way round).
on conflict (club_id, user_id) do update
  set role = excluded.role,
      book = excluded.book;

create or replace function public.join_default_club()
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.club_members (club_id, user_id, role)
  select '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8', auth.uid(), 'member'
  where auth.uid() is not null
  on conflict (club_id, user_id) do nothing;
$$;

revoke all on function public.join_default_club() from public, anon;
grant execute on function public.join_default_club() to authenticated;

-- The client subscribes to club_members now (books, joins and role changes all
-- arrive through it rather than through shelf_users), so it has to be in the
-- realtime publication -- it never was, since nothing read it before.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'club_members'
  ) then
    alter publication supabase_realtime add table public.club_members;
  end if;
end $$;

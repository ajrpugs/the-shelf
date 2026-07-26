-- Phase 1 of docs/multi-tenant-plan.md, slice 3: turn club scoping on for
-- real. Slices 1-2 (20260724160000, 20260724170000) added `clubs`, `club_id`
-- columns, and `club_members` -- but every RLS policy stayed `using (true)`
-- and club_members was a one-time snapshot nothing kept in sync. This
-- migration:
--
--   1. Adds `clubs.visibility`, defaulted 'public' so the existing seeded
--      club stays anon-readable (no behavior change for it).
--   2. Adds is_member(), the RLS helper sketched in
--      docs/multi-tenant-plan.md:143-149. is_librarian() is deliberately NOT
--      added yet -- nothing in this migration's policies needs it (no new
--      write policies; writes stay edge-function/service-role only). It
--      belongs to Phase 2, where admin-update actually starts consuming it.
--   3. Re-backfills club_members fresh, as an upsert this time, so it's
--      current as of the moment RLS starts depending on it (the original
--      backfill is now two days stale). From this point on, club_members is
--      kept live by dual-writes in set-book, discord-interactions, and
--      admin-update -- see those files.
--   4. Swaps the `using (true)` select policy on reads/shelf_state/
--      shelf_reviews/shelf_comments/shelf_comment_reactions/club_members for
--      one that checks is_member(club_id) OR the club is public. `clubs`
--      itself and shelf_users/shelf_librarians are untouched -- that split
--      still only matters once a second club exists.
--
-- Purely additive/re-runnable except for the policy swaps, which use
-- drop-if-exists + create (same pattern as every prior migration here).

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

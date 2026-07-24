-- Phase 1 of docs/multi-tenant-plan.md, slice 2: club_members, backing table
-- for the is_member()/is_librarian() RLS policy functions a later slice will
-- add. Additive only -- no RLS policy elsewhere reads this table yet, and
-- nothing writes to it yet (shelf_users/shelf_librarians stay the live
-- source of truth for now).
--
-- user_id references auth.users(id) directly, same pattern already used by
-- shelf_users.id, shelf_librarians.user_id, reads.winner_id,
-- shelf_reviews.user_id -- no separate `profiles` table yet, deferred until
-- it's actually load-bearing.
--
-- IMPORTANT: this backfill is a one-time snapshot, not a live mirror. Nothing
-- keeps it in sync with shelf_users/shelf_librarians going forward. Whichever
-- later slice starts writing RLS policies against this table MUST re-run a
-- fresh backfill (or add real dual-writes) immediately beforehand, or it will
-- be gating access on stale membership data.
--
-- Purely additive; safe to re-run.

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

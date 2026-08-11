-- Phase 11 (docs/configurability-plan.md §4): notification control.
--
-- §4.3's in-app activity baseline needs one thing: a per-member "since you
-- last looked" marker. club_members.last_seen_at, written by the reader
-- themself on load.
--
-- This is the one place in the plan where a direct-from-client RLS write
-- (§4.4's own precedent: shelf_comment_reactions) isn't safe as a plain
-- row-scoped policy: club_members also holds `book` and `role`, and a
-- same-row UPDATE policy would let a member rewrite either directly under
-- RLS -- role especially, since librarian promotion is supposed to go
-- through admin-update's "another librarian must grant it" gate, not
-- through the member editing their own row. Postgres's column-level
-- privileges are the precise tool: the row policy says "your own row", the
-- column grant says "only this column", and together they allow exactly
-- last_seen_at and nothing else.
--
-- The blanket `grant all on all tables` in 20260809150000_grant_table_
-- privileges.sql already gave `authenticated` a table-wide UPDATE grant on
-- club_members; it was inert until now because no UPDATE policy existed at
-- all. Revoking it and granting back only last_seen_at is what keeps this
-- change a net narrowing, not a new hole -- service_role (every edge
-- function) is a separate grantee and is untouched by either statement.

alter table public.club_members
  add column if not exists last_seen_at timestamptz;

drop policy if exists "club_members update own last_seen" on public.club_members;
create policy "club_members update own last_seen"
  on public.club_members for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

revoke update on public.club_members from authenticated;
grant update (last_seen_at) on public.club_members to authenticated;

-- §4.4's per-user notification preferences. Minimum useful content: don't
-- @-mention me in Discord on a draw. Per-club, not per-user-global -- a
-- reader can reasonably want pings from one club and not another. Genuinely
-- own-row-only for both read and write (unlike shelf_comment_reactions,
-- which is publicly readable) -- a preference is nobody else's business.

create table if not exists public.notification_prefs (
  club_id        uuid not null references public.clubs(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  mention_winner boolean not null default true,
  updated_at     timestamptz not null default now(),
  primary key (club_id, user_id)
);

alter table public.notification_prefs enable row level security;

drop policy if exists "notification_prefs select own" on public.notification_prefs;
create policy "notification_prefs select own"
  on public.notification_prefs for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "notification_prefs insert own" on public.notification_prefs;
create policy "notification_prefs insert own"
  on public.notification_prefs for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "notification_prefs update own" on public.notification_prefs;
create policy "notification_prefs update own"
  on public.notification_prefs for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "notification_prefs delete own" on public.notification_prefs;
create policy "notification_prefs delete own"
  on public.notification_prefs for delete
  to authenticated
  using (auth.uid() = user_id);

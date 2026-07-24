-- Librarian is a per-user role, replacing the shared ADMIN_PASSWORD. Presence of
-- a row = librarian. Roles deliberately do NOT live on shelf_users: that table's
-- "update self" policy would let a member self-promote by patching their own row.
-- This table has NO write policy, so grants/revokes are service-role only.
-- Signed-in users may read only their own row (enough to gate the UI).

create table if not exists public.shelf_librarians (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz default now()
);

alter table public.shelf_librarians enable row level security;

drop policy if exists "shelf_librarians read own" on public.shelf_librarians;
create policy "shelf_librarians read own"
  on public.shelf_librarians for select
  to authenticated
  using (auth.uid() = user_id);

-- Seed the first librarian (adampugs). Idempotent.
insert into public.shelf_librarians (user_id)
values ('bc3263ee-4dc6-4025-9de7-440340a0dc77')
on conflict (user_id) do nothing;

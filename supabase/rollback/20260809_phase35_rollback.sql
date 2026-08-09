-- Rollback for the three Phase 3.5 migrations (20260809120000/130000/140000).
--
-- NOT a migration -- deliberately outside supabase/migrations/ so `supabase db
-- push` never picks it up. Run it by hand only.
--
-- Read this first:
--
-- * Nothing here recovers data, because none of the three migrations destroy
--   any. They add constraints, an id default, an RPC, and indexes. The only
--   statement that rewrites existing rows is migration 2's club_members
--   backfill, and it was verified a no-op against production before it ran
--   (shelf_users and club_members were already fully in sync: 12/12 rows,
--   0 book changes, 0 role changes). If you need actual data back, use a
--   logical backup (scripts/backup.sh) -- not this file.
--
-- * Roll back the CODE together with section 3. `set-review` and
--   `admin-update` pass `onConflict: "club_id,book_ts,user_id"`, which requires
--   the new shelf_reviews primary key; restoring the old PK without also
--   redeploying the old functions breaks review submission and review import.
--   Sections 1 and 2 are safe to run with the new code still deployed while
--   only one club exists (the client's `.eq("club_id", ...)` queries don't need
--   the unique constraint to find a single row).
--
-- * Section 3 only succeeds while there is exactly one club. Restoring a global
--   unique on reads.ts fails if two clubs ever recorded the same ts, and
--   restoring the two-column shelf_reviews PK fails if two clubs ever held a
--   review for the same (book_ts, user_id). Both are expected -- that coupling
--   is the thing Phase 3.5 removed.

begin;

-- 3. Per-club read keys -> global keys ------------------------------------
alter table public.shelf_reviews drop constraint if exists shelf_reviews_pkey;
alter table public.shelf_reviews add primary key (book_ts, user_id);

drop index if exists public.shelf_comments_club_book_idx;
drop index if exists public.reads_club_ts_desc_idx;
drop index if exists public.reads_club_ts_key;
alter table public.reads add constraint reads_ts_key unique (ts);

-- 2. club_members as source of truth --------------------------------------
-- The self-join RPC. Dropping it means a newly signed-in reader gets no
-- membership row, so on the OLD code they still appear (it read shelf_users);
-- on the NEW code they would be invisible. Drop only alongside a code rollback.
drop function if exists public.join_default_club();

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'club_members'
  ) then
    alter publication supabase_realtime drop table public.club_members;
  end if;
end $$;

-- 1. shelf_state per club -> id=1 singleton -------------------------------
alter table public.shelf_state alter column id drop default;
drop sequence if exists public.shelf_state_id_seq;
alter table public.shelf_state drop constraint if exists shelf_state_club_id_key;

commit;

-- Phase 3.5 of docs/multi-tenant-plan.md: the keys that identify a read become
-- per-club instead of global.
--
-- `reads.ts` is globally unique today, and shelf_reviews is primary-keyed on
-- (book_ts, user_id) alone. Both are cross-tenant couplings:
--
--   * A global unique on `ts` means two clubs drawing in the same millisecond
--     is a hard insert failure for whichever lands second -- one club's wheel
--     able to reject another club's, which is exactly the kind of coupling
--     Phase 1 set out to remove.
--   * shelf_reviews keyed on (book_ts, user_id) means a member of two clubs
--     could only hold one review across a colliding pair of reads.
--
-- This is the "book_ts is not unique across clubs" hazard called out in §2 of
-- the plan. The plan's original fix was to replace the text key with a real
-- read_id UUID foreign key; that is off the table now that `reads.ts` is
-- load-bearing as a byte-for-byte join key (see CLAUDE.md -- casting or
-- replacing it silently breaks every review/comment join). Scoping the
-- constraints by club_id gets the same guarantee without touching the column.
--
-- DEPLOYMENT ORDER: the shelf_reviews primary-key swap changes which
-- constraint PostgREST's upsert has to name. set-review and admin-update pass
-- `onConflict: "club_id,book_ts,user_id"` as of the same change; the currently
-- deployed copies pass "book_ts,user_id" and will error until they are
-- redeployed. Deploy both functions immediately after this migration -- review
-- submission and review import are broken in between. Every other query in
-- this batch is filter-only and unaffected.

-- reads: unique per (club, ts) rather than globally per ts.
alter table public.reads drop constraint if exists reads_ts_key;
create unique index if not exists reads_club_ts_key on public.reads (club_id, ts);
-- Matches the app's only access pattern: one club's reads, newest first.
create index if not exists reads_club_ts_desc_idx on public.reads (club_id, ts desc);

-- shelf_reviews: one review per (club, read, reader).
alter table public.shelf_reviews drop constraint if exists shelf_reviews_pkey;
alter table public.shelf_reviews add primary key (club_id, book_ts, user_id);

-- shelf_comments has no uniqueness to relax -- it just gains the scoped index
-- to match how the thread is now queried.
create index if not exists shelf_comments_club_book_idx
  on public.shelf_comments (club_id, book_ts, created_at);

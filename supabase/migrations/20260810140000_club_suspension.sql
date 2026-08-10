-- Phase 7: a minimal moderation lever -- suspending a club without deleting it.
--
-- Open signup (docs/multi-tenant-plan.md §2) means holding clubs for people the
-- operator doesn't know, and until now the only moderation path was deleting a
-- club or an account outright (§4, "known gaps"). Deleting is permanent and
-- destroys a club's own members' history along with whatever prompted the
-- review. Suspending is reversible: the club and its data stay intact, only
-- every write path stops working until an operator clears the flag.
--
-- There is deliberately no UI for this -- it's an operator action, same
-- pattern as bootstrapping the first librarian (see CLAUDE.md, "Auth").
--   Suspend:   update public.clubs set suspended_at = now() where slug = '<slug>';
--   Reinstate: update public.clubs set suspended_at = null   where slug = '<slug>';
--
-- Enforcement lives in the edge functions that perform club-scoped writes
-- (admin-update, set-book, set-review, post-comment, and club-admin's
-- create_invite/join_with_invite), not in RLS -- reading a suspended club's
-- own history isn't the problem, a club staying ACTIVE while under review is.
-- Every one of those functions already re-authorizes against its own club_id
-- (see CLAUDE.md, "Multi-club"), so this is one more check alongside the
-- membership/librarian checks already there, not a new enforcement mechanism.
-- Deliberately narrow: leaving and deleting a suspended club, and a librarian's
-- settings changes, stay allowed -- exit and cleanup shouldn't be blocked by
-- the same hold that stops the club from growing or generating new activity.

alter table public.clubs
  add column if not exists suspended_at timestamptz;

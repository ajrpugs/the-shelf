-- Rename the seeded club's display name from "The Shelf" (the app's own
-- name) to "The Guild" -- matches the existing in-app flavor text ("The
-- Guild · Round N", "Guild score") so the club and the app aren't both
-- called the same thing. The slug ('the-shelf') and id are unchanged --
-- both are already load-bearing (DEFAULT_CLUB_SLUG, hash routing), and
-- nothing about renaming the display label requires touching either.
--
-- clubs.name isn't read anywhere in index.html yet (no query against the
-- clubs table exists there -- see docs/multi-tenant-plan.md Phase 3), so
-- this has no visible effect today; it's here for when it does.

update public.clubs
set name = 'The Guild'
where id = '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8';

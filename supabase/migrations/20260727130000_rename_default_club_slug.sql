-- Follow-up to 20260727120000_rename_default_club.sql: the slug was left as
-- 'the-shelf' when the display name changed to "The Guild", but that leaves
-- the club's URL identifier not matching its own name. This landed the same
-- day as Phase 3's hash router (#/c/<slug>/<tab>), before any real link had
-- been shared/bookmarked, so it's still free to change -- DEFAULT_CLUB_SLUG
-- in index.html is updated alongside this. parseRoute() never validates the
-- slug against anything (it's captured but unused until Phase 4), so an
-- already-bookmarked #/c/the-shelf/<tab> link still parses fine -- only the
-- slug segment is stale, the tab still resolves correctly.

update public.clubs
set slug = 'the-guild'
where id = '8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8';

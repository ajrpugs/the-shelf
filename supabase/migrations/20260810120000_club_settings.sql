-- Phase 6a: per-club settings. Nothing about a club stays hardcoded.
--
-- Phase 4 let anyone create a club, but every club inherited the seeded club's
-- identity and schedule. Most consequentially the timezone: meeting times are
-- pinned to a `CLUB_TZ` constant of 'America/Toronto' in index.html, so a club
-- founded in London scheduled its 50%/100% discussions at the wrong hour. That's
-- a defect in what Phase 4 already shipped, not a missing feature.
--
-- Two columns, both additive with defaults matching today's behaviour, so every
-- existing row and the running app are unaffected:
--
--   timezone -- an IANA zone name. Validated in club-admin rather than by a CHECK
--     constraint: the authoritative list is pg_timezone_names, and a check
--     constraint can't run a subquery. Deno validates by asking Intl to construct
--     a formatter with it, which is exactly what the client then does with it.
--   tagline  -- optional one-liner under the club's name.
--
-- `visibility` already exists (Phase 1 slice 3) and becomes editable here rather
-- than being fixed at creation.

alter table public.clubs
  add column if not exists timezone text not null default 'America/Toronto';

alter table public.clubs
  add column if not exists tagline text;

-- Length guards only. Content rules (a valid IANA zone, a trimmed name) live in
-- club-admin, which can explain a rejection; this is the backstop that keeps
-- something absurd out even via the service role.
alter table public.clubs drop constraint if exists clubs_timezone_len_chk;
alter table public.clubs
  add constraint clubs_timezone_len_chk
  check (length(timezone) between 1 and 64);

alter table public.clubs drop constraint if exists clubs_tagline_len_chk;
alter table public.clubs
  add constraint clubs_tagline_len_chk
  check (tagline is null or length(tagline) <= 160);

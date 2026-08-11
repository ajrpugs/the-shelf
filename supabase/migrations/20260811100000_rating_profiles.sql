-- Phase 10 (docs/configurability-plan.md §3): rating profiles.
--
-- Keeps the five typed shelf_reviews columns exactly as they are physically --
-- zero data migration, every existing review still valid -- but a club's
-- config.rating (see supabase/functions/_shared/club-config.mjs) now decides
-- which of the five are "active" for that club and what each is called. A
-- club running fewer than five active categories writes null into the rest,
-- which the current DNF constraint doesn't allow: it demands all five null
-- (a DNF row) or all five non-null (a scored row).
--
-- New rule: a DNF row still carries no scores at all, but a scored row only
-- needs at least one category filled in -- which one(s) is enforced by
-- set-review reading the club's active category list server-side, not by
-- this constraint (a CHECK can't see clubs.config).

alter table public.shelf_reviews drop constraint if exists shelf_reviews_dnf_scores_chk;
alter table public.shelf_reviews
  add constraint shelf_reviews_dnf_scores_chk
  check (
    (dnf and plot is null and characters is null and pacing is null and language is null and themes is null)
    or
    (not dnf and (plot is not null or characters is not null or pacing is not null or language is not null or themes is not null))
  );

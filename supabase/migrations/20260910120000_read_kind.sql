-- Non-fiction reads (docs/nonfiction-rubric-plan.md).
--
-- A club's rubric is per-club (clubs.config.rating), but a club that reads
-- both fiction and non-fiction needs to choose per *read*. reads.kind is that
-- choice: it decides which rubric members score the read under and which
-- leaderboard its locked score lands on.
--
-- NULL means fiction -- every read that predates this column keeps exactly
-- the rubric and leaderboard it already had, so there's nothing to backfill.
-- The non-fiction rubric reuses the five physical shelf_reviews columns as
-- slots (plot=Engagement, characters=Clarity, pacing=Structure & Pacing,
-- language=Voice & Prose, themes=Insight & Credibility), so shelf_reviews
-- doesn't change shape either.
--
-- Written only by admin-update's admin_set_read_kind (librarian-gated, and
-- refused once the read has any review), never from the browser directly.

alter table public.reads
  add column if not exists kind text;

alter table public.reads drop constraint if exists reads_kind_chk;
alter table public.reads
  add constraint reads_kind_chk
  check (kind is null or kind in ('fiction', 'nonfiction'));

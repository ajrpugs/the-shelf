-- DNF (did not finish) indicator on member reviews. A reader can flag that
-- they didn't finish a book instead of scoring it through the usual rubric.
-- A DNF row carries no category scores, so the five score columns become
-- nullable; the check constraint keeps the two shapes mutually exclusive --
-- a scored review always has all five, a DNF review always has none -- so
-- aggregateRubric()/reviewTotal() on the client can keep treating "has a
-- plot score" as "counts toward the /100 average" without special-casing.

alter table public.shelf_reviews
  alter column plot drop not null,
  alter column characters drop not null,
  alter column pacing drop not null,
  alter column language drop not null,
  alter column themes drop not null;

alter table public.shelf_reviews
  add column if not exists dnf boolean not null default false;

alter table public.shelf_reviews
  drop constraint if exists shelf_reviews_dnf_scores_chk;
alter table public.shelf_reviews
  add constraint shelf_reviews_dnf_scores_chk
  check (
    (dnf and plot is null and characters is null and pacing is null and language is null and themes is null)
    or
    (not dnf and plot is not null and characters is not null and pacing is not null and language is not null and themes is not null)
  );

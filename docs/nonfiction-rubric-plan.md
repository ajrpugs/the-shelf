# Non-fiction reads: a second rubric and a second leaderboard

**Status: built, not yet deployed** (2026-09-10). Superheavy (round 17) is the
first non-fiction pick; this needs to be live before its reviews open.

## The problem

A club's rubric is per-club (`clubs.config.rating`, Phase 10). The Guild reads
both fiction and non-fiction, so the choice has to be per **read**. Renaming the
five categories in Librarian → Settings gets the labels but not the scoring
guidance (which is fixed prose in `index.html`), and it would relabel every
other in-progress read for as long as it's switched.

## The rubric

Five categories × 20 = /100, same four bands as the fiction rubric. It replaced
the club's first draft, which double-counted the writing (Delivery *and* Use of
Language), asked three questions in one row (original / researched /
educational), and stepped its bands by quantity words ("mostly", "some", "few")
rather than recognisable experiences.

| Slot (physical column) | Fiction | Non-fiction |
|---|---|---|
| `plot` | Plot | Engagement |
| `characters` | Characters | Clarity |
| `pacing` | Organization / Pacing | Structure & Pacing |
| `language` | Use of Language | Voice & Prose |
| `themes` | Themes / Ideas | Insight & Credibility |

The band prose lives in `index.html`'s `RUBRIC_NONFICTION`; the labels live in
`_shared/club-config.mjs`'s `NONFICTION_RATING_CATEGORIES` and the client copy.

**Why this needed no review migration:** the non-fiction rubric reuses the five
physical `shelf_reviews` columns as slots, exactly as Phase 10 intended. A
review total depends only on which slots are active and the per-category max,
never on labels, so totals, DNF handling, and the `shelf_reviews` constraints
are untouched. At the Guild's config (five slots, scale 20) a non-fiction /100
is on the same footing as a fiction one.

## Decisions

- **`reads.kind`** (`text`, `NULL` = fiction, check `in ('fiction','nonfiction')`).
  NULL-as-fiction means all 16 older reads are unchanged with nothing to
  backfill. `admin_set_read_kind` writes `NULL` rather than `'fiction'`, so
  there's one representation of the default.
- **The librarian tags it, by hand**, on the Reading banner, before reviews
  open. Considered and declined: the picker tagging it at `set-book` time
  (needs plumbing through `club_members`, the draw, and `/mybook`, and still
  needs a librarian override), and inferring it from Open Library subjects
  (no reliable fiction/non-fiction signal — kept as a possible *pre-fill*
  later, never a decision).
- **Locked once scored.** `admin_set_read_kind` refuses once any review exists,
  once a score is locked in, or while ratings are open. The last one is what
  closes the race: `set-review` only accepts a review while ratings are open,
  so nothing can land between the review count and the update. The switch
  button disappears once a review exists, and "Open ratings" names the rubric
  ("Open ratings (fiction rubric)") so it's hard to open under the wrong one.
- **Non-fiction always runs all five slots**, at the club's own scale and score
  label, even for a club that has switched some fiction categories off.
- **Separate leaderboards**: `#/c/<slug>/leaderboard/nonfiction`, using the
  optional third route segment the dashboard already uses. A bare
  `…/leaderboard` still lands on fiction. The switcher only appears once some
  read is non-fiction, so other clubs see no change.
- **"Top rated" / "Lowest rated" badges compare within a kind.** Superheavy
  shouldn't be crowned (or buried) against novels scored on a different rubric.
- **Left combined, on purpose**: Year in books, a reader's average, the
  Reviews tab's reviewed-reads list, tag pages, and the "most divisive" /
  "harshest / most generous reviewer" superlatives. These are history or
  reviewer-level, not rankings; rows carry a "Non-fiction" tag instead.

## What changed

- **Migration** `20260910120000_read_kind.sql`; mirrored as `schema.sql` §33.
  No new table, so `supabase/backup-sql/` needs no change (`reads` is
  serialized whole via `to_jsonb`).
- **`_shared/club-config.mjs`**: `READ_KINDS`, `NONFICTION_RATING_CATEGORIES`,
  `normalizeReadKind`, `ratingProfileForKind`.
- **`admin-update`**: new `admin_set_read_kind`; `admin_set_rating` validates,
  clamps and snapshots under the read's own rubric; the history rebuild
  selects `kind`; the Discord score post now takes its labels and max from the
  rating's snapshotted profile. That last one also fixes a pre-existing bug:
  it had hardcoded the default fiction labels and `/20`, mislabelling any club
  that had renamed or rescaled its categories.
- **`set-review`**: active slots and scale come from the current read's rubric.
- **`club-admin`**: `export_club` includes `kind`.
- **`index.html`**: the client copy of the above; `RUBRIC_NONFICTION`;
  `rubricForRead()` / `rubricForTs()` feeding the review wizard, live
  breakdown, reviewer score lines, review totals and lock-in; the banner
  controls; the leaderboard split and `LEADERBOARD_SECTIONS` routing; per-kind
  badges; `.kind-tag`.
- **Tests**: `_shared/read-kind.test.mjs`, `tests/client-read-kind.test.mjs`,
  and `tests/client-config-parity.test.mjs` — the first test that the client's
  and server's `normalizeConfig` copies actually agree, closing the gap behind
  the `notify` drift incident.

## Deploy order

1. `scripts/backup.sh`
2. `scripts/rehearse-migrations.sh supabase/migrations/20260910120000_read_kind.sql`
3. `supabase db push`
4. `supabase functions deploy admin-update --no-verify-jwt`, then `set-review`
   and `club-admin` (with `TMPDIR=$HOME/tmp`).
5. `git push` for the frontend — **after** step 3: the client's `reads` select
   names `kind`, and would fail against a database without the column.
6. On the Reading banner: "Switch to non-fiction rubric" on Superheavy, then
   open ratings when the club is ready.

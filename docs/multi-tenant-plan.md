# Multi-tenant plan — "The Shelf" as a product

**Status:** Phases 0–3 (harden, tenancy foundation, per-club librarian role, hash routing) plus Phase 3.5 (the scoping cleanup Phase 1 deferred) are implemented and live in production. Phases 4–7 (signup/invites, more auth providers, per-club settings, frontend restructure) are still proposal — see §8 for what's actually landed vs. what isn't.
**Goal (decided 2026-07-26, revised 2026-07-27, see §10):** anyone can sign up at `sh3lf.net`, create their own private book club (no invite needed to create one), invite members, and run the wheel/meetings/reviews flow independently of every other club — free, open signup, Discord optional per club rather than required.

This builds on the feasibility findings: the blocker isn't difficulty, it's that the data model changes under everything at once, and (as of writing) there were no tests to catch what breaks. That second half is now addressed — see §5.

---

## 1. Target architecture

| Concern | Today | Target |
|---|---|---|
| Hosting | GitHub Pages | GitHub Pages (unchanged — see below) |
| URL | `sh3lf.net/` | `sh3lf.net/#/c/<club-slug>` |
| Auth | Discord only | Email magic link + Google + Discord |
| Club state | `shelf_state` row `id=1` | `club_state` row per club |
| Past reads | jsonb array inside that row | `reads` table |
| Librarian | one shared `ADMIN_PASSWORD` | `club_members.role = 'librarian'` |
| Reads/writes | unscoped `select("*")` | scoped by `club_id` everywhere |

### Routing: hash-based, staying on GitHub Pages — decided 2026-07-26

**Decision:** stay on GitHub Pages; route with `#/c/<slug>` (e.g. `sh3lf.net/#/c/bibliomancers`) instead of a real path (`sh3lf.net/c/bibliomancers`).

GitHub Pages serves static files only — it has no way to say "serve `index.html` for any path," so a direct link or refresh on a real `/c/bibliomancers` path would 404. Moving to Cloudflare Pages (or Netlify/Vercel) would fix that with a `_redirects` rule (`/* /index.html 200`), but for a free, invite-only, friends-scale product that migration isn't worth it just for cosmetically cleaner URLs — GitHub Pages never even sees the part of the URL after `#`, so hash routing needs zero hosting changes at all.

Tradeoff accepted: hash URLs work fine for people clicking links but don't give a server-side redirect or a link-preview bot a real path to read, and look slightly less clean. Neither matters for this product's actual audience.

This still forces a real router (just hash-based instead of path-based), which fixes the tab-linking problem hit three times already (`#tab=calendar` has no URL today) — same win as path routing would have given, without the hosting move.

---

## 2. Schema

Sketch, not final DDL. The big structural change is **`history` becoming real rows**.

```sql
-- Identity, independent of any club
profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url  text,
  discord_id  text unique          -- optional; only for Discord-linked users
)

clubs (
  id          uuid primary key default gen_random_uuid(),
  slug        citext unique not null,     -- /c/<slug>
  name        text not null,
  tagline     text,
  timezone    text not null default 'America/Toronto',
  cadence     jsonb,                      -- { weekday: 3, hour: 20, weeks: 2 }
  visibility  text not null default 'private'
              check (visibility in ('public','private')),
  created_by  uuid references profiles(id),
  created_at  timestamptz default now()
)

-- Secrets live in their own table so they are simply unreachable from the
-- anon/authenticated API. RLS is row-level; hiding a *column* via PostgREST is
-- fiddly and easy to get wrong. No policies here at all = service-role only.
club_secrets (
  club_id             uuid primary key references clubs(id) on delete cascade,
  discord_webhook_url text,
  calendar_token      text unique not null   -- unguessable; used in the ICS URL
)

-- Membership carries the role AND the book (a person in two clubs has two books)
club_members (
  club_id   uuid references clubs(id) on delete cascade,
  user_id   uuid references profiles(id) on delete cascade,
  role      text not null default 'member' check (role in ('librarian','member')),
  book      text,
  joined_at timestamptz default now(),
  primary key (club_id, user_id)
)

-- Only the volatile game state stays as a blob
club_state (
  club_id     uuid primary key references clubs(id) on delete cascade,
  eliminated  uuid[] not null default '{}',
  round_number int not null default 1,
  version     int not null default 0,      -- optimistic lock, see §5
  updated_at  timestamptz default now()
)

-- Was shelf_state.data.history[]
reads (
  id           uuid primary key default gen_random_uuid(),
  club_id      uuid not null references clubs(id) on delete cascade,
  round        int not null,
  winner_id    uuid references profiles(id),
  winner_name  text not null,
  book         text not null,
  picked_at    timestamptz not null default now(),
  rating       jsonb,
  ratings_open boolean not null default false,
  meetings     jsonb        -- { half: {at, upTo}, full: {at} }
)

reviews (
  read_id  uuid references reads(id) on delete cascade,
  user_id  uuid references profiles(id) on delete cascade,
  plot int2, characters int2, pacing int2, language int2, themes int2,
  note     text,
  primary key (read_id, user_id)
)

comments (
  id         uuid primary key default gen_random_uuid(),
  read_id    uuid references reads(id) on delete cascade,
  user_id    uuid references profiles(id) on delete cascade,
  body       text not null,
  created_at timestamptz default now()
)

invites (
  code       text primary key,          -- short, unguessable
  club_id    uuid references clubs(id) on delete cascade,
  created_by uuid references profiles(id),
  expires_at timestamptz,
  max_uses   int,
  uses       int not null default 0
)
```

### Why `reads` matters

It fixes three current problems at once:

1. `book_ts` — a **timestamp string** used as a join key for reviews and comments — becomes a real UUID foreign key. Today it's unenforced and **not unique across clubs**.
2. `history` stops being an unbounded array rewritten in full on every admin action.
3. Reviews/comments get cascade deletes for free.

---

## 3. RLS model

Current policies are `using (true)` for select on all four tables — anon reads everything. Correct for one public club, wrong the moment clubs expect privacy.

```sql
create function public.is_member(club uuid) returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from club_members
    where club_id = club and user_id = auth.uid()
  );
$$;

create function public.is_librarian(club uuid) returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from club_members
    where club_id = club and user_id = auth.uid() and role = 'librarian'
  );
$$;
```

Read policy shape, applied to `clubs`, `club_state`, `reads`, `reviews`, `comments`, `club_members`:

```sql
using (
  is_member(club_id)
  or exists (select 1 from clubs c where c.id = club_id and c.visibility = 'public')
)
```

Writes continue to go through edge functions with the service role. `club_secrets` gets **no policies at all**.

**Test the policies.** RLS bugs are silent and they leak across tenants. Every policy needs a test that asserts a member of club A gets zero rows from club B.

---

## 4. Auth

Add **email magic link** (Supabase built-in) and **Google**; keep Discord. Magic link matters most — requiring Discord to join a book club is a hard sell for a general audience.

Work involved:
- `displayNameFromMeta` normalizer per provider (each nests name/avatar differently).
- Identity linking so one human signing in with Google *and* Discord isn't two accounts.
- Discord features degrade gracefully: `/mybook` and the winner @-ping key off `discord_id`. Users without one still work — the webhook already falls back to a plain announcement.
- Discord becomes **optional per club**: a club supplies its own webhook or gets no Discord integration.

---

## 5. Correctness work that must land first

These are pre-existing weaknesses that multi-tenancy would amplify:

- **Lost updates.** `shelf_state.data` is read-modify-write with no locking. One librarian per club makes collisions nearly impossible today; with more librarians, two concurrent admin actions silently clobber each other. Add the `version` column and a `where version = $expected` guard.
- **`normalizeState` is duplicated** in `index.html` and `admin-update` and rebuilds history items field-by-field — any new field must be added to both or it's silently wiped. Moving history to `reads` largely retires this.
- **No tests.** ✅ addressed. At the time of writing the only harness was the ad-hoc headless DOM stub from the calendar work. There are now four layers, all runnable on demand (see CLAUDE.md → Common commands):
  - `node --test supabase/functions/_shared/*.test.mjs` — 16 offline unit tests over the pure draw/undo/rating/meeting logic (Phase 0).
  - `deno check supabase/functions/*/index.ts` — typechecks all six edge functions. **This is the only thing that typechecks them**; the Supabase deploy pipeline transpiles without checking, which is how 15 pre-existing type errors sat undetected until the tooling was installed 2026-08-09.
  - `node --test supabase/tests/rls-isolation.test.mjs` — cross-tenant RLS isolation against the linked project (Phase 1).
  - `scripts/rehearse-migrations.sh` — applies pending migrations to production inside `BEGIN … ROLLBACK`, proving them against real schema and real data without committing.

  Still uncovered: `render()` and the ~3,500-line client module (nothing beyond a parse check), and the edge functions' request handling end-to-end. Phase 7 is where a real frontend harness becomes worth it.

---

## 6. Scaling — what actually costs money

Supabase will not be the bottleneck. A club's state is a few KB; a thousand clubs is single-digit MB against a 500 MB free-tier database.

**Two things must be right from day one**, or cost scales with *total users across all clubs* rather than per club:

1. **Scope `loadAll`.** ✅ done — reviews/comments/reads/reactions in Phase 1 slice 3; the last unscoped sweep (`shelf_users.select("*")`) in Phase 3.5, which replaced it with this club's `club_members` plus an `.in("id", memberIds)` identity fetch.
2. **Filter realtime.** ✅ done — every `postgres_changes` subscription carries `filter: 'club_id=eq.<id>'` except `shelf_users`, which has no `club_id` to filter on and is now only watched for display-name/avatar changes (books, joins and role changes arrive via `club_members`).

Upgrade to **Supabase Pro** for reliability, not capacity:
- Free projects **pause after ~a week of inactivity** — unacceptable once others depend on it.
- **No daily backups on free** — one bad `reset` from losing every club's history.

**Confirmed 2026-08-09, and worse than "no daily backups" implies.** `supabase backups list` on the live project returns `pitr_enabled: false` with an **empty** backup array — there is no restore point of any kind, and never has been. A single `reset` (or a bad migration) loses 17 reads, 80 reviews and 5 comments permanently. This is the largest standing risk to the club's data and it is entirely independent of the tenancy work.

Partial stopgap in place, not a substitute: `scripts/backup.sh` takes a verified logical backup on demand (pg_dump schema/data/roles via Docker, plus a row-count-verified public-data snapshot that works without it) into `~/the-shelf-backups/`. It is **manual** — nothing runs it on a schedule, so the club is only ever as protected as the last time someone remembered. Pro's PITR is still the actual fix; a cron/launchd job around `backup.sh` is the cheap interim one.

### Running cost

| Item | Cost |
|---|---|
| Supabase Pro | ~$25/mo *(verify current pricing)* |
| Domain | ~$12/yr |
| GitHub Pages | $0 |

≈ **$26/mo**. Fine as a hobby; needs a funding answer if it grows.

---

## 7. Open-signup consequences

**Reopened in full by §10 (revised 2026-07-27):** briefly scoped down to invite-only friends for one day, reverted back to open signup — anyone can register and create their own club, with no invite required to create one. This is real product surface that has nothing to do with books:

- **Club creation limits** — rate-limit per user per day, or it's a spam vector.
- **Slug rules** — validation, reserved words (`admin`, `api`, `c`, `new`…), squatting. Needed regardless for `/c/<slug>` routing, but squatting specifically only matters once strangers (not just people you know) can claim any slug they want.
- **Lifecycle** — leave a club; transfer librarian; last librarian leaving must promote or archive, not orphan.
- **Deletion** — delete a club, delete an account, with cascades that actually work.
- **Moderation** — clubs still default to `private` (§10 item 2), so most content stays invite-only-visible even under open signup — but a stranger's account and a stranger's club are no longer the same trust level as a friend's. Needs at minimum a delete path and a way to reach you; a club explicitly marked public is now world-readable to anyone, including people you've never met.
- **Legal** — Terms + Privacy once you hold accounts/content for people you don't personally know. Account deletion must genuinely delete.
- **Support** — someone will lock themselves out of librarian mode.

None is hard. Together they're comparable in size to the tenancy work itself, and they're easy to under-budget. The tenancy work in §1–6 doesn't change either way.

---

## 8. Phases

Each phase should be shippable and leave the existing club working.

### Phase 0 — Harden *(no user-visible change)* — ✅ done
Test harness for render + edge function logic. `reads` table replacing the `history` array and `book_ts`. `version` column + optimistic locking. Migrate existing data in place.
**Exit:** current club runs entirely on `reads`; tests cover the wheel, ratings, meetings.

Landed before the tenancy work below started. `supabase/functions/_shared/shelf-logic.mjs` holds the pure draw/undo/rating/meeting logic, covered by `node --test`; `reads` is the live source of truth for history; `shelf_state.version` guards every admin write. This was the baseline Phase 1 built on.

### Phase 1 — Tenancy foundation — ✅ done
`clubs`, `club_members`, `profiles`, `club_secrets`. `club_id` on everything. New RLS + policy tests. Scope every query and the realtime subscriptions. Existing club migrates to club #1.
**Exit:** two clubs coexist in the DB with no data bleed, proven by tests.

Schema/RLS/dual-writes/query-scoping landed 2026-07-26. Isolation itself was first verified manually the same day (no local Postgres/Docker in this environment, so no automated policy-test suite existed yet): a throwaway private second club + one real user as its only member were inserted directly via `supabase db query --linked`, then read back under `SET ROLE`/simulated JWT claims as (a) anon, (b) that member, (c) a real member of club #1 who is *not* a member of the test club, confirming (c) got zero rows from the test club while their own club's rows were unaffected — then the test club/member/rows were deleted. `profiles` and `club_secrets` did not exist yet at that point.

All three gaps closed 2026-07-26: `profiles` (identity separate from any one club, one-time backfill from `shelf_users`, not yet consumed by anything — see `supabase/migrations/20260726200000_add_profiles_table.sql`) and `club_secrets` (per-club Discord webhook + calendar token, service-role only, no RLS policies at all — `supabase/migrations/20260726210000_add_club_secrets_table.sql`) are both additive, same as every other Phase 1 slice. The manual isolation check above is now automated and checked in as `supabase/tests/rls-isolation.test.mjs` (`node --test supabase/tests/rls-isolation.test.mjs`) — same technique (throwaway private club, `SET ROLE`/JWT-claims simulation, cleans up after itself), but now covering all six club-scoped tables (`reads`, `shelf_state`, `shelf_reviews`, `shelf_comments`, `shelf_comment_reactions`, `club_members`) instead of a one-off subset, and repeatable on demand rather than a single manual proof.

### Phase 2 — Role-based librarian — ✅ done
Retire `ADMIN_PASSWORD`. `admin-update` verifies JWT (pattern already exists in `set-book`) and checks `role = 'librarian'`.
**Exit:** no shared secret anywhere; librarian rights are per-club.

There was no literal `ADMIN_PASSWORD` by the time this landed — `shelf_librarians` (JWT-verified, role-based) already predated this plan. What this phase actually closed: `admin-update`'s authorization check read the *global* `shelf_librarians` table, so a librarian would have silently been a librarian in every club, not just their own. Landed 2026-07-26: the check now reads `club_members.role = 'librarian'` scoped to `DEFAULT_CLUB_ID` instead; `admin_grant_librarian`/`admin_revoke_librarian` dual-write both tables so `shelf_librarians` (still what the client's tab-gate reads) and `club_members.role` (what the server actually enforces) can't drift.

### Phase 3 — Routing — ✅ done
No hosting move (see §1, decided 2026-07-26: staying on GitHub Pages). Add a `#/c/<slug>` hash router. Tabs get real (hash) URLs.
**Exit:** deep links work on refresh; club resolves from the hash.

Landed 2026-07-27: `index.html`'s tab bar now routes through `#/c/<slug>/<tab>` (`parseRoute()`/`goToTab()`) instead of an in-memory-only `currentTab`, so every tab has a real, refresh-safe, back-button-capable URL — closing the "`#tab=calendar` has no URL" gap called out in §1. `<slug>` is captured by `parseRoute()` but always `DEFAULT_CLUB_SLUG` ("the-guild" — renamed the same day from "the-shelf" to match the club's display name, "The Guild") for now; there's still no `clubs`-by-slug lookup anywhere in the client, so "club resolves from the hash" is only the URL *shape*, not real resolution — that part is genuinely Phase 4's job, once a second club actually exists to resolve to. The five pre-existing detail routes (`#book=`, `#shelf=`, `#tag=`, `#reader=`, `#recap`) are untouched.

### Phase 3.5 — Scoping cleanup *(no user-visible change)* — ✅ done

Not in the original plan. Added 2026-08-09, after a readiness review for Phase 4 found that several things Phase 1 explicitly deferred as "only matters once a person can join a second club" are load-bearing the moment Phase 4 lets anyone *create* a second club — and four of them were cross-tenant data bugs rather than missing features. All of it is invisible to the existing club, so it shipped against the live single club the way Phase 0 did.

What landed:

1. **`shelf_state` stopped being a singleton.** It carried a `club_id` column from Phase 1 slice 1 but was still *addressed* as the fixed `id = 1` row, so club #2 would have shared club #1's `eliminated` list and `roundNumber`. `unique (club_id)` plus a sequence default on `id` makes club_id the real key; `admin-update` and `loadAll` both address it that way now.
2. **`club_members` became the source of truth for membership, role, and book.** `draw` pulled its eligible pool straight from `shelf_users`, which has no `club_id` at all — club #2's wheel would have spun up every reader of every club, and one person could only ever hold one book across all their clubs. The book now lives on the membership row; `shelf_users` is identity only (display name, avatar, `discord_id`), and its `book` column is a legacy mirror nothing reads. `join_default_club()` — a narrow security-definer RPC that can only add *the caller* to *the seeded club* — stands in for the insert policy `club_members` deliberately lacks, until Phase 4's invite flow replaces it.
3. **Every edge-function query is club-scoped.** Most consequentially `reset`, whose `reads` delete and book-clear were both table-wide (`.neq("id", <zero uuid>)`) — one librarian's reset would have destroyed every club's history. Same for the four `ts`-keyed actions (`admin_set_rating`, `admin_set_ratings_open`, `admin_set_meeting`, `admin_announce_meeting`), `undo_last_spin`, `admin_import_reviews`, `set-review`, and `post-comment`. `admin_remove_user` now deletes the *membership* rather than the global `shelf_users` identity row, which would have removed the person from every club they belong to.
4. **`calendar-feed` resolves one club.** It was a single unfiltered query over `reads`, so every subscriber would have received every club's schedule (§9's do-not-defer item). It now takes `?token=<club_secrets.calendar_token>` — finally consuming the column Phase 1 added for exactly this. A token-less request falls back to the seeded club rather than to "all clubs", so members already subscribed to the original URL keep working; Phase 6 drops the fallback once the app can surface a real token.
5. **The client's Admin gate reads `club_members.role`.** Phase 2 fixed the server, so a cross-club librarian already got a 403 — but the UI read the global `shelf_librarians` table and would still have handed them the Admin tab and controls in a club they don't run. `shelf_librarians` is now a mirror too, written by grant/revoke and read by nothing.

Also folded in, because they're the same bug class as (3): `reads.ts` is unique per `(club_id, ts)` rather than globally (a global unique means one club's draw can hard-fail another's), and `shelf_reviews` is primary-keyed `(club_id, book_ts, user_id)`. This is the "`book_ts` is not unique across clubs" hazard from §2 — closed by scoping the constraints, *not* by the read_id-UUID swap the section originally proposed, which is off the table now that `reads.ts` is load-bearing as a byte-for-byte join key.

**Exit:** two clubs can coexist and run independently — separate state, separate reader pools, separate books, separate resets, separate calendar feeds — with no query in the codebase able to reach across clubs.

#### Verification tooling landed alongside it

The repo had no way to run its own documented checks — no `node`, no `deno`, no Docker on the machine. Installing them (`brew install node deno colima docker`) immediately surfaced three defects that no amount of reading would have caught, which is the argument for doing it before Phase 4 rather than after:

- **15 pre-existing type errors** across `admin-update` (10) and `discord-interactions` (5), confirmed against HEAD. Root cause: `type X = ReturnType<typeof createClient>` resolves supabase-js's generic defaults to `never`/`unknown`, so every helper rejected the real client and `.upsert()` rejected every object literal against a `never` schema. Plus a `Uint8Array<ArrayBufferLike>` vs `BufferSource` mismatch in the Ed25519 verification. None ever broke production because **the Supabase deploy pipeline transpiles without typechecking** — meaning these functions had never been typechecked at all.
- **A syntax error in new test code** — a SQL comment containing backticks inside a JS template literal, which made `rls-isolation.test.mjs` unparseable.
- **`node --test <dir>` no longer works** (Node ≥23 treats a bare directory as a module). The command CLAUDE.md documented had silently stopped working.

Two things that are now possible and weren't:

- `scripts/rehearse-migrations.sh` — applies pending migrations to production inside `BEGIN … ROLLBACK`. Phase 3.5's three migrations were rehearsed this way before being pushed: all four objects created, the old global `reads_ts_key` dropped, the new 3-column review PK in place, and **row counts identical** (12 members / 10 books / 1 librarian / 17 reads / 80 reviews), then discarded.
- `scripts/backup.sh` — see §6. This is what turned up the fact that the project has no backups at all.

Also discovered: **`supabase db reset` does not work on this repo**, and a fresh project can't be bootstrapped from `migrations/` alone — the first migration alters `shelf_users` but nothing ever creates it, because the base schema comes from running `schema.sql` in the SQL editor. Any future "spin up a second environment" work (Phase 4 will want one) has to solve that first.

### Phase 4 — Signup & lifecycle
Create a club, invite codes, join, leave, transfer librarian, delete. Onboarding for an empty club. Since §7 is open in full again (open signup, revised 2026-07-27), this phase also owns club-creation rate limiting and slug validation/reserved words — not just the lifecycle actions.
**Exit:** a stranger can go from landing page to a running club without you.

Unblocked by Phase 3.5, which cleared the prerequisites: a new club now has somewhere to keep its game state, its own reader pool, and its own calendar feed. What this phase still owns on the tenancy side: resolving `parseRoute()`'s captured slug to a real club (the client still hardcodes `DEFAULT_CLUB_ID`/`DEFAULT_CLUB_SLUG`, as do all five edge functions), creating the `clubs` + `shelf_state` + `club_secrets` + founding-librarian rows together, and replacing `join_default_club()` with an invite-gated join.

### Phase 5 — Auth providers
Magic link + Google, identity normalization, account linking.
**Exit:** a club can run with zero Discord users.

### Phase 6 — Per-club settings
Name, tagline, timezone (retire the hardcoded `America/Toronto`), cadence, own Discord webhook, per-club ICS token.
**Exit:** nothing about the club is hardcoded.

### Phase 7 — Frontend restructure *(when justified)*
3,815 lines of string-built HTML in one file, full re-render per change. Revisit when the pain justifies it — not before.

---

## 9. Security items not to defer

- **ICS feed is public and unauthenticated.** ✅ addressed in Phase 3.5 — `calendar-feed` takes `?token=<calendar_token>`, and a token-less request serves only the seeded club (never all clubs). The remaining gap is that the app can't yet *show* a member their club's token, so nobody is using a real one; Phase 6 surfaces it and drops the fallback.
- **Discord webhook URLs are credentials** — anyone holding one can post to that channel. Hence `club_secrets`, service-role only.
- **RLS is the only thing between tenants.** Test it like it matters.

---

## 10. Decisions needed before Phase 0 — ✅ answered 2026-07-26

1. **Domain name?** `sh3lf.net` — already owned and already the `CNAME` for the current single-club GitHub Pages deployment. Phase 3 (decided 2026-07-26) stays on GitHub Pages with hash-based routing instead of moving hosts, so nothing about the domain/DNS changes at all.
2. **Are clubs public or private by default?** Private. The one seeded club (`the-guild`, `visibility = 'public'`) stays as-is — new clubs default to `private`.
3. **Is Discord still first-class,** or one integration among several? **Not first-class.** Some clubs won't use it at all, so Discord becomes fully optional per club (§4/§9: no webhook configured = no Discord integration, `/mybook` and the winner ping degrade gracefully when a member has no `discord_id`).
4. **Free forever, or eventually paid?** Free. No billing/plan model needed anywhere in the club schema.
5. **Is this a product you want to support?** Yes — **revised 2026-07-27: open signup.** Originally scoped down to invite-only friends (2026-07-26), reconsidered the next day back to the plan's original framing: anyone can create an account and spin up their own new club with no invite from anyone. Clubs themselves still default to `private` (item 2, unchanged) — open signup is about who can register and create a club, not about clubs being publicly discoverable; a club is still only reachable by whoever holds its slug/invite unless someone explicitly flips it to public. This reopens §7 in full: club-creation limits, slug/reserved-word validation, and heavier moderation/legal footing all matter again, since accounts and content can now come from unvetted strangers, not just people you personally invited.

---

## Bottom line

Roughly: Phase 0–2 is the bulk of the engineering and the part that must be right. Phases 3–6 are mostly mechanical. Phase 7 is optional until it isn't.

The two ways this goes wrong are (a) starting Phase 1 before Phase 0, so the data model moves with no tests underneath it, and (b) shipping unscoped `loadAll`/realtime, so infra cost scales with total users instead of per club. Everything else is recoverable.

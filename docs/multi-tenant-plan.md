# Multi-tenant plan — "The Shelf" as a product

**Status:** Phases 0–4 are implemented and live in production — harden, tenancy foundation, per-club librarian role, hash routing, the Phase 3.5 scoping cleanup, and the Phase 4 lifecycle (create a club, invites, join, leave, delete, onboarding). **Phase 5 is partly done and partly abandoned on purpose:** Google sign-in shipped 2026-08-09 (slice 5c), and **email accounts are deferred indefinitely** — see the decision at the top of §4. **Phase 6a (per-club settings) shipped 2026-08-10** — nothing about a club is hardcoded any more. 6b (account settings) is partly done: the page and account deletion exist; display name, email, password and connected accounts remain. Phase 7 is untouched. See §8 for what's landed vs. what isn't, including what Phase 4 deliberately left open.
**Goal (decided 2026-07-26, revised 2026-07-27, see §10):** anyone can sign up at `sh3lf.net`, create their own private book club (no invite needed to create one), invite members, and run the wheel/meetings/reviews flow independently of every other club — free, open signup, Discord optional per club rather than required.

This builds on the feasibility findings: the blocker isn't difficulty, it's that the data model changes under everything at once, and (as of writing) there were no tests to catch what breaks. That second half is now addressed — see §5.

---

## 1. Target architecture

| Concern | Today | Target |
|---|---|---|
| Hosting | GitHub Pages | GitHub Pages (unchanged — see below) |
| URL | `sh3lf.net/` | `sh3lf.net/#/c/<club-slug>` |
| Auth | Discord only ("Sign in with Discord" is the whole page) | Standard sign-in / create-account page: email accounts **plus** Discord and Google as first-class options |
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

**Decision 2026-08-09 — email accounts deferred indefinitely.** Google sign-in shipped instead, and it answers the argument that motivated email in the first place: "requiring Discord to join a book club is a hard sell for a general audience." Google is near-universal, so two OAuth buttons close the general-audience gap.

What email would still add is a third way in for people who avoid both Google and Discord, plus those who prefer passwords. What it costs is out of proportion to that: a transactional-email provider, SPF/DKIM records on `sh3lf.net`, and deliverability as a permanent operational concern. And it can't be half-adopted — **password reset is the hard requirement, not confirmation.** Without reset mail every forgotten password is a permanent lockout fixed by hand in the dashboard, which is worse than not offering passwords at all.

Nothing else in the product needs mail: invites are copy-paste links, and meeting reminders are already covered by the Discord webhook and the ICS feed. So this is deferred until someone actually asks, not scheduled.

The rest of this section stands as the design for *if* that happens.

**Requirement sharpened 2026-08-09:** this isn't just "add more providers." The sign-in screen has to become a **conventional web-app auth page** — sign in to an existing account, or create a new one — instead of the single "Sign in with Discord" button that is the entire entry point today. That shape is right for a Discord-native club of twelve friends and wrong for a product a stranger is expected to sign up for.

**Identity providers stay first-class, not a fallback.** Email accounts are *added alongside* Discord and Google, not in place of them: anyone who prefers to sign in with a provider should keep doing exactly that, and every existing Discord reader must be unaffected — no migration, no re-auth, no change to how they get in. The point is that email is *available*, not that it's preferred. A conventional page presents both together — provider buttons and an email form on the same screen — with neither buried.

Concretely, the auth surface needs:
- **Email accounts as an equal path.** An email field, a password (or a magic link — see the decision below), a "Create account" path distinct from "Sign in", and a forgot-password flow, sharing the screen with the provider buttons.
- **A display name step.** Everything today gets a name and avatar from Discord metadata via `displayNameFromMeta`. An email signup has neither, so it currently lands as "Reader". Somebody signing up needs to be asked what to call them, which is the first thing that genuinely has to write to `profiles` rather than `shelf_users`.
- **`displayNameFromMeta` normalizer per provider** — each nests name/avatar differently, and email has nothing to nest.
- **Identity linking**, so one human signing in with Google *and* Discord isn't two accounts (Supabase `linkIdentity`). This gets *more* important once both paths are equally used, not less: the common case becomes someone who signed up with `you@gmail.com` and later clicks "Sign in with Google" for the same address, or a Discord reader who later wants a password. Supabase's behavior here depends on whether same-email linking is enabled, and the two settings fail in opposite directions — one silently merges accounts, the other creates a duplicate person with an empty shelf. Needs a decision and a test, not a default.
- **Discord degrades gracefully.** `/mybook` and the winner @-ping key off `discord_id`; readers without one already work, and the webhook already falls back to a plain announcement. Discord also becomes **optional per club** (a club supplies its own webhook or gets no integration) — that half is Phase 6.

Three things this drags in that the original one-line plan didn't account for:

1. **Transactional email becomes infrastructure.** Supabase's built-in SMTP is rate-limited to a handful of messages an hour and explicitly not for production. Confirmations, magic links and password resets all need a real provider (Resend / Postmark / SES) plus a verified sending domain on `sh3lf.net`. This is the first hard external dependency and the first thing on the running-cost table (§6) that isn't Supabase.
2. **Email confirmation collides with invite links.** If confirmation is on, a new reader can't act until they've clicked a link in their inbox — so "click invite → sign up → land in the club" becomes a flow that leaves the browser and comes back. The invite code has to survive that round trip. (It doesn't survive the *current* OAuth round trip either — see the bug noted in §8 Phase 4.)
3. **Bot signups become possible.** Open signup with email is a spam vector in a way Discord OAuth wasn't. Supabase supports hCaptcha/Turnstile on sign-up, and sign-in attempts want rate limiting. This is §7's "club creation limits" problem arriving one layer earlier, at account creation.

**Decision needed: password or magic link?** Passwords are what "standard auth" means to most people and work offline from email once set, but bring reset flows, strength rules and credential-stuffing exposure. Magic links delete the whole password surface but make every sign-in depend on email delivery and read as unusual to some users. Supabase does both; the honest middle is passwords as the default with magic link as a "email me a link instead" option, at the cost of building both.

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
| ~~Transactional email~~ | **$0 — deferred (§4).** Free tiers would have covered the volume anyway; the real cost was domain verification and owning deliverability forever |

≈ **$26/mo**, and nothing currently planned changes that. Fine as a hobby; needs a funding answer if it grows.

---

## 7. Open-signup consequences

**Reopened in full by §10 (revised 2026-07-27):** briefly scoped down to invite-only friends for one day, reverted back to open signup — anyone can register and create their own club, with no invite required to create one. This is real product surface that has nothing to do with books:

- **Club creation limits** — rate-limit per user per day, or it's a spam vector.
- **Slug rules** — validation, reserved words (`admin`, `api`, `c`, `new`…), squatting. Needed regardless for `/c/<slug>` routing, but squatting specifically only matters once strangers (not just people you know) can claim any slug they want.
- **Lifecycle** — leave a club; transfer librarian; last librarian leaving must promote or archive, not orphan.
- **Deletion** — delete a club (done, Phase 4 slice 4e) and delete an account (**not done** — owned by Phase 6b; the cascades are already correct, the surface to trigger them doesn't exist).
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

Also discovered: **`supabase db reset` did not work on this repo**, and a fresh project couldn't be bootstrapped from `migrations/` alone — the first migration altered `shelf_users` but nothing ever created it, because the base schema came from running `schema.sql` in the SQL editor. Fixed in Phase 4 prep (see below), since Phase 4 needs somewhere other than the live club to create test clubs.

### Phase 4 — Signup & lifecycle
Create a club, invite codes, join, leave, transfer librarian, delete. Onboarding for an empty club. Since §7 is open in full again (open signup, revised 2026-07-27), this phase also owns club-creation rate limiting and slug validation/reserved words — not just the lifecycle actions.
**Exit:** a stranger can go from landing page to a running club without you.

Unblocked by Phase 3.5, which cleared the prerequisites: a new club now has somewhere to keep its game state, its own reader pool, and its own calendar feed. What this phase still owns on the tenancy side: resolving `parseRoute()`'s captured slug to a real club (the client still hardcodes `DEFAULT_CLUB_ID`/`DEFAULT_CLUB_SLUG`, as do all six edge functions — **52 references in total**, 25 of them in `admin-update`, so 4b is more mechanical churn than "mostly mechanical" suggests), creating the `clubs` + `shelf_state` + `club_secrets` + founding-librarian rows together, and replacing `join_default_club()` with an invite-gated join.

#### Prep — ✅ done 2026-08-09

Two things had to be true before writing a line of Phase 4, neither of them in the original plan:

1. **Backups had to actually happen.** Phase 4 means holding strangers' clubs, and "there were no backups" reads differently when the lost data isn't yours. `scripts/backup.sh` existed but nothing ran it; there is now a daily LaunchAgent (`net.sh3lf.backup`, `scripts/install-backup-agent.sh`), verified end to end under launchd from a cold Colima. Testing it there — rather than only from a shell — turned up that `backup.sh` had been parsing a response shape that only existed inside the tooling wrapper it had been run through, so the committed script would have failed in a plain terminal. Pro's PITR is still the real answer (§6).

2. **There had to be somewhere other than production to work.** Phase 4 is *about creating clubs*; you can't develop that against the live book club. `supabase db reset` now replays all 21 migrations into a local Postgres, via `00000000000000_bootstrap_base_tables.sql` (the `shelf_state`/`shelf_users` the chain always assumed, recorded on production as already-applied rather than run) plus a guard on the hardcoded production librarian id that used to abort the chain with a foreign-key error on any other database. `supabase start` needs `-x vector` under Colima.

**Slices:** 4a prep ✅ · 4b club from the URL ✅ · 4c create a club ✅ · 4d invites + join ✅ · 4e leave / delete ✅ · 4f onboarding ✅

#### 4c–4f — the lifecycle — ✅ done 2026-08-09

All of it lives in one new edge function, `club-admin`, deliberately separate from `admin-update`: that one is gated on "you are a librarian of this club", which is the wrong question for half of these — `create_club` has no club yet, and `join_with_invite` is by definition performed by someone who isn't a member. Each action states its own gate.

- **4c create.** `#/new`. Any signed-in reader, **3 clubs per rolling day** (§7's "club creation limits"). Slug rules: 3–32 chars, lowercase alphanumerics, single inner hyphens, plus a ~55-word reserved list covering route collisions (`api`, `new`, `join`, `c`…) and impersonation (`admin`, `official`, `support`). Enforced in the function for the error message and by a `clubs_slug_shape_chk` constraint as a backstop. New clubs default to **private** (§10 item 2). The club, its `shelf_state` row, its founding librarian and its `club_secrets` row are created together — and because PostgREST has no cross-statement transaction, a failure part-way **deletes the club it just made**, so a half-built club can't squat a slug forever.
- **4d invites.** `club_invites`, keyed by a 12-char Crockford-ish base32 code (no I/L/O/U, so a code read aloud can't become a different valid one). Optional expiry and use cap; revocable. Librarians create/copy/revoke from the Admin tab. Read policy is `is_librarian()`, **not** `is_member()` — a code is a credential, and any member being able to list them would make invite-only meaningless. That's the first RLS policy in the app that asks about a role, so it's also what finally needed `is_librarian()`, sketched back in §3 and deferred through Phase 2. Joining is `#/join/<code>`; every unusable-invite case returns one identical message so a stranger probing codes learns nothing.
- **4e lifecycle.** Leave from the footer; **the last librarian is refused** and must promote someone or delete the club. Delete requires librarian *and* typing the club's name, re-checked server-side. `shelf_users` rows survive a deletion — identity isn't owned by a club.
- **4f onboarding.** A three-step checklist (invite readers → set books → spin) replaces the Reading tab of a club that has no other members, no books and no history. It ticks itself off and disappears.

Plus a club switcher in the footer once you're in more than one, and `#/new` reachable from everywhere.

Two things the schema had never actually had, both found by trying to use it rather than by reading it:

- **`clubs.id` had no default.** The seeded row's uuid was hardcoded, so nothing ever needed one; creating a club failed with a not-null violation. The plan's §2 sketch had `default gen_random_uuid()` all along.
- **No `club_id` foreign key cascaded.** §2 claimed reviews and comments would get cascade deletes "for free" with the `reads` table; they never did, and `delete_club` failed with a 23503 on the first child table. Now every FK pointing at `clubs` is rewritten to `on delete cascade`, discovered from the catalog rather than named, so a table added later that forgets gets picked up.

Verified over real HTTP against locally-served functions with two users: six slug rejections each with their own message, a duplicate slug 409, the rate limit tripping on the 4th club, a non-librarian refused an invite, a bogus code and a spent code both refused identically, a **member reopening a spent invite still landing in the club** (the first cut got this wrong — the validity check ran before the membership check, so a single-use invite told its own successful user it was invalid), the last librarian refused when leaving, a plain member leaving cleanly, delete refused without the exact name, and a delete cascading away reads/reviews/members/invites/state/secrets while leaving the identity row intact.

**Exit:** a stranger can go from landing page to a running club without you. ✅ — with the caveat below.

#### 4b — club resolved from the URL — ✅ done 2026-08-09

The slug in `#/c/<slug>/<tab>` had been parsed since Phase 3 and ignored. Now:

- The client resolves it against `clubs` and routes all 12 scoped queries and both realtime filters through `clubId()`. Three states: `ok`, `not_found`, and `not_member` (a real club you're not in — its rows are already invisible under RLS, so without this you'd get a working-looking club with an empty shelf; turning that into "ask for an invite" is 4d).
- **Five of the six edge functions now take `club_id` from the request** and authorize against it: `admin-update` requires `club_members.role = 'librarian'` for *that* club, and `set-book`/`set-review`/`post-comment` require membership of it. An absent `club_id` still means the seeded club, so the frontend and the functions can be deployed in either order without a broken window. `set-book` also changed from upsert to update — now that the caller names the club, an upsert would have let anyone insert themselves into any club and appear on its shelf.
- `discord-interactions` is deliberately **not** parameterized: a slash command carries a guild and a Discord user, no club. Mapping guild → club needs `clubs` to know its guild id, which is Phase 6.

Verified against a local database with two real clubs, over real HTTP to locally-served functions: a member of club A got 403 `not a member of this club` from `set-book`/`set-review`/`post-comment` on club B; a librarian of B got past `admin-update`'s gate on B and 403 `not a librarian` on A; a bad `club_id` got 400; an omitted one still worked. Then club B ran a **full draw of its own** — picked its book, advanced to round 2 — while club A stayed at round 1 with its reads and eliminated list untouched. That's the plan's Phase 1 exit criterion ("two clubs coexist with no data bleed") finally demonstrated by two clubs actually *running*, not just by isolation queries.

#### What Phase 4 leaves open

- ~~**Sign-up is still Discord-only**~~ — **closed 2026-08-09.** Google sign-in shipped (5c), so "a stranger can start a club" now means anyone with a Google or Discord account. Email accounts are deferred by decision (§4), so the entry point is two provider buttons rather than a credential form — deliberately, not pending.
- ~~**`join_default_club()` still exists and still runs on every sign-in**~~ — **closed 2026-08-09.** The RPC is dropped (`20260809170000`) and signing in joins you to nothing; getting into a club is an invite or creating one. Dropped rather than left unused, because `security definer` + execute-to-`authenticated` meant any signed-in caller could invoke it directly no matter what the UI did. Two consequences worth knowing: a brand-new account now lands on the "you're not in a book club yet" screen, and membership is checked for **every** club including the seeded one — which means a `public` club is currently viewable only by its members, even though RLS would allow anyone to read it. Spectating a public club is a real feature that doesn't exist; the signed-out gate already meant nobody could do it in practice.
- **Transferring the librarian role** is `admin_grant_librarian`/`admin_revoke_librarian` in `admin-update`, which existed already; there's no single "transfer ownership" action, and `clubs.created_by` is recorded but never consulted for permissions.
- **Moderation and Terms/Privacy** (§7) are untouched, and **account deletion** now has an owner (Phase 6b) but no implementation — §7's Legal item can't be satisfied until it exists. Open signup plus other people's content is exactly the situation that makes them matter, and none of it is engineering-blocked.
- `/mybook` still only works for the seeded club — see the note in `discord-interactions`; guild → club is Phase 6.

### Phase 5 — Standard auth
Rescoped 2026-08-09, then partly withdrawn the same day (see §4). The intent was a conventional sign-in / create-account page with identity providers first-class alongside email. What shipped is the provider half: Discord unchanged for everyone already using it, **Google added**, and a gate built to hold more. Email accounts are deferred indefinitely, so "standard auth" here means two OAuth buttons rather than a credential form.
**Exit:** ~~a stranger can create an account with an email address~~, an existing Discord reader notices no difference ✅, and a club can run with zero Discord users ✅ — via Google rather than email. The email half of that criterion is withdrawn, not outstanding (§4).

**Slices:**

- **5a — email accounts.** ⏸ **Deferred indefinitely (§4).** Sign in / create account / forgot password against Supabase email auth, on one screen with the provider buttons. Needs a transactional-email provider, and password reset makes that non-optional rather than nice-to-have.
- **5b — display names.** ⏸ Deferred with 5a, but **not blocked by it.** The original driver was that an email signup arrives with no name or avatar and lands as "Reader" — which no longer happens, since every account comes from a provider that supplies both. What remains is that a reader can't choose a name *different* from their provider's, and that's worth doing on its own if anyone asks. Two things stay true whenever it happens: `ensureUserRow` overwrites the name from provider metadata on every sign-in and would clobber a chosen one (see Phase 6b), and this is **the first thing with a real reason to read `profiles`** rather than `shelf_users` — where the table added in Phase 1 finally earns its place.
- **5c — Google.** ✅ **Shipped and verified 2026-08-09.** Human-tested end to end: both providers sign in, identity linking confirmed against production (see 5d), and the second Google sign-in was screen-less. **Not blocked by SMTP** — OAuth sends no mail, so this is the one slice that needs nothing but dashboard configuration. What it took: Google Cloud OAuth credentials pointed at `https://<project-ref>.supabase.co/auth/v1/callback`, the consent screen **published** (in *Testing* only listed test users can sign in, which looks like a broken integration), the provider enabled in Supabase, and `enabled: true` on the Google entry in `AUTH_PROVIDERS`. Free throughout — no billing account, and the default scopes need no Google review. The one real risk was same-email linking, handled by measuring it rather than trusting it (5d).
- **5d — identity linking.** ✅ **Effectively done, by measurement rather than code.** Supabase links a second provider onto an existing account when the email matches and is verified — confirmed on production the day Google shipped: signing in with Google on an existing Discord reader's address left `auth.users` at 12, produced one user holding both identities, and preserved all 12 `discord_id` values. What's left is only a *UI* for connecting/disconnecting providers deliberately (Phase 6b), which is now cosmetic rather than load-bearing.
- **5e — abuse controls.** ⏸ Deferred with 5a, and its urgency went with it: Turnstile/hCaptcha mattered because *email* sign-up is a cheap bot vector. Creating an account still costs a real Discord or Google account, which is a meaningful floor. Club-creation rate limiting (3/day) already shipped in Phase 4c.

#### Prep — ✅ done 2026-08-09

Everything that doesn't depend on the two blockers below, so that when they clear, 5a–5e is UI work rather than plumbing:

- **Per-provider identity extraction**, with a real latent bug fixed. `discord_id` was derived from `user_metadata.provider_id || .sub`, which are whatever the *most recent* provider wrote — so a Google sign-in would have written a **Google** subject id into `shelf_users.discord_id`. That's the column `/mybook` looks readers up by, and it's unique on `profiles`, so the outcomes ranged from an inert wrong value to overwriting a real Discord id (breaking that reader's slash command) to a unique-violation on sign-in. Now `discordIdFromUser()` reads the authoritative per-provider `identities` array. `displayNameFromMeta` gained Google and email fallbacks *after* the existing Discord chain, so no current reader's name changes, and `avatarFromMeta` handles Google's `picture`.
- **`profiles` is written live**, not a snapshot — `ensureUserRow` upserts it on every sign-in. Nothing reads it yet; that flip is 5b. Verified under real RLS: own row 201/200, someone else's row 42501.
- **A "you're not in a book club yet" landing state**, offering the only two things such a reader can do — start a club, or redeem an invite code. Reachable today by leaving your last club, and it becomes the normal first screen for every new account the moment `join_default_club()` is retired. Built before that change rather than after it, so retiring the auto-join is a one-line decision with somewhere to land.
- **The repo's first client-side tests** (`tests/`), 15 cases across identity and the post-auth redirect. `index.html` has no exports and needs a DOM, so they slice the relevant block out of the file at run time and run it in a `vm` — testing what ships, and failing loudly if a function is renamed rather than passing against a copy that has rotted.

**Prerequisite, and the reason 5a is deferred: transactional email.** A verified sending domain on `sh3lf.net` plus Resend/Postmark/SES. Supabase's built-in SMTP is rate-limited to a handful of messages an hour and explicitly not for production, so *every* email-shaped feature depends on it. It would have been the project's first hard external dependency — which, weighed against a third sign-in option, is why it isn't being taken on (§4).

**~~Do first~~ — done 2026-08-09:** the invite/redirect bug in §8's Phase 4 notes was fixed and human-verified (a signed-out invitee now keeps their code across the OAuth round trip). Originally flagged here because Phase 5 would have made it worse; that risk is moot now that email confirmation isn't coming. Kept for the record: `signIn()` strips the hash before the OAuth round trip, so a signed-out person clicking `#/join/<code>` loses the code and lands in the seeded club instead. Phase 5 makes this strictly worse — email confirmation adds a second round trip through the user's inbox, and both have to preserve where the person was going. Worth fixing as its own small change rather than inside a big auth rewrite.

**Also worth deciding here:** signed-out visitors currently see nothing but the sign-in gate — there is no public landing page, and a `public` club isn't actually readable without an account even though RLS allows it. A conventional signup flow usually has something to sign up *from*.

### Phase 6 — Settings

Added 2026-08-09: this was only ever *per-club* settings. There is no account settings page anywhere in the plan, and today a reader can change exactly two things about themselves — their book, and signing out. Everything else about them (display name, avatar, how they sign in) is decided by their identity provider and unchangeable from inside the app. Split into the club-facing half and the personal half, which share the same settings scaffolding.

#### 6a — per-club settings — ✅ done 2026-08-10
Name, tagline, timezone, visibility, own Discord webhook and own ICS token, all editable from **Admin → Club settings**. The librarian-facing counterpart to the member management already in that tab.

The timezone was the one that mattered: it was a `CLUB_TZ` constant of `America/Toronto`, so **a club founded anywhere else scheduled its 50%/100% discussions at the wrong hour** — a defect in what Phase 4 shipped, not a missing feature. It's `clubs.timezone` now, read through `clubTz()`. Entirely client-side, because no edge function ever handles wall-clock time; they only see instants. Validated in `club-admin` by asking `Intl` to construct a formatter with the name, which is precisely what the client then does with it, and the settings form shows the club's current local time so a librarian can sanity-check the zone rather than trust the string.

`club_secrets` finally does something, three years of Phase-1 groundwork later:

- **Discord webhook** — `webhookFor(client, clubId)` in `admin-update`/`set-book`/`discord-interactions` prefers the club's own and falls back to the `DISCORD_WEBHOOK_URL` env secret, so the seeded club kept working untouched and a club with neither simply posts nothing. Proven end to end on a local stack with **no env secret set**: a draw produced a `404 Unknown Webhook` from Discord, which can only mean the POST target came from `club_secrets`.
- **Calendar token** — surfaced in the UI at last, with a rotate button. Rotating invalidates every existing subscription, which is the point: the token is what makes the ICS URL unguessable. Verified the old token then 404s and the new one serves, titled with the club's own name.

Neither reaches the browser by a table read — `club_secrets` has no RLS policies at all — so both arrive via `get_club_settings`, which returns the calendar token but **only a boolean for the webhook**. A librarian needs to know whether one is set, not to read a credential out of the page.

The slug is deliberately **not** editable: changing it breaks every link and invite already shared, so `update_club` refuses it rather than half-supporting it. Cadence from the original sketch is dropped — nothing reads it, and "when do we meet" is already answered per-read by the meeting scheduler.

**Exit:** nothing about a club is hardcoded. ✅

#### 6b — account settings *(new)*
One page a reader reaches from their own name, owning what is currently unreachable:

- **Display name and avatar.** **Blocked by a conflict that has to be resolved first:** `ensureUserRow` upserts `discord_username` from provider metadata on *every* sign-in, so a name the reader chose would be silently overwritten the next time they signed in. Either the write becomes insert-only, or a "this was customised" flag has to suppress it. This is also where `profiles` stops being written-but-unread (see 5b) and becomes the thing the app actually displays.
- **Email address**, via `supabase.auth.updateUser` — needs confirmation, so blocked on Phase 5's SMTP.
- **Password**: set one, change one, or have none because you only use a provider (5a).
- **Linked identities**: connect or disconnect Discord and Google (5d), with the obvious guard — you can't remove your last way in. Disconnecting Discord also has a side effect worth surfacing: it clears `discord_id`, so `/mybook` and the winner @-ping stop working for that reader.
- **My clubs**: the list, leaving (currently only in the footer), and which club a bare URL should land on — a real question now that a reader can be in several and `DEFAULT_CLUB_ID` decides for them.
- **Delete my account.** §7 has owed this since open signup was decided, and §7's Legal item ("account deletion must genuinely delete") is not satisfiable without it. The cascades are already right, and worth stating because the outcome is a deliberate one: `shelf_users`, `profiles`, `club_members`, `shelf_reviews`, `shelf_comments`, `shelf_comment_reactions` and `shelf_librarians` all cascade from `auth.users`, while `reads.winner_id` is `on delete set null` and `winner_username` is plain text — so **the club's ledger keeps the pick, and the person disappears from it**. That's the right trade (a club's history shouldn't develop holes when someone leaves the product) but it should be said out loud on the confirmation screen rather than discovered.
- **The last-librarian guard applies here too.** `leave_club` already refuses the sole librarian of a club; deleting an account has to make the same check across *every* club the reader administers, or it orphans them — with no UI anywhere to fix it afterwards.

**Exit:** a reader can change their name, how they sign in, and leave entirely, without anyone touching SQL.

**Sequencing note:** 6b's email/password items are blocked on Phase 5, but display name, my-clubs and account deletion are not — and account deletion is the one item here with a legal rather than a product deadline, since open signup is already live.

**Pulled forward and shipped 2026-08-09:** `#/account` exists, carrying account deletion plus a read-only view of who you are and which clubs you're in. `club-admin`'s `delete_account` requires the phrase "DELETE MY ACCOUNT" and refuses anyone who is the **sole librarian of any club**, naming them — the `leave_club` guard applied across every club rather than one, since without it deleting an account orphans clubs with no UI anywhere to appoint a replacement. Deleting the `auth.users` row is the whole deletion; verified empirically on a local database that `shelf_users`, `profiles`, `club_members`, `shelf_reviews` and `shelf_comments` all go, while `reads` keeps the row with `winner_id` set to null and `winner_username` intact — the club's ledger keeps the pick, the person disappears from it, and the confirmation screen says so. The rest of 6b (display name, email, password, linked identities) is listed on the page as still to come rather than omitted, so it tells the truth about what you can change.

### Phase 7 — Frontend restructure *(when justified)*
3,815 lines of string-built HTML in one file, full re-render per change. Revisit when the pain justifies it — not before.

---

## 9. Security items not to defer

- **ICS feed is public and unauthenticated.** ✅ closed. Phase 3.5 made `calendar-feed` take `?token=<calendar_token>` with a token-less request serving only the seeded club (never all clubs); Phase 6a surfaces the token in Admin → Club settings, with a rotate button for when a link leaks. The token-less fallback is kept on purpose so subscriptions predating all this keep working — it resolves to the seeded club and nothing else.
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

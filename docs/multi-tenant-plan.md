# Multi-tenant plan — "The Shelf" as a product

**Status:** Phases 0–2 (harden, tenancy foundation, per-club librarian role) are implemented and live in production. Phases 3–7 (routing/hosting move, signup/invites, more auth providers, per-club settings, frontend restructure) are still proposal — see §8 for what's actually landed vs. what isn't.
**Goal (decided 2026-07-26, see §10):** friends can create private book clubs at `sh3lf.net`, invite members, and run the wheel/meetings/reviews flow independently of every other club — free, invite-only (not open public signup), Discord optional per club rather than required.

This builds on the feasibility findings: the blocker isn't difficulty, it's that the data model changes under everything at once, and there are currently no tests to catch what breaks.

---

## 1. Target architecture

| Concern | Today | Target |
|---|---|---|
| Hosting | GitHub Pages | Cloudflare Pages (free, custom domain, SPA rewrites) |
| URL | `ajrpugs.github.io/the-shelf/` | `<domain>/c/<club-slug>` |
| Auth | Discord only | Email magic link + Google + Discord |
| Club state | `shelf_state` row `id=1` | `club_state` row per club |
| Past reads | jsonb array inside that row | `reads` table |
| Librarian | one shared `ADMIN_PASSWORD` | `club_members.role = 'librarian'` |
| Reads/writes | unscoped `select("*")` | scoped by `club_id` everywhere |

### Routing: path-based, not subdomains

Use `/c/<slug>` (e.g. `theshelf.club/c/bibliomancers`). Subdomains (`bibliomancers.theshelf.club`) look nicer but need wildcard DNS + wildcard certs + per-tenant host handling — not worth it at this stage. Path routing needs one cert and one SPA rewrite rule.

This finally forces a real router, which also fixes the tab-linking problem we've hit three times (`#tab=calendar` has no URL today).

### Hosting: move off GitHub Pages

Pages *does* support a custom domain, but it can't do SPA path rewrites — `/c/foo` would 404 on refresh. Cloudflare Pages (or Netlify/Vercel) gives a `_redirects` rule (`/* /index.html 200`), free custom domain + TLS, and is a drop-in for a static file. No build step required to move.

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
- **No tests.** The only harness is the ad-hoc headless DOM stub used during the calendar work. A refactor of this size without tests is where things break quietly.

---

## 6. Scaling — what actually costs money

Supabase will not be the bottleneck. A club's state is a few KB; a thousand clubs is single-digit MB against a 500 MB free-tier database.

**Two things must be right from day one**, or cost scales with *total users across all clubs* rather than per club:

1. **Scope `loadAll`.** It currently does `select("*")` on users, reviews, and comments with no filter. Every client would download every club's data on every refresh.
2. **Filter realtime.** The four `postgres_changes` subscriptions have no filter, so Club A's activity re-renders Club B. Add `filter: 'club_id=eq.<id>'`.

Upgrade to **Supabase Pro** for reliability, not capacity:
- Free projects **pause after ~a week of inactivity** — unacceptable once others depend on it.
- **No daily backups on free** — one bad `reset` from losing every club's history.

### Running cost

| Item | Cost |
|---|---|
| Supabase Pro | ~$25/mo *(verify current pricing)* |
| Domain | ~$12/yr |
| Cloudflare Pages | $0 |

≈ **$26/mo**. Fine as a hobby; needs a funding answer if it grows.

---

## 7. Open-signup consequences

**Narrowed by §10:** this is invite-only for friends, not open public signup — no discovery surface, no anonymous strangers creating clubs. That drops the spam/abuse-vector items below to non-issues and lightens moderation/legal, but the lifecycle basics still apply since clubs are still genuinely multi-tenant (multiple independent friend groups, each private):

- ~~**Club creation limits**~~ — not needed without open signup; still worth a sane per-user cap so one person can't accidentally spin up dozens.
- **Slug rules** — still needed for `/c/<slug>` routing: validation, reserved words (`admin`, `api`, `c`, `new`…).
- **Lifecycle** — leave a club; transfer librarian; last librarian leaving must promote or archive, not orphan. Still needed — friend groups disband and reform too.
- **Deletion** — delete a club, delete an account, with cascades that actually work.
- **Moderation** — lighter: clubs are private by default, so comments are only visible to invited members, not world-readable. Still worth a delete path for a bad actor within a friend group.
- **Legal** — lighter than an open product, but still holding other people's accounts/content — a minimal Terms + Privacy is still owed once friends outside the original circle join.
- **Support** — someone will lock themselves out of librarian mode.

Smaller than the original open-signup scope, but not zero. The tenancy work in §1–6 doesn't change either way.

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

### Phase 3 — Routing + hosting
Move to Cloudflare Pages, custom domain, `/c/<slug>` router. Tabs get real URLs.
**Exit:** deep links work on refresh; club resolves from the path.

### Phase 4 — Signup & lifecycle
Create a club, invite codes, join, leave, transfer librarian, delete. Onboarding for an empty club.
**Exit:** a stranger can go from landing page to a running club without you.

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

- **ICS feed is public and unauthenticated.** Per-club feeds keyed by `club_id` would let anyone enumerate other clubs' schedules. Use `calendar_token` in the URL.
- **Discord webhook URLs are credentials** — anyone holding one can post to that channel. Hence `club_secrets`, service-role only.
- **RLS is the only thing between tenants.** Test it like it matters.

---

## 10. Decisions needed before Phase 0 — ✅ answered 2026-07-26

1. **Domain name?** `sh3lf.net` — already owned and already the `CNAME` for the current single-club GitHub Pages deployment. Phase 3's move to Cloudflare Pages keeps this domain; only the host and its DNS records change (GitHub Pages' A/CNAME records → Cloudflare Pages').
2. **Are clubs public or private by default?** Private. The one seeded club (`the-shelf`, `visibility = 'public'`) stays as-is — new clubs default to `private`.
3. **Is Discord still first-class,** or one integration among several? **Not first-class.** Some clubs won't use it at all, so Discord becomes fully optional per club (§4/§9: no webhook configured = no Discord integration, `/mybook` and the winner ping degrade gracefully when a member has no `discord_id`).
4. **Free forever, or eventually paid?** Free. No billing/plan model needed anywhere in the club schema.
5. **Is this a product you want to support?** Yes, but scoped down from "anyone can sign up" to **multi-tenant for friends** — invite-based clubs, not open public signup. This narrows §7: no discovery, no spam-vector club-creation limits, lighter moderation/legal load than an open product would need, since membership stays invite-only among people who know each other. Still needs the leave/transfer-librarian/delete lifecycle basics — those aren't specific to public signup.

---

## Bottom line

Roughly: Phase 0–2 is the bulk of the engineering and the part that must be right. Phases 3–6 are mostly mechanical. Phase 7 is optional until it isn't.

The two ways this goes wrong are (a) starting Phase 1 before Phase 0, so the data model moves with no tests underneath it, and (b) shipping unscoped `loadAll`/realtime, so infra cost scales with total users instead of per club. Everything else is recoverable.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"The Shelf" is a multi-club book-club picker, live at **https://sh3lf.net/**. Readers sign in (Discord or Google), each set one book, and a librarian spins a wheel that randomly picks an eligible reader. Picked readers sit out until the round turns over. On top of that sit a rubric review system (members score a finished read 1–20 across five categories, averaged into a /100 "Guild score") and per-book comment threads.

Any signed-in reader can **create a club** (`#/new`, 3 per day), invite people with a code (`#/join/<code>`), leave, or delete a club they run. **Which club a page shows comes from the URL** (`#/c/<slug>/<tab>`); **which club a write touches comes from a `club_id` in the request** — never from a constant. `DEFAULT_CLUB_ID` survives only as the fallback for a request that names no club, which is what lets the frontend and the edge functions deploy in either order.

There is **no build step and no framework**. The frontend is a single `index.html` (~5,900 lines) — a vanilla JS ES module that pulls `@supabase/supabase-js` from esm.sh and renders everything by hand, including a `<canvas>` spinning wheel. All persistence is Supabase (Postgres + Realtime + Edge Functions).

`docs/multi-tenant-plan.md` is the record of how it got here and, more usefully, **which things were decided against** — read it before proposing email/password auth, paid backups, or a frontend rewrite.

## Architecture

### Frontend (`index.html`)

Everything is in one `<script type="module">`.

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` are hardcoded constants near the top (the anon key is public by design). `CONFIGURED` gates the app when they're placeholders.
- **Auth** is OAuth via `supabase.auth.signInWithOAuth({ provider })`. Providers are declared in `AUTH_PROVIDERS` — Discord and Google, both enabled. On sign-in, `ensureUserRow` upserts the reader into `shelf_users` **and** `profiles`.
- **Club resolution**: `resolveClubFromRoute()` looks the URL's slug up in `clubs` and sets `club` plus `clubStatus` — `ok`, `not_found`, `not_member`, or `no-clubs`. Everything club-scoped goes through `clubId()` / `clubSlug()` / `clubTz()`, never a constant. **Membership is checked for every club, including the seeded one**; a non-member gets the "you're not in this club" page rather than a club's app with nothing in it.
- `loadAll` fetches this club's `shelf_state`, `club_members`, `shelf_reviews`, `shelf_comments`, `shelf_comment_reactions` and `reads` (ordered `ts` desc) in parallel, then a follow-up `shelf_users` fetch (`.in("id", memberIds)`) for identity, and feeds `reads` into `normalizeState` as the history source. `subscribeRealtime` listens on all seven of those tables and debounces via `queueRefresh`. Every query and channel is filtered by `clubId()` except `shelf_users`, which is global identity with no `club_id` to filter on.
- **The client's `users` array is a join, not a table.** Each entry is a `shelf_users` identity row (`discord_username`, `avatar_url`, `discord_id`) merged with that member's `club_members` row (`book`, `role`). `librarianIds` / `amLibrarian` come from the same fetch, so the Admin gate can't drift from the member list being rendered. A `club_members` row with no matching identity is skipped.
- The UI is re-rendered by string-building `render()`, with `esc`/`attr` escaping helpers, after every state change.
- **Routes.** The signed-in main view is tabbed — `Reading | The Shelf | The Wheel | Leaderboard | Stats | Reviews | Calendar`, plus `Admin` in librarian mode. Tab navigation goes through `goToTab(id)`, which sets `location.hash` to `#/c/<slug>/<tab>`; `parseRoute()` re-reads `currentTab` from the hash on every `render()`, so **any programmatic tab switch must also go through `goToTab()`** or the next render silently reverts it. Standalone routes: `#/new` (create a club), `#/join/<code>`, `#/account`. Five older detail routes (`#book=`, `#shelf=`, `#tag=`, `#reader=`, `#recap`) short-circuit `render()` into full-page views before the tabs are built.
- `render()` bails early while an `<input>`/`<textarea>` has focus (deferring via `pendingRender`). **Any handler that changes state from a button must `document.activeElement?.blur?.()` first** — Safari doesn't focus buttons on click, so the re-render would be silently swallowed.
- **Reads go straight to Postgres under RLS; writes go through edge functions** — with three deliberate exceptions, all of them the caller's own row with no secret and no cross-user effect: `shelf_comment_reactions`, and the `profiles`/`shelf_users` display-name update.
- Book covers come from Open Library, client-side for display and server-side for Discord embeds.

### Data model (`supabase/schema.sql`) — 12 tables

- **`clubs`** — one row per club. `slug` (unique, in the URL), `name`, `tagline`, `visibility` (`public`/`private`), `timezone`, `created_by`. The seeded club is fixed id `8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8`, slug `the-guild`. `id` defaults to `gen_random_uuid()`. Its select policy is deliberately unscoped `using (true)` so a reader can resolve a club they were linked to *before* anyone knows whether they belong to it. Every `club_id` foreign key pointing here is `on delete cascade`, which is what makes deleting a club possible at all.
- **`club_members`** — **the source of truth for who is in a club, their `role`, and their current `book`.** Primary key `(club_id, user_id)`. Backs the `is_member()` RLS function, `admin-update`'s librarian check, the client's Admin gate, and `draw`'s eligible-reader pool. **No insert policy** — the only ways in are `club-admin`'s `join_with_invite` and `create_club`. **Signing in joins you to nothing**; a reader with no row here is invisible to the app and lands on the "you're not in a book club yet" screen.
- **`shelf_state`** — one row per club, keyed by `club_id` (`unique (club_id)`; `id` is an int PK that auto-assigns from a sequence). **Never query it by `id`.** `data` jsonb holds only `{ eliminated: string[] (user ids), roundNumber: number }`. A top-level `version` int is an optimistic lock (see `admin-update`).
- **`reads`** — one row per past pick: `round`, `winner_id`, `winner_username`, `book`, `ts`, `rating`, `ratings_open`, `meetings`. The source of truth for past reads. `ts` is unique per `(club_id, ts)`, not globally — a global unique would let one club's draw hard-fail another's.
- **`shelf_users`** — global identity, one row per human regardless of how many clubs they're in: `id` (= `auth.users.id`), `discord_username`, `avatar_url`, `discord_id`, and a vestigial `book`. Still the table the app **reads** for display names and what `admin-update` puts in Discord embeds. `discord_id` links a web account to a Discord user for `/mybook`. Deleting a row here would remove the person from *every* club, which is why `admin_remove_user` doesn't.
- **`profiles`** — provider-agnostic identity (`display_name`, `avatar_url`, `discord_id`, `display_name_customised`), written live on every sign-in. Read for the customised-name flag, but **deliberately not the source for display** — flipping that would mean touching the draw path and the Discord embeds at once, for tidiness rather than behaviour.
- **`shelf_reviews`** — one rubric review per `(club_id, book_ts, user_id)` — so upserts must pass `onConflict: "club_id,book_ts,user_id"`. Five categories (`plot`, `characters`, `pacing`, `language`, `themes`) 1..20 plus an optional `note`. A row is either fully scored or a `dnf` row with all five null; `shelf_reviews_dnf_scores_chk` keeps those mutually exclusive. **DNF rows are excluded from every score aggregate** (`aggregateRubric`, `reviewSuperlatives`, `bookBadges`, a reader's own average) but still count toward participation.
- **`shelf_comments`** — per-book threads keyed by `book_ts`. `parent_id` makes a reply; **threading is single-level**, enforced by `post-comment` rather than the DB (a check constraint can't look at other rows). Deleting a top-level comment cascades to its replies.
- **`shelf_comment_reactions`** — emoji on comments, PK `(comment_id, user_id, emoji)`. Written straight from the client under RLS.
- **`club_invites`** — `code` is the primary key **and the credential**: 12-char Crockford-ish base32 (no I/L/O/U) minted by `club-admin`. Optional `expires_at`/`max_uses`, plus `uses` and `revoked`. All three unusable-conditions are checked at join time rather than by a constraint, so a spent invite stays visible as history. Its select policy is **`is_librarian(club_id)`, not `is_member`** — any member being able to list codes would defeat invite-only.
- **`club_secrets`** — `discord_webhook_url` and `calendar_token`, PK `club_id`. **No RLS policies at all**: service-role only, unreachable from the browser. A librarian reaches it through `club-admin`'s `get_club_settings`, which returns the calendar token but **only a boolean for the webhook**, never the URL.
- **`shelf_librarians`** — legacy. Still mirrored by grant/revoke; **nothing reads it.** Roles live on `club_members.role`.

**RLS shape.** `shelf_state`, `reads`, `shelf_reviews`, `shelf_comments`, `shelf_comment_reactions` and `club_members` all select on `is_member(club_id) or clubs.visibility = 'public'`. `clubs`, `shelf_users` and `profiles` are unscoped reads. `club_invites` is librarian-only. `club_secrets` has no policies. Two SQL functions exist: `is_member()` (used widely) and `is_librarian()` (used only by the `club_invites` policy — `admin-update` does its own application-level role query instead).

**Privileges are separate from RLS.** `20260809150000_grant_table_privileges.sql` grants the API roles table access and sets `ALTER DEFAULT PRIVILEGES`. RLS decides *which rows*; privileges decide whether the role may touch the table at all. Without them you get correct policies and `42501 permission denied` — which is exactly what a fresh database did before that migration.

### Edge functions (`supabase/functions/`) — 7, Deno, deployed individually

All are deployed `--no-verify-jwt` because each verifies the caller itself.

- **`admin-update`** — librarian-gated writes to `shelf_state`/`reads`. Requires `club_members.role = 'librarian'` **for the club in the request body** (401 no token / 403 not a librarian), then uses the service-role key. Actions: `draw`, `new_round`, `reset`, `undo_last_spin`, `admin_clear_book`, `admin_set_book`, `admin_set_rating`, `admin_set_ratings_open`, `admin_set_meeting`, `admin_announce_meeting`, `admin_import_reviews`, `admin_grant_librarian` / `admin_revoke_librarian`, `admin_remove_user`.
  - `draw` picks a random reader with a book from **this club's `club_members`**, joined to `shelf_users` only for the winner's name/avatar/`discord_id` — never a sweep of `shelf_users`. It **auto-advances the round** when a pick empties the pool.
  - **Only `draw`, `new_round`, `reset`, `undo_last_spin` and `admin_remove_user` touch `shelf_state`**, each through `writeGameState()`, which conditions the write on `shelf_state.version` and bumps it. A 409 means another admin action landed first. **The versioned write always precedes the corresponding `reads` mutation**, so there's no window where a pick is recorded without `eliminated` reflecting it. The other actions skip the version guard entirely — applying it uniformly would risk a false 409 on an action whose real mutation had nothing to do with `eliminated`/`roundNumber`.
  - Every response reconstructs `history` fresh from `reads` (`order by ts desc`, aliasing `ratingsOpen:ratings_open`), keeping `{ state, winner, roundAdvanced }` a stable contract for the client.
  - Fires a Discord post after a durable `draw`, after `admin_set_meeting` when the schedule actually changed, and after `admin_set_rating` when the score actually changed. Each has a no-op guard, so an identical re-save stays silent — `admin_announce_meeting` exists precisely because of that. All posts happen **after** the state write and swallow their own errors: a dead webhook must never fail a librarian's action.
- **`club-admin`** — the club lifecycle, per-club settings, and account deletion: `create_club`, `create_invite`, `revoke_invite`, `join_with_invite`, `leave_club`, `delete_club`, `update_club`, `get_club_settings`, `set_club_webhook`, `rotate_calendar_token`, `delete_account`. **Separate from `admin-update` on purpose** — that one is gated on "librarian of this club", the wrong question for `create_club` (no club yet) and `join_with_invite` (performed by a non-member by definition). Each action states its own gate. It owns the rules the client must not be trusted with: slug shape and the reserved-word list, 3 clubs per user per rolling day, invite validity, and "the last librarian may not leave".
  - `create_club` builds `clubs` + `shelf_state` + the founding `club_members` row + `club_secrets` together and **deletes the club it just made if any later step fails** — PostgREST has no cross-statement transaction, and a half-built club would squat its slug forever.
  - `update_club` **refuses to change the slug** — that would break every link and invite already shared. `timezone` is validated by asking `Intl` to build a formatter with it, which is exactly what the client then does.
  - `join_with_invite` checks membership **before** invite validity, so someone already in the club still lands there when they reopen a spent link.
  - `delete_club` requires the club's name typed back. `delete_account` is the **only action taking no `club_id`** — it spans every club the caller is in, requires the phrase "DELETE MY ACCOUNT", and refuses anyone who is the sole librarian of *any* club. It deletes the `auth.users` row and lets cascades do the rest; `reads` deliberately survives with `winner_id` nulled and `winner_username` as text, so a club's ledger doesn't grow holes when someone leaves.
- **`set-book`** — a signed-in reader sets/clears their own book. Writes `club_members.book` (fatal) and mirrors `shelf_users.book` (best-effort). Requires membership of the named club.
- **`set-review`** — a member submits or clears their own rubric review for the *current* read. Only accepted while that read is the oldest unrated one **and** the librarian has `ratings_open` on it; `clear: true` is allowed anytime.
- **`post-comment`** — a member posts or deletes their own comment.
- **`discord-interactions`** — the `/mybook` slash command. **Must** verify Discord's Ed25519 signature (`DISCORD_PUBLIC_KEY`) or Discord rejects the endpoint. Looks the reader up by `discord_id`. **Pinned to the seeded club** — a slash command carries a guild and a Discord user, never a club, so mapping guild → club would need `clubs` to know its guild id. A reader in a second club sets that book in the web app instead.
- **`calendar-feed`** — public read-only iCalendar feed of one club's meetings, one `VEVENT` per scheduled 50%/100% meeting. `GET` only. The club comes from **`?token=<club_secrets.calendar_token>`**, because calendar clients can't send an apikey let alone a JWT. An unknown token is a 404; a *missing* token falls back to the seeded club (never "all clubs") so URLs predating the token keep working. Event `UID`s are deliberately **not** club-scoped — changing a UID makes every calendar client duplicate the event for existing subscribers.

`supabase/functions/_shared/shelf-logic.mjs` holds the pure draw/undo/rating/meeting decision logic, covered by `node --test`. Plain `.mjs` so it's both a valid Deno import at deploy time and runnable under Node with zero tooling.

**`admin-update`, `set-book` and `discord-interactions` each carry their own copy** of the Open Library cover lookup and Discord embed helpers (`normalizeForMatch`, `parseTitleAuthor`, `fetchCover`, `postBookSet`, `webhookFor`). Those three, and only those three, post to Discord. **If you change cover matching or embed formatting, change all three copies.**

## Gotchas

These are the things that have actually bitten. Most cost a bug before they were written down.

### Data shape

- **Never change `reads.ts` to `timestamptz`.** It's `text` on purpose — reused byte-for-byte from the client's `toISOString()` and compared with `===`/`eq()` against `shelf_reviews.book_ts` and `shelf_comments.book_ts`. A timestamptz gets re-serialized by PostgREST (`+00:00`, not `Z`) on every read, silently breaking every review and comment join.
- `shelf_state.data` is edited as a **whole object**, not per-field: read it, mutate, write it back under the `version` guard.
- `eliminated` and `reads.winner_id` hold **user ids**, not names. Legacy name-based entries and `cycle`/`cycleNumber` keys are tolerated by the client's `normalizeState`.
- Meetings live on the read: `reads.meetings = { half: { at, upTo }, full: { at } }`. `at` is an **ISO instant**; `upTo` ("read up to Chapter 12") exists only on `half`.
- The **"current read"** for reviewing is the *oldest* `reads` row without a committed rating. Rows come back newest-first, so it's the **last** unrated item, not the first. `set-review` and the client compute it identically.
- `shelf_state.version` is an optimistic-locking token, not app data. It only matters inside `writeGameState()` — don't expose it to the client or reason about its value elsewhere.
- **A reader's book is `club_members.book`, not `shelf_users.book`.** Writes go to the membership row (fatal) and mirror `shelf_users` (best-effort). Anything that *reads* a book must use `club_members` or it reads a stale mirror.
- `undo_last_spin` must detect whether the undone pick auto-advanced the round and roll `roundNumber` back (`rollbackUndo`).

### Multi-club

- **A caller naming its own `club_id` is only safe because every function re-authorizes against it.** `admin-update` requires the librarian role for that club; `set-book`, `set-review` and `post-comment` require membership of it. **Never add a club-scoped action without that check.**
- `set-book` deliberately **updates** rather than upserts the membership row — an upsert would let any caller insert themselves into any club and appear on its shelf.
- **Meeting times are pinned to the club's zone** (`clubs.timezone` via `clubTz()`), not the browser's. `clubWallToInstant` / `toClubInputValue` convert wall-clock ↔ UTC via `Intl.DateTimeFormat`, so DST is handled for whichever zone the club uses. Never use bare `new Date("...T20:00")` on a `datetime-local` value, and **never let an edge function parse one** — their local time is UTC, so `T20:00` would read as 8pm UTC. This is entirely client-side; no edge function reads `timezone`, because they only handle instants. `clubDTFFor(tz)` builds the formatter per call — the zone changes when you switch clubs, and a cached one would keep the previous club's.

### Auth

- **`user_metadata` describes the most recent provider, not the account.** It's overwritten on each sign-in, so a reader who links a second provider has metadata describing *that* one. Never derive a provider-specific id from it: `discord_id` comes from `discordIdFromUser()`, which reads the authoritative per-provider `identities` array. The older metadata-based code would have written a **Google** subject id into `shelf_users.discord_id` — the column `/mybook` looks readers up by, and unique on `profiles`. Covered by `tests/client-identity.test.mjs`.
- **Discord's OAuth `prompt` defaults to `consent`**, so its authorise screen reappears on *every* sign-in unless `prompt=none` is sent — and `prompt=none` errors instead of prompting when the account hasn't authorised the app yet. `signIn()` therefore sends it only when `localStorage` records a completed sign-in with that provider (`shelf:oauth-seen:<provider>`, set on `SIGNED_IN`). A stale flag produces an OAuth error, which `initAuth` reads out of the URL — **before `createClient` runs, since `detectSessionInUrl` consumes the fragment** — then clears the flags so the next click is an ordinary consent flow. Covered by `tests/client-oauth-consent.test.mjs`.
- **OAuth strips the URL fragment**, so a signed-out person clicking `#/join/<code>` would lose the code. `stashPostAuthDest()` saves it to sessionStorage and `restorePostAuthDest()` puts it back via `history.replaceState` (not by assigning `location.hash`, which would fire a hashchange and race the load already underway). Only our own `#/` routes are eligible, which is what keeps Supabase's `#access_token=…` out of storage. Covered by `tests/client-post-auth.test.mjs`.
- **Supabase links a second provider onto an existing account** when the email matches and is verified — measured on production, not assumed.
- **A chosen display name must survive sign-in.** `ensureUserRow` rewrites the name from provider metadata every time, so `profiles.display_name_customised` gates it: false means the name tracks the provider, true means sign-in leaves it alone. The name is written to **both** `profiles.display_name` and `shelf_users.discord_username`, because the latter is what the app reads and what Discord embeds use.
- **`PATCH` on someone else's row returns 204, not 403.** RLS filters the row out, so zero rows update and PostgREST reports success at updating nothing. Verified as a genuine no-op. Don't read that 204 as either a breach or permission.
- **Librarian is a per-club role.** A librarian is a reader whose `club_members` row for that club has `role = 'librarian'` — both the server check and the client's `amLibrarian` gate read the same table, so they can't disagree. Roles deliberately do **not** live on `shelf_users`: its "update self" policy would let a member self-promote. Bootstrapping the first librarian of a fresh deployment is one insert:
  ```sql
  insert into club_members (club_id, user_id, role)
  values ('8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8', '<auth user id>', 'librarian')
  on conflict (club_id, user_id) do update set role = 'librarian';
  ```

### UI

- **There is no `.btn` class.** The house styles are `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-mini`, `.btn-provider`. `class="btn"` silently renders a default browser button on dark felt.
- **`--card` and `--ink` are both cream.** This is a single dark theme: `--card` (#f6ecd0) is a cream foreground/button colour for use on the dark felt; `--ink` (#ece3cf) is cream text for dark panels. Pairing them as background/colour gives cream on cream. For a light button use `--felt-dark` on `--card`; for a highlighted pill use `--ink` on `--panel-2`.
- **Check a new `var(--x)` is actually defined.** An invalid `var()` invalidates the whole declaration, so a mistyped token means the rule silently does nothing.
- **Look at the page.** All three of the above shipped because CSS was written against tokens and classes that were never verified, on screens that were never opened. `python3 -m http.server` plus the Chrome tools renders the signed-out gate with no credentials, which catches this whole class of thing.

### Process

- **Before any `supabase db push`**: run `scripts/backup.sh` (there are no automatic backups — see Backups) and `scripts/rehearse-migrations.sh <migration>`, which applies it to production inside `BEGIN … ROLLBACK` so a migration that would fail, or would change rows you didn't expect, is caught with nothing committed.
- **`deno check` is the only thing that typechecks the edge functions** — the Supabase deploy pipeline transpiles without checking. It has caught a genuine bug in every batch so far.
- **`type X = ReturnType<typeof createClient>` is wrong** and will fail `deno check`: it resolves supabase-js's generic defaults to `never`/`unknown`, so every helper rejects the real client and `.upsert()` rejects every object literal. Derive the type from a real call instead — each function has a `createServiceClient()` factory for exactly this.
- **Migrations must land before function or frontend deploys.** If a migration changes a constraint an `onConflict` names, deploy the affected functions immediately after `db push` — there's a window where they error otherwise.
- **`schema.sql` is maintained by hand**, not generated. Mirror each new migration into it as a new numbered section; it's the bootstrap document for a fresh project.
- Hand-run rollback scripts live in `supabase/rollback/`, deliberately outside `supabase/migrations/` so `db push` can't apply them.

## Common commands

No build step and nothing to install to run or deploy the app. The toolchain is only for verification and backups:

```bash
brew install node deno          # tests + typechecking
brew install colima docker      # only for pg_dump backups and the local DB
colima start                    # headless Docker VM (colima stop when done)
```

Colima rather than Docker Desktop deliberately: CLI-only, no GUI launch, no licensing step.

```bash
# Typecheck the edge functions — the only thing that does
deno check --no-lock supabase/functions/*/index.ts

# Offline unit tests: the shared wheel/rating/meeting logic, plus client logic
# sliced out of index.html at run time so it tests what actually ships
node --test supabase/functions/_shared/*.test.mjs tests/*.test.mjs

# Serve the frontend locally (nothing to build)
python3 -m http.server        # then open http://localhost:8000/index.html

# Back up production, then dry-run the migration, THEN push. Both are cheap.
scripts/backup.sh
scripts/rehearse-migrations.sh supabase/migrations/<new>.sql
supabase db push

# Deploy edge functions by name. TMPDIR MATTERS: the bundler writes its eszip
# under $TMPDIR from inside a container, and Colima doesn't mount macOS's
# /var/folders default, so the deploy dies with "failed to open eszip: ENOENT".
export TMPDIR=$HOME/tmp && mkdir -p "$TMPDIR"
supabase functions deploy admin-update --no-verify-jwt
supabase functions deploy club-admin --no-verify-jwt
supabase functions deploy set-book --no-verify-jwt
supabase functions deploy set-review --no-verify-jwt
supabase functions deploy post-comment --no-verify-jwt
supabase functions deploy discord-interactions --no-verify-jwt
supabase functions deploy calendar-feed --no-verify-jwt

# Server-side secrets (never in the HTML)
supabase secrets set DISCORD_WEBHOOK_URL='...'   # fallback for clubs with none of their own
supabase secrets set DISCORD_PUBLIC_KEY='...'    # from the Discord app portal

# Local database (see below)
supabase start -x vector
supabase db reset

# Cross-tenant RLS isolation check. Hits the LINKED live project — it needs real
# members to simulate JWTs for — and cleans up the throwaway club it creates.
node --test supabase/tests/rls-isolation.test.mjs
```

**Deploying the frontend:** GitHub Pages serves `index.html` from `main`, so `git push` redeploys it at the domain in `CNAME` (`https://sh3lf.net/`). **Edge-function changes are not deployed by pushing** — run `supabase functions deploy` separately. Pages occasionally stalls in `queued`; `gh api -X POST repos/ajrpugs/the-shelf/pages/builds` unsticks it.

This repo is linked to Supabase project ref `yoobgxxyvcmsianfczam` (`supabase/.temp/linked-project.json`).

## Backups

**There are no automatic backups.** `supabase backups list` reports `pitr_enabled: false` and an empty list. Paying for Pro (which would give PITR) was **considered and declined** — see `docs/multi-tenant-plan.md` §6. The consequence is accepted, not overlooked: the club can lose everything since the last successful `scripts/backup.sh` run.

`scripts/backup.sh` writes to `~/the-shelf-backups/<timestamp>/`:

- **`pg_dump` half** (`schema.sql`, `data.sql`, `roles.sql`) — needs Docker. This is the one that captures DDL, RLS policies, functions, grants, and **`auth.users`/`auth.identities`**, so member ids survive a restore into a fresh project. Skipped with a warning if Docker is down.
- **`restore.sql`** — one query (therefore one consistent transaction) emitting one INSERT per public table, rebuilding rows via `jsonb_populate_recordset` so a later column reorder can't corrupt it. Needs no Docker, and it's the half that gets **verified**: row counts are checked against live and a mismatch exits non-zero.
- The SQL lives in `supabase/backup-sql/`. **If you add a table, add it to both files there** or it silently won't be backed up — the count check only compares tables it's told about.
- Written outside the repo on purpose: it contains `club_secrets`, every member's data, and auth tokens. Keep it out of git and off shared drives.
- **`supabase db query --output-format json` returns a bare array** (`[{...}]`), not `{rows: […]}`. Some wrappers re-wrap it; the parsing accepts both deliberately — don't "simplify" it.

**Scheduled daily at 13:00** via a user LaunchAgent, `net.sh3lf.backup`. Install/refresh with `scripts/install-backup-agent.sh`, remove with `--remove`. Log: `~/the-shelf-backups/backup.log`.

- It runs a **staged copy** under `~/Library/Application Support/the-shelf-backup/`, not the repo. Not tidiness: the repo is in `~/Documents`, which macOS TCC protects, and a LaunchAgent can't read it at all — the job dies with exit 126 / `Operation not permitted` before the first line runs.
- **The staged copy is a snapshot — re-run the installer after editing `scripts/backup.sh` or `supabase/backup-sql/`.**
- It sets `SUPABASE_PROJECT_ID` (there's no `supabase/.temp/` outside the repo) and `TMPDIR=$HOME/tmp`, starts Colima if Docker is down, then stops it again.
- Retention keeps the newest 14, pruning only *after* a run verifies, so a failed run can't evict a good backup.
- Honest limit: it only fires while this Mac is awake and logged in.

## Local database

`supabase start -x vector` then `supabase db reset` gives a local Postgres with the full schema — verified to match production at 12 tables, 22 policies, `is_member`/`is_librarian`. Use it for anything that would otherwise mean creating throwaway rows in a live club.

- **`-x vector` is required with Colima.** The `supabase_vector` container bind-mounts the Docker socket, and Colima's is a forwarded file it can't mount (`operation not supported`). Without the flag, `supabase start` fails *after* applying every migration.
- This works only because of `00000000000000_bootstrap_base_tables.sql`. `supabase/migrations/` was never a complete history — the first real migration does `alter table public.shelf_users`, but nothing created it (the base schema came from pasting `schema.sql` into the SQL editor). The bootstrap migration supplies `shelf_state`/`shelf_users` as they were before that, and is recorded on production as already-applied via `migration repair` rather than run.
- `20260724120000_add_shelf_librarians.sql` seeds a hardcoded **production** user id, now guarded by an `auth.users` lookup — on any other database that FK aborted the whole chain with a 23503. On a fresh local DB you get no librarian; create one with the insert above.
- The local stack ships a mail catcher, so email-shaped flows could be developed locally with no SMTP provider if email auth is ever revisited.
- Local and production complement each other: the local DB proves a migration **applies**, `scripts/rehearse-migrations.sh` proves it applies **to the real data** without changing row counts.

## Secrets & config

- **Public, in the HTML:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` — safe to commit.
- **Server-side only:** `DISCORD_WEBHOOK_URL` (the fallback for clubs with no webhook of their own), `DISCORD_PUBLIC_KEY`. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions automatically.
- **Per-club secrets** live in `club_secrets`, reachable only through `club-admin`.
- **Sign-in providers** are `AUTH_PROVIDERS` in `index.html`. `enabled` is a deploy-time switch, not feature detection: there's no way to ask Supabase whether a provider is configured, and a live-looking button that errors is worse than an absent one. **Email/password accounts are deliberately not offered** — see `docs/multi-tenant-plan.md` §4.

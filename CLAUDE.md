# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"The Shelf" is a tiny book-club picker. Signed-in readers (Discord OAuth) each set one book; a librarian (a reader holding the librarian role) spins a wheel that randomly picks an eligible reader. Picked readers sit out until the round turns over.

There is **no build step and no framework**. The entire frontend is a single `index.html` (~3800 lines) — a vanilla JS ES module that pulls `@supabase/supabase-js` straight from esm.sh and renders everything by hand (including a `<canvas>` spinning wheel). All persistence is Supabase (Postgres + Realtime + Edge Functions).

The club also runs a rubric review system (members score a finished read 1–20 across five categories, averaged into a /100 "Guild score") and per-book comment threads — both layered on top of the same `shelf_state` history entries.

## Architecture

**Frontend (`index.html`)** — one file, everything in one `<script type="module">`:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` are hardcoded constants near the top of the script (anon key is public by design). `CONFIGURED` gates the app when they're placeholders.
- Auth is Discord OAuth via `supabase.auth.signInWithOAuth({ provider: "discord" })`. On sign-in, `ensureUserRow` upserts the reader into `shelf_users`.
- `loadAll` fetches the singleton `shelf_state` row and all `shelf_users`; `subscribeRealtime` listens to `postgres_changes` on both tables and debounces a refresh via `queueRefresh`.
- The whole UI is re-rendered by string-building `render()` (with `esc`/`attr` escaping helpers) after every state change.
- The signed-in main view is **tabbed**: `Reading | The Shelf | The Wheel | Leaderboard | Stats | Reviews | Calendar` plus an `Admin` tab that only exists in librarian mode. The active tab is the module-level `currentTab` (in memory, **not** in the hash) and `render()` appends only that tab's sections. Deep-link hash routes (`#book=`, `#shelf=`, `#tag=`, `#reader=`, `#recap`) still short-circuit `render()` into their own full-page views before the tabs are built.
- `render()` bails early while an `<input>`/`<textarea>` has focus (it defers via `pendingRender`). Any handler that changes state from a button must `document.activeElement?.blur?.()` first — Safari doesn't focus buttons on click, so the re-render would otherwise be silently swallowed.
- Reads go directly to Postgres (RLS allows anon read). **All writes go through Edge Functions** — the client never writes tables directly.
- Book covers are looked up from Open Library (`fetchCoverFromOpenLibrary`) — both client-side for display and server-side for Discord embeds.

**Data model (`supabase/schema.sql`)** — five tables:
- `shelf_state` — a **single row, `id = 1`**, whose `data` jsonb holds the entire game state: `{ eliminated: string[] (user ids), history: HistoryItem[], roundNumber: number }`.
- `shelf_users` — one row per Discord-authed reader: `id` (= `auth.users.id`), `discord_username`, `avatar_url`, `book`, `discord_id`. **The reader's current book lives here** (nullable — null means "off the shelf"). `discord_id` links a web account to a Discord user for the slash command.
- `shelf_reviews` — one rubric review per (read, reader), primary-keyed `(book_ts, user_id)`. Five category scores (`plot`, `characters`, `pacing`, `language`, `themes`), each 1..20, plus an optional `note`. `book_ts` keys to a `shelf_state.history[].ts`. Written via the `set-review` edge function (or bulk-imported by a librarian via `admin_import_reviews`); readers may also insert/update/delete their own row directly under RLS.
- `shelf_comments` — per-book discussion thread, keyed to a read by `book_ts`. Written via the `post-comment` edge function; readers may insert their own and delete their own under RLS.
- `shelf_librarians` — presence of a `user_id` row = librarian (see "Librarian is a role, not a password" below). No write policy at all — reads for authenticated users, writes only through `admin_grant_librarian` / `admin_revoke_librarian`.
- RLS: anyone (anon) can **read** `shelf_state`/`shelf_users`/`shelf_reviews`/`shelf_comments`; signed-in users can read `shelf_librarians`. A reader may insert/update only their own `shelf_users`/`shelf_reviews` row, or insert/delete only their own `shelf_comments` row. `shelf_state` mutations happen only via service-role Edge Functions.

**Edge Functions (`supabase/functions/`)** — Deno, deployed individually:
- `admin-update` — librarian-gated writes to `shelf_state`. Verifies the caller's JWT itself (that's why it deploys `--no-verify-jwt`, same as `set-book`), requires the caller's id to be present in `shelf_librarians` (else 401 no token / 403 not a librarian), then uses the **service role key**. Actions: `draw`, `new_round`, `reset`, `undo_last_spin`, `admin_clear_book`, `admin_set_book`, `admin_set_rating`, `admin_set_ratings_open`, `admin_set_meeting`, `admin_announce_meeting` (re-posts a read's existing dates to Discord without changing them — the no-op guard on `admin_set_meeting` means an identical re-save stays silent, so this is the way to (re)announce), `admin_import_reviews` (bulk-upsert member rubric reviews into `shelf_reviews`, keyed by `book_ts` + `user_id`), `admin_grant_librarian` / `admin_revoke_librarian` (add/remove a `shelf_librarians` row; a librarian can't revoke themselves), `admin_remove_user`. `draw` picks a random reader with a book set who isn't in `eliminated`, and **auto-advances the round** when that pick empties the eligible pool. Fires a Discord webhook after a durable `draw`, again after `admin_set_meeting` when the schedule actually changed, and again after `admin_set_rating` when the committed score actually changed (each of these three no-op guards means an identical re-save stays silent). Meeting times are posted as Discord `<t:unix:F>` markup so each member sees them in their own timezone; the rating post includes the /100 total, its band, and the per-category breakdown when present. All three posts happen **after** the state write and swallow their own errors — a dead webhook must never fail the librarian's action.
- `set-book` — a signed-in reader sets/clears their own book. Verifies the JWT itself (pulls the user id out), then writes with the service role and posts to Discord. Deployed `--no-verify-jwt` for its own error handling.
- `discord-interactions` — receives Discord slash-command webhooks (`/mybook`). **Must** verify Discord's Ed25519 signature (`DISCORD_PUBLIC_KEY`) or Discord rejects the endpoint. Looks the reader up by `discord_id`, sets their book, and posts the same Discord embed `set-book` would.
- `set-review` — a signed-in reader submits (or clears) their own rubric review for the *current* read. Verifies the JWT itself. Only accepted while the read is the oldest unrated history entry **and** the librarian has `ratingsOpen` on it (`admin_set_ratings_open`); clearing (`clear: true`) is allowed anytime and just deletes the caller's own `shelf_reviews` row. Deployed `--no-verify-jwt`, same pattern as `set-book`.
- `post-comment` — a signed-in reader posts (or deletes their own) comment on a book's discussion thread, keyed by history `ts`. Verifies the JWT itself. Deployed `--no-verify-jwt`.
- `calendar-feed` — public, read-only **iCalendar (`.ics`) feed** of the club's meetings, built from `shelf_state`. Emits one `VEVENT` per scheduled 50%/100% meeting. Deployed `--no-verify-jwt` because calendar clients (Google/Apple/Outlook) can't send a Supabase apikey. Members subscribe to this URL once and it stays in sync. `GET` only.

`admin-update`, `set-book`, and `discord-interactions` each carry their own copy of the Open Library cover lookup + Discord embed helpers (`normalizeForMatch`, `parseTitleAuthor`, `fetchCover`, `postBookSet`) — those three (and only those three) post to Discord. If you change cover-matching or embed formatting, **change it in all three copies**. `set-review` and `post-comment` don't touch Discord at all.

### State-shape gotchas
- `shelf_state.data` is the single source of truth for game state and is edited as a whole object, not per-field — read it, mutate the object, upsert it back.
- `eliminated` and `history[].winner_id` hold **user ids** (uuid), not names. Older name-based entries are tolerated by `normalizeState`, which also maps legacy `cycle`/`cycleNumber` → `round`/`roundNumber`.
- **`normalizeState` exists in two places** (`index.html` and `admin-update`) and both rebuild each history item field-by-field. Any new per-read field (`ratingsOpen`, `meetings`, …) **must be added to both copies** or it gets silently wiped on the next admin action.
- Meetings live on the history item: `history[].meetings = { half: { at, upTo }, full: { at } }`. `at` is an **ISO instant**. `upTo` (the "read up to Chapter 12" checkpoint) exists only on `half`.
- **Meeting times are pinned to `America/Toronto` (`CLUB_TZ`), not the browser's zone** — the club meets Wednesdays 8pm ET, and that must read the same for a librarian or member in any timezone. `clubWallToInstant` / `toClubInputValue` convert between Toronto wall-clock and UTC instants via `Intl.DateTimeFormat`, so DST (EST↔EDT) is handled; never use bare `new Date("...T20:00")` on a `datetime-local` value, and never let the edge function parse one (its local time is UTC, so it would read `T20:00` as 8pm UTC).
- `undo_last_spin` has to detect whether the undone pick had auto-advanced the round and roll `roundNumber` back accordingly.
- The **"current read"** for reviewing purposes is the oldest `history` entry without a committed `rating` — i.e. `history` is newest-first, so it's the last unrated item, not `history[0]`. Both `set-review` and the client compute it the same way; a member can only submit a review against that entry, and only once the librarian has flipped `ratingsOpen` on it via `admin_set_ratings_open`.

## Common commands

No install, no tests, no linter — it's a static file plus Deno functions.

```bash
# Run the frontend locally (nothing to build — Supabase is the backend)
python3 -m http.server        # then open http://localhost:8000/index.html

# Deploy an edge function (each is deployed by name; --no-verify-jwt is required)
supabase functions deploy admin-update --no-verify-jwt
supabase functions deploy set-book --no-verify-jwt
supabase functions deploy discord-interactions --no-verify-jwt
supabase functions deploy set-review --no-verify-jwt
supabase functions deploy post-comment --no-verify-jwt
supabase functions deploy calendar-feed --no-verify-jwt

# Manage server-side secrets (never in the HTML)
supabase secrets set DISCORD_WEBHOOK_URL='...'
supabase secrets set DISCORD_PUBLIC_KEY='...'      # from the Discord app portal

# Apply schema / migrations
supabase db push
```

**Deploying the frontend:** GitHub Pages serves `index.html` from `main`. A `git push` to `main` redeploys it, live at the custom domain in `CNAME` — **`https://sh3lf.net/`** — which GitHub Pages fronts. Edge-function changes are **not** deployed by pushing — you must run `supabase functions deploy` separately.

This repo is linked to Supabase project ref `yoobgxxyvcmsianfczam` (`supabase/.temp/linked-project.json`).

## Secrets & config

- **Public / in the HTML:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` — safe to commit.
- **Server-side only (Supabase secrets):** `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions automatically.
- **Librarian is a role, not a password.** A librarian is any reader whose id has a row in `shelf_librarians` (presence = librarian). `admin-update` verifies the caller's JWT and checks that table; the client mirrors it via `amLibrarian` (loaded from `shelf_librarians` on sign-in) to gate the Admin tab + controls. Signed-in users can **read** the librarian list (the Admin tab shows each reader's status and offers grant/revoke), but the table has no write policy, so grants/revokes only happen through the `admin_grant_librarian` / `admin_revoke_librarian` edge-function actions. Roles deliberately do **not** live on `shelf_users` (its "update self" policy would let a member self-promote) — `shelf_librarians` has no write policy, so grants/revokes are service-role only. Grant a librarian with an `insert into shelf_librarians (user_id) values ('<auth user id>')`.

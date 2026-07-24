# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"The Shelf" is a tiny book-club picker. Signed-in readers (Discord OAuth) each set one book; a librarian (a reader holding the librarian role) spins a wheel that randomly picks an eligible reader. Picked readers sit out until the round turns over.

There is **no build step and no framework**. The entire frontend is a single `index.html` (~1500 lines) — a vanilla JS ES module that pulls `@supabase/supabase-js` straight from esm.sh and renders everything by hand (including a `<canvas>` spinning wheel). All persistence is Supabase (Postgres + Realtime + Edge Functions).

> **README drift:** `README.md` still describes an older "honor system, type-your-name, no login" flow with a `shelf_submissions` table. That is stale. The code has since moved to Discord OAuth accounts where the book lives on `shelf_users`, and `shelf_submissions` is dropped by the schema. **Trust the code over the README** when they disagree.

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

**Data model (`supabase/schema.sql`)** — two tables:
- `shelf_state` — a **single row, `id = 1`**, whose `data` jsonb holds the entire game state: `{ eliminated: string[] (user ids), history: HistoryItem[], roundNumber: number }`.
- `shelf_users` — one row per Discord-authed reader: `id` (= `auth.users.id`), `discord_username`, `avatar_url`, `book`, `discord_id`. **The reader's current book lives here** (nullable — null means "off the shelf"). `discord_id` links a web account to a Discord user for the slash command.
- RLS: anyone (anon) can **read** both tables; a reader may insert/update only their own `shelf_users` row. State mutations happen only via service-role Edge Functions.

**Edge Functions (`supabase/functions/`)** — Deno, deployed individually:
- `admin-update` — librarian-gated writes to `shelf_state`. Verifies the caller's JWT itself (that's why it deploys `--no-verify-jwt`, same as `set-book`), requires the caller's id to be present in `shelf_librarians` (else 401 no token / 403 not a librarian), then uses the **service role key**. Actions: `draw`, `new_round`, `reset`, `undo_last_spin`, `admin_clear_book`, `admin_set_book`, `admin_set_rating`, `admin_set_ratings_open`, `admin_set_meeting`, `admin_announce_meeting` (re-posts a read's existing dates to Discord without changing them — the no-op guard on `admin_set_meeting` means an identical re-save stays silent, so this is the way to (re)announce), `admin_import_reviews` (bulk-upsert member rubric reviews into `shelf_reviews`, keyed by `book_ts` + `user_id`), `admin_remove_user`. `draw` picks a random reader with a book set who isn't in `eliminated`, and **auto-advances the round** when that pick empties the eligible pool. Fires a Discord webhook after a durable `draw`, and again after `admin_set_meeting` when the schedule actually changed (a no-op Save stays silent). Meeting times are posted as Discord `<t:unix:F>` markup so each member sees them in their own timezone. Both posts happen **after** the state write and swallow their own errors — a dead webhook must never fail the librarian's action.
- `set-book` — a signed-in reader sets/clears their own book. Verifies the JWT itself (pulls the user id out), then writes with the service role and posts to Discord. Deployed `--no-verify-jwt` for its own error handling.
- `discord-interactions` — receives Discord slash-command webhooks (`/mybook`). **Must** verify Discord's Ed25519 signature (`DISCORD_PUBLIC_KEY`) or Discord rejects the endpoint. Looks the reader up by `discord_id`.

- `calendar-feed` — public, read-only **iCalendar (`.ics`) feed** of the club's meetings, built from `shelf_state`. Emits one `VEVENT` per scheduled 50%/100% meeting. Deployed `--no-verify-jwt` because calendar clients (Google/Apple/Outlook) can't send a Supabase apikey. Members subscribe to this URL once and it stays in sync. `GET` only.

The three write-path functions each carry their own copy of the Open Library cover lookup + Discord embed helpers (`normalizeForMatch`, `parseTitleAuthor`, `fetchCover`, `postBookSet`). If you change cover-matching or embed formatting, **change it in all copies**.

### State-shape gotchas
- `shelf_state.data` is the single source of truth for game state and is edited as a whole object, not per-field — read it, mutate the object, upsert it back.
- `eliminated` and `history[].winner_id` hold **user ids** (uuid), not names. Older name-based entries are tolerated by `normalizeState`, which also maps legacy `cycle`/`cycleNumber` → `round`/`roundNumber`.
- **`normalizeState` exists in two places** (`index.html` and `admin-update`) and both rebuild each history item field-by-field. Any new per-read field (`ratingsOpen`, `meetings`, …) **must be added to both copies** or it gets silently wiped on the next admin action.
- Meetings live on the history item: `history[].meetings = { half: { at, upTo }, full: { at } }`. `at` is an **ISO instant**. `upTo` (the "read up to Chapter 12" checkpoint) exists only on `half`.
- **Meeting times are pinned to `America/Toronto` (`CLUB_TZ`), not the browser's zone** — the club meets Wednesdays 8pm ET, and that must read the same for a librarian or member in any timezone. `clubWallToInstant` / `toClubInputValue` convert between Toronto wall-clock and UTC instants via `Intl.DateTimeFormat`, so DST (EST↔EDT) is handled; never use bare `new Date("...T20:00")` on a `datetime-local` value, and never let the edge function parse one (its local time is UTC, so it would read `T20:00` as 8pm UTC).
- `undo_last_spin` has to detect whether the undone pick had auto-advanced the round and roll `roundNumber` back accordingly.

## Common commands

No install, no tests, no linter — it's a static file plus Deno functions.

```bash
# Run the frontend locally (nothing to build — Supabase is the backend)
python3 -m http.server        # then open http://localhost:8000/index.html

# Deploy an edge function (each is deployed by name; --no-verify-jwt is required)
supabase functions deploy admin-update --no-verify-jwt
supabase functions deploy set-book --no-verify-jwt
supabase functions deploy discord-interactions --no-verify-jwt
supabase functions deploy calendar-feed --no-verify-jwt

# Manage server-side secrets (never in the HTML)
supabase secrets set DISCORD_WEBHOOK_URL='...'
supabase secrets set DISCORD_PUBLIC_KEY='...'      # from the Discord app portal

# Apply schema / migrations
supabase db push
```

**Deploying the frontend:** GitHub Pages serves `index.html` from `main`. A `git push` to `main` redeploys it (live at `https://ajrpugs.github.io/the-shelf/`). Edge-function changes are **not** deployed by pushing — you must run `supabase functions deploy` separately.

This repo is linked to Supabase project ref `yoobgxxyvcmsianfczam` (`supabase/.temp/linked-project.json`).

## Secrets & config

- **Public / in the HTML:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` — safe to commit.
- **Server-side only (Supabase secrets):** `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions automatically.
- **Librarian is a role, not a password.** A librarian is any reader whose id has a row in `shelf_librarians` (presence = librarian). `admin-update` verifies the caller's JWT and checks that table; the client mirrors it via `amLibrarian` (own-row read of `shelf_librarians`, set on sign-in) to gate the Admin tab + controls. Roles deliberately do **not** live on `shelf_users` (its "update self" policy would let a member self-promote) — `shelf_librarians` has no write policy, so grants/revokes are service-role only. Grant a librarian with an `insert into shelf_librarians (user_id) values ('<auth user id>')`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"The Shelf" is a tiny book-club picker. Signed-in readers (Discord OAuth) each set one book; a password-holding librarian spins a wheel that randomly picks an eligible reader. Picked readers sit out until the round turns over.

There is **no build step and no framework**. The entire frontend is a single `index.html` (~1500 lines) — a vanilla JS ES module that pulls `@supabase/supabase-js` straight from esm.sh and renders everything by hand (including a `<canvas>` spinning wheel). All persistence is Supabase (Postgres + Realtime + Edge Functions).

> **README drift:** `README.md` still describes an older "honor system, type-your-name, no login" flow with a `shelf_submissions` table. That is stale. The code has since moved to Discord OAuth accounts where the book lives on `shelf_users`, and `shelf_submissions` is dropped by the schema. **Trust the code over the README** when they disagree.

## Architecture

**Frontend (`index.html`)** — one file, everything in one `<script type="module">`:
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` are hardcoded constants near the top of the script (anon key is public by design). `CONFIGURED` gates the app when they're placeholders.
- Auth is Discord OAuth via `supabase.auth.signInWithOAuth({ provider: "discord" })`. On sign-in, `ensureUserRow` upserts the reader into `shelf_users`.
- `loadAll` fetches the singleton `shelf_state` row and all `shelf_users`; `subscribeRealtime` listens to `postgres_changes` on both tables and debounces a refresh via `queueRefresh`.
- The whole UI is re-rendered by string-building `render()` (with `esc`/`attr` escaping helpers) after every state change.
- Reads go directly to Postgres (RLS allows anon read). **All writes go through Edge Functions** — the client never writes tables directly.
- Book covers are looked up from Open Library (`fetchCoverFromOpenLibrary`) — both client-side for display and server-side for Discord embeds.

**Data model (`supabase/schema.sql`)** — two tables:
- `shelf_state` — a **single row, `id = 1`**, whose `data` jsonb holds the entire game state: `{ eliminated: string[] (user ids), history: HistoryItem[], roundNumber: number }`.
- `shelf_users` — one row per Discord-authed reader: `id` (= `auth.users.id`), `discord_username`, `avatar_url`, `book`, `discord_id`. **The reader's current book lives here** (nullable — null means "off the shelf"). `discord_id` links a web account to a Discord user for the slash command.
- RLS: anyone (anon) can **read** both tables; a reader may insert/update only their own `shelf_users` row. State mutations happen only via service-role Edge Functions.

**Edge Functions (`supabase/functions/`)** — Deno, deployed individually:
- `admin-update` — password-gated writes to `shelf_state`. Checks `body.password === ADMIN_PASSWORD` (that's why it deploys `--no-verify-jwt`), then uses the **service role key**. Actions: `draw`, `new_round`, `reset`, `undo_last_spin`, `admin_clear_book`, `admin_remove_user`. `draw` picks a random reader with a book set who isn't in `eliminated`, and **auto-advances the round** when that pick empties the eligible pool. Fires a Discord webhook after a durable draw.
- `set-book` — a signed-in reader sets/clears their own book. Verifies the JWT itself (pulls the user id out), then writes with the service role and posts to Discord. Deployed `--no-verify-jwt` for its own error handling.
- `discord-interactions` — receives Discord slash-command webhooks (`/mybook`). **Must** verify Discord's Ed25519 signature (`DISCORD_PUBLIC_KEY`) or Discord rejects the endpoint. Looks the reader up by `discord_id`.

The three functions each carry their own copy of the Open Library cover lookup + Discord embed helpers (`normalizeForMatch`, `parseTitleAuthor`, `fetchCover`, `postBookSet`). If you change cover-matching or embed formatting, **change it in all copies**.

### State-shape gotchas
- `shelf_state.data` is the single source of truth for game state and is edited as a whole object, not per-field — read it, mutate the object, upsert it back.
- `eliminated` and `history[].winner_id` hold **user ids** (uuid), not names. Older name-based entries are tolerated by `normalizeState`, which also maps legacy `cycle`/`cycleNumber` → `round`/`roundNumber`.
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

# Manage server-side secrets (never in the HTML)
supabase secrets set ADMIN_PASSWORD='...'
supabase secrets set DISCORD_WEBHOOK_URL='...'
supabase secrets set DISCORD_PUBLIC_KEY='...'      # from the Discord app portal

# Apply schema / migrations
supabase db push
```

**Deploying the frontend:** GitHub Pages serves `index.html` from `main`. A `git push` to `main` redeploys it (live at `https://ajrpugs.github.io/the-shelf/`). Edge-function changes are **not** deployed by pushing — you must run `supabase functions deploy` separately.

This repo is linked to Supabase project ref `yoobgxxyvcmsianfczam` (`supabase/.temp/linked-project.json`).

## Secrets & config

- **Public / in the HTML:** `SUPABASE_URL`, `SUPABASE_ANON_KEY` — safe to commit.
- **Server-side only (Supabase secrets):** `ADMIN_PASSWORD`, `DISCORD_WEBHOOK_URL`, `DISCORD_PUBLIC_KEY`. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected into functions automatically.
- The librarian password lives only in `ADMIN_PASSWORD`; the browser holds it in `sessionStorage` while unlocked and sends it with each admin call. Rotate by re-setting the secret (no redeploy of the function needed).

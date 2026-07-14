# The Shelf

A tiny book-club picker with a library-ledger vibe. Readers sign in with Discord and each set one book; a designated librarian spins the wheel to pick one at random. Once you're picked, you sit out until the round turns over.

Single-page HTML frontend + Supabase backend (Postgres + Realtime + Edge Functions), with optional Discord integration (webhook posts + a `/mybook` slash command). Free tier is more than enough for a book club.

## How it works

- **Any reader** (signed in with Discord) can:
  - Set or change their one book — from the web app, or with the `/mybook <title>` slash command in Discord.
  - Clear their book to take themselves off the shelf.
  - See who's on the shelf, who's already been picked this round, past reads, and stats.
- **Anyone with the link** (no login) can read the current state — who's on the shelf, past reads, and stats.
- **Only the librarian** (whoever has the password) can:
  - Spin the wheel — the server picks randomly from readers who have a book set and haven't been picked yet this round.
  - Start a new round (puts everyone back in the pool).
  - Undo the last spin, clear a reader's book, or remove a reader.
  - Reset the whole shelf (wipes every book).

There is no explicit roster — the pool is whoever has a book set. Once you're picked, you sit out until the pool empties (the round auto-advances) or the librarian starts a new round manually.

Each reader's book lives on their account (`shelf_users`), so it persists across rounds until they change it. When the librarian sets a book, updates one, or the wheel picks a winner, an embed is posted to the configured Discord channel.

## Setup

### 1. Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql). This creates the two tables (`shelf_state` and `shelf_users`), their RLS policies, and hooks them into realtime.

### 2. Discord OAuth (sign-in)

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and grab its **Client ID** and **Client Secret**.
2. In the Discord app's **OAuth2** settings, add the redirect URL Supabase gives you (Supabase dashboard → **Authentication → Providers → Discord**).
3. In Supabase, enable the **Discord** provider and paste in the Client ID / Secret.
4. Add your site's URL (e.g. `https://<you>.github.io/the-shelf/`) to Supabase's **Authentication → URL Configuration** allow-list so the OAuth redirect is accepted.

### 3. Edge functions

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), then link this repo to your project and set secrets:

```bash
supabase link --project-ref <your-project-ref>
supabase secrets set ADMIN_PASSWORD='pick-a-good-one'

# Deploy all three functions (each needs --no-verify-jwt)
supabase functions deploy admin-update --no-verify-jwt
supabase functions deploy set-book --no-verify-jwt
supabase functions deploy discord-interactions --no-verify-jwt
```

`--no-verify-jwt` matters: these functions are called with the anon key from the browser (or, for `discord-interactions`, directly by Discord). Each does its own auth check — `admin-update` verifies the password, `set-book` verifies the reader's JWT itself, and `discord-interactions` verifies Discord's request signature.

- **`admin-update`** — password-gated librarian actions (draw, new round, undo, reset, manage readers).
- **`set-book`** — lets a signed-in reader set/clear their own book from the web app.
- **`discord-interactions`** — backs the `/mybook` slash command (optional; see below).

### 4. Discord posts & slash command (optional)

- **Channel posts:** create a Discord channel webhook and set it so the functions can announce picks and book changes. The URL stays server-side:
  ```bash
  supabase secrets set DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
  ```
- **`/mybook` slash command:** register a `mybook` command (with a `title` string option) on your Discord app, point its **Interactions Endpoint URL** at the deployed `discord-interactions` function, and set the app's public key so requests can be verified:
  ```bash
  supabase secrets set DISCORD_PUBLIC_KEY='<from the Discord app portal>'
  ```
  Readers must sign in on the web once first so their Discord account is linked (`discord_id` on `shelf_users`).

### 5. Frontend

Edit `index.html` and replace the two placeholders near the top of the `<script>`:

```js
const SUPABASE_URL = "https://<your-project-ref>.supabase.co";
const SUPABASE_ANON_KEY = "<your-anon-public-key>";
```

Both values are safe to expose in the browser — that's what the anon key is for. The admin password is only used server-side and never appears in the HTML.

Then commit and push. GitHub Pages will redeploy automatically:

```bash
git add index.html
git commit -m "Configure Supabase"
git push
```

## Local dev

Just open `index.html` in a browser (or serve it with any static server — `python3 -m http.server`, `npx serve`, etc.). Because Supabase is doing all the persistence, there's nothing to run locally.

## Security notes

- The anon key + RLS mean anyone with the URL can **read** state. That's intentional.
- Writes are locked down: readers can only insert/update their own `shelf_users` row (enforced by RLS against their Discord-authed user id), and all game-state changes go through the `admin-update` edge function. The client never writes `shelf_state` directly.
- Admin actions funnel through `admin-update`, which checks the password server-side against the `ADMIN_PASSWORD` secret. The password never appears in the HTML — it's held in `sessionStorage` while the librarian is active (cleared when they lock) and sent with each admin call.
- If the password leaks, rotate it with `supabase secrets set ADMIN_PASSWORD='new-value'` (no redeploy needed).
- `discord-interactions` verifies Discord's Ed25519 request signature against `DISCORD_PUBLIC_KEY`, so only genuine Discord requests are honored.

## Data & backups

The Supabase dashboard has a full backup + SQL export. Game state (eliminated readers, history, round number) is a single JSON blob — `select data from shelf_state where id = 1;` — and readers plus their current books live in `select * from shelf_users;`.

## License

MIT.

# The Shelf

A tiny book-club picker with a library-ledger vibe. Readers sign in with Discord and each set one book; a librarian spins the wheel to pick one at random. Once you're picked, you sit out until the round turns over.

Single-page HTML frontend + Supabase backend (Postgres + Realtime + Edge Functions), with optional Discord integration (webhook posts + a `/mybook` slash command). Free tier is more than enough for a book club.

## How it works

- **Any reader** (signed in with Discord) can:
  - Set or change their one book — from the web app, or with the `/mybook <title>` slash command in Discord.
  - Clear their book to take themselves off the shelf.
  - See who's on the shelf, who's already been picked this round, past reads, and stats.
  - Once a read finishes, submit a rubric review (five categories, 1–20 each) while the librarian has ratings open for it, and post comments on its discussion thread.
- **Anyone with the link** (no login) can read the current state — who's on the shelf, past reads, ratings, and stats.
- **Only a librarian** (a reader holding the librarian role — see below) can:
  - Spin the wheel — the server picks randomly from readers who have a book set and haven't been picked yet this round.
  - Start a new round (puts everyone back in the pool).
  - Undo the last spin, clear or edit a reader's book, or remove a reader.
  - Reset the whole shelf (wipes every book).
  - Set/clear a read's Guild score, open or close member reviews for it, bulk-import reviews, and schedule (or re-announce) its 50%/100% discussion meetings.
  - Grant or revoke the librarian role for other readers.

There is no explicit roster — the pool is whoever has a book set. Once you're picked, you sit out until the pool empties (the round auto-advances) or the librarian starts a new round manually.

Each reader's book lives on their account (`shelf_users`), so it persists across rounds until they change it. When a book is set/changed, the wheel picks a winner, a read's discussion dates change, or a read gets a committed score, an embed is posted to the configured Discord channel.

The app is organized into tabs: **Reading** (what's currently being read / up next), **The Shelf** (set your book, see who's in the pool), **The Wheel** (spin to pick), **Leaderboard** (finished reads ranked by Guild score), **Stats** (club-wide numbers), **Reviews** (rubric reviews + reviewer superlatives + a "Year in books" recap), **Calendar** (upcoming meetings + a subscribable `.ics` feed), and — for librarians only — **Admin** (spin controls, reader management, danger zone).

## Setup

### 1. Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql). This creates all five tables (`shelf_state`, `shelf_users`, `shelf_reviews`, `shelf_comments`, `shelf_librarians`), their RLS policies, and hooks the first four into realtime.

### 2. Discord OAuth (sign-in)

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and grab its **Client ID** and **Client Secret**.
2. In the Discord app's **OAuth2** settings, add the redirect URL Supabase gives you (Supabase dashboard → **Authentication → Providers → Discord**).
3. In Supabase, enable the **Discord** provider and paste in the Client ID / Secret.
4. Add your site's URL (e.g. `https://<you>.github.io/the-shelf/`, or your own custom domain) to Supabase's **Authentication → URL Configuration** allow-list so the OAuth redirect is accepted.

### 3. Edge functions

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), then link this repo to your project:

```bash
supabase link --project-ref <your-project-ref>

# Deploy all six functions (each needs --no-verify-jwt — every one of them
# verifies the caller itself instead of relying on Supabase's built-in check)
supabase functions deploy admin-update --no-verify-jwt
supabase functions deploy set-book --no-verify-jwt
supabase functions deploy discord-interactions --no-verify-jwt
supabase functions deploy set-review --no-verify-jwt
supabase functions deploy post-comment --no-verify-jwt
supabase functions deploy calendar-feed --no-verify-jwt
```

`--no-verify-jwt` matters: these functions are called with the anon key from the browser (or, for `discord-interactions`, directly by Discord; or, for `calendar-feed`, directly by a calendar client with no auth header at all). Each does its own auth check.

- **`admin-update`** — librarian-gated actions: draw the wheel, new round, undo, reset, manage readers, set/clear a read's score, open/close member reviews, bulk-import reviews, schedule meetings, grant/revoke the librarian role.
- **`set-book`** — lets a signed-in reader set/clear their own book from the web app.
- **`discord-interactions`** — backs the `/mybook` slash command (optional; see below).
- **`set-review`** — lets a signed-in reader submit or clear their own rubric review of the current read.
- **`post-comment`** — lets a signed-in reader post or delete their own comment on a book's discussion thread.
- **`calendar-feed`** — public, read-only `.ics` feed of scheduled meetings, for subscribing in Google/Apple/Outlook calendars.

### 4. Discord posts & slash command (optional)

- **Channel posts:** create a Discord channel webhook and set it so the functions can announce picks, book changes, meeting schedules, and new scores. The URL stays server-side:
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

Both values are safe to expose in the browser — that's what the anon key is for.

Then commit and push. GitHub Pages will redeploy automatically:

```bash
git add index.html
git commit -m "Configure Supabase"
git push
```

If you're serving from a custom domain (this repo's live instance is `sh3lf.net`, set via the `CNAME` file), point your DNS at GitHub Pages and update `CNAME` to match; otherwise delete `CNAME` and use the default `https://<you>.github.io/the-shelf/`.

### 6. Make your first librarian

There's no signup flow for this — insert a row directly once you have a real `auth.users` id (sign in once first, then find your id in the Supabase dashboard's **Authentication → Users**, or `select id from auth.users;`):

```sql
insert into shelf_librarians (user_id) values ('<your auth user id>');
```

After that, librarians can grant/revoke the role for other readers from the **Admin** tab — no more SQL needed.

## Local dev

Just open `index.html` in a browser (or serve it with any static server — `python3 -m http.server`, `npx serve`, etc.). Because Supabase is doing all the persistence, there's nothing to run locally.

## Security notes

- The anon key + RLS mean anyone with the URL can **read** state (including reviews and comments). That's intentional.
- Writes are locked down by RLS: readers can only insert/update their own `shelf_users` row, insert/update/delete their own `shelf_reviews` row, and insert/delete their own `shelf_comments` row. All game-state changes (`shelf_state`) go through the `admin-update` edge function — the client never writes it directly.
- **Librarian is a role, not a password.** A librarian is any reader whose id has a row in `shelf_librarians`. That table has no write policy at all — grants and revokes only happen through the service-role `admin_grant_librarian` / `admin_revoke_librarian` edge-function actions, gated on the caller already being a librarian. A librarian can't revoke themselves (so the club can never end up with zero librarians via self-service).
- `admin-update`, `set-review`, and `post-comment` each verify the caller's Supabase JWT themselves (rather than relying on the platform's built-in verification), which is why they're deployed with `--no-verify-jwt`.
- `discord-interactions` verifies Discord's Ed25519 request signature against `DISCORD_PUBLIC_KEY`, so only genuine Discord requests are honored.

## Data & backups

The Supabase dashboard has a full backup + SQL export.

- Game state (eliminated readers, history, round number, ratings, meeting schedules) is a single JSON blob: `select data from shelf_state where id = 1;`
- Readers plus their current books: `select * from shelf_users;`
- Member rubric reviews: `select * from shelf_reviews;`
- Book discussion comments: `select * from shelf_comments;`
- Who holds the librarian role: `select * from shelf_librarians;`

## License

MIT.

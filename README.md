# The Shelf

A tiny book-club picker with a library-ledger vibe. Everyone can submit their book recommendation; a designated librarian draws the card. Once you're picked, you sit out until the cycle turns over.

Single-page HTML frontend + Supabase backend (Postgres + Realtime + one Edge Function). Free tier is more than enough for a book club.

## How it works

- **Anyone with the link** can:
  - Type their name and a book title into the form to drop a recommendation in the draw box. (Honor system — no login.)
  - See current submissions, who's already been picked this cycle, the ledger, and stats.
  - Update their own pick by re-submitting under the same name.
  - Withdraw a submission.
- **Only the librarian** (whoever has the password) can:
  - Draw a card (the server picks randomly from the box, minus anyone already picked this cycle).
  - Start a new cycle (empties the box, puts everyone back in the pool).
  - Reset the whole shelf.

There is no explicit roster — the roster is implicit in who submits. Once you're picked, you sit out until the librarian starts a new cycle.

## Setup

### 1. Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the **SQL editor** and run [`supabase/schema.sql`](supabase/schema.sql). This creates the two tables, RLS policies, and hooks them into realtime.

### 2. Edge function (the admin gate)

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in (`supabase login`), then link this repo to your project:

```bash
supabase link --project-ref <your-project-ref>
supabase secrets set ADMIN_PASSWORD='pick-a-good-one'
supabase functions deploy admin-update --no-verify-jwt
```

`--no-verify-jwt` is important: the function is called with the anon key from the browser, so it does its own password check instead of relying on Supabase Auth.

### 3. Frontend

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

- The anon key + RLS mean anyone with the URL can read state and submit book recommendations. That's intentional.
- Admin actions all funnel through the edge function, which checks the password server-side against the `ADMIN_PASSWORD` secret. The password never touches the browser JS at rest, and it's stored in `sessionStorage` while the librarian is active (cleared when they lock).
- If the password leaks, rotate it with `supabase secrets set ADMIN_PASSWORD='new-value'` and redeploy.

## Data & backups

The Supabase dashboard has a full backup + SQL export. You can also just `select data from shelf_state where id = 1;` to grab the whole state as JSON.

## License

MIT.

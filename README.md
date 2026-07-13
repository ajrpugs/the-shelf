# The Shelf

A tiny, standalone book club picker. Weighted lottery (no-repeat) draws pick who chooses the next book, with a genre cooldown so the group doesn't end up reading three thrillers in a row.

Single HTML file. No build step. No backend. Data lives in your browser's `localStorage`.

## The rules

- **No-repeat draws.** Once a member is picked, they're out of the pool until everyone else has had a turn. Cycle resets automatically when the pool empties.
- **Attendance-aware.** Toggle who's showing up before you draw — only attending members are eligible.
- **Genre cooldown.** The last N genres are off-limits for the next pick (configurable; defaults to 2).
- **Sanity checks.** Case-insensitive duplicate-name blocking; duplicate book-title warning against past history; "submitted by" name has to match the picker before a round can close.
- **Full history.** Every past pick is logged with picker, title, author, genre, and date.

## Running it

Just open `index.html` in a browser. That's it.

## Hosting it for free

The easiest option is **GitHub Pages**:

1. Push this repo to GitHub (already done if you're reading this on the repo page).
2. Go to **Settings → Pages**.
3. Under **Source**, pick the `main` branch, `/root` folder.
4. Save. In a minute you'll have a URL like `https://<your-user>.github.io/the-shelf/`.

Alternatives that all work with zero config:
- **Netlify Drop** — drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop).
- **Vercel** — import the GitHub repo, no configuration needed.
- **Cloudflare Pages** — same idea, generous free tier.

## Data & backups

- Everything is stored locally in the browser under the key `the-shelf:v1`.
- Use **Settings → Export JSON** to save a backup, and **Import JSON** to restore or share state.
- No account, no cloud. If two people load the site on different browsers, they each get their own copy — one person should be the source of truth (or you upgrade to a real database, see below).

## If you want shared multi-user state

The localStorage design keeps things simple but means each browser has its own copy. To make it collaborative, swap the `load()` / `save()` functions for a hosted store. Good free options:

- **Supabase** — Postgres + JS client. Create a `shelf_state` table with a single JSON blob row, then replace `load`/`save` with `supabase.from('shelf_state').select()` / `.upsert()`.
- **Firebase** — same idea with Firestore.
- **JSONBin.io** — dead simple hosted JSON if you don't want a DB.

Roll your own auth if impersonation matters, otherwise the honor system is fine for small trusted book clubs.

## License

MIT.

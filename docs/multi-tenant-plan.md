# The Shelf — architecture decisions

**This was a plan; it is now a record.** The multi-tenant work is complete and live: anyone can sign up, create a private book club, invite readers, and run the wheel/meetings/reviews flow independently of every other club — free, on `sh3lf.net`.

`CLAUDE.md` is the reference for *how the thing works*. This document exists for the other half: **what was decided and why**, and **what was deliberately not built**. Read it before proposing email/password auth, paid backups, a frontend rewrite, or changing `reads.ts` — each of those was considered and answered.

Migrations reference this file by name in their header comments, which is why the filename hasn't changed.

---

## 1. What it is now

| Concern | How it works |
|---|---|
| Hosting | GitHub Pages, `main` branch, custom domain via `CNAME` |
| Routing | Hash-based: `#/c/<slug>/<tab>`, plus `#/new`, `#/join/<code>`, `#/account` |
| Auth | Discord and Google OAuth. No passwords |
| Clubs | `clubs` + `club_members`; a club owns its name, tagline, timezone, visibility, Discord webhook and calendar token |
| Joining | An invite code, or creating a club (which makes you its librarian). Signing in joins you to nothing |
| Librarian | `club_members.role = 'librarian'`, per club |
| Reads/writes | Every query scoped by `club_id`; writes go through edge functions that re-authorize against the club named in the request |
| Isolation | RLS: `is_member(club_id) or clubs.visibility = 'public'`, verified by `supabase/tests/rls-isolation.test.mjs` |

## 2. Decisions

### Hash routing, staying on GitHub Pages
GitHub Pages serves static files only — it can't say "serve `index.html` for any path", so a refresh on a real `/c/<slug>` path would 404. Cloudflare/Netlify/Vercel would fix that with one redirect rule, but for a free, friends-scale product the migration wasn't worth cosmetically cleaner URLs. Hash routing needs zero hosting changes, since Pages never sees anything after the `#`.

**Accepted cost:** no server-side redirects, and link-preview bots get no real path to read. Neither matters here.

### `reads.ts` stays `text`
It's the join key for `shelf_reviews.book_ts` and `shelf_comments.book_ts`, compared by exact string match against the client's `toISOString()` output. The original plan was to replace it with a real `read_id` UUID foreign key; that is **off the table** — PostgREST re-serializes `timestamptz` differently (`+00:00` vs `Z`), which would silently break every review and comment join. Cross-club uniqueness was solved by scoping the constraints to `(club_id, ts)` instead.

### Email/password accounts: not offered
Google answers the argument that motivated email — "requiring Discord is a hard sell for a general audience" — and Google is near-universal. Email would add a third way in for people avoiding both providers, at the cost of a transactional-email provider, SPF/DKIM records on the domain, and deliverability as a permanent concern. It also can't be half-adopted: **password reset is the hard requirement, not confirmation**, and without reset mail every forgotten password is a permanent lockout fixed by hand.

Nothing else in the product needs mail — invites are copy-paste links, and reminders are the Discord webhook plus the ICS feed. Revisit only if someone actually asks. The local Supabase stack ships a mail catcher, so the whole flow could be built and tested with no provider before committing to one.

### No paid backups
Supabase Pro would provide PITR; it was declined on cost. **The consequence is accepted, not overlooked:** the club can lose everything since the last successful `scripts/backup.sh` run, and that script only fires while one particular Mac is awake and logged in. If it ever matters more than the subscription, the fix is a toggle.

### Clubs are private by default
Only the seeded club is `public`. A new club is reachable only by whoever holds its link or an invite.

### Open signup
Anyone can register and create a club without an invite. This was briefly narrowed to invite-only friends and then reverted. It's what makes the gaps in §4 matter.

### Discord is one integration, not the foundation
A club supplies its own webhook or gets no Discord posts. `/mybook` and the winner @-ping key off `discord_id` and degrade gracefully for readers who have none.

### A club's slug can't change
`update_club` refuses it outright rather than half-supporting it: changing a slug breaks every link and invite already shared, and it would need the same reserved-word and uniqueness handling as creation.

### Free forever
No billing model anywhere in the schema.

## 3. Deliberately not built

Each of these is a considered omission, not a backlog item.

- **A frontend restructure.** `index.html` is ~5,900 lines of string-built HTML with a full re-render per change. It works, and the pain hasn't justified the rewrite. Revisit when it does — not before.
- **Avatar upload.** Avatars come from the identity provider. There's nowhere to upload to (Supabase Storage is unused) and no demand.
- **`profiles` as the display source.** It's written live and read for the customised-name flag, but `shelf_users` is still what the app renders and what Discord embeds use. Flipping the read would mean touching the draw path and the embeds at once; it buys tidiness, not behaviour.
- **Guild → club mapping for `/mybook`.** A slash command carries a guild and a Discord user, never a club, so the command is pinned to the seeded club. Fixing it means teaching `clubs` its Discord guild id — worth doing only if a second club actually wants the integration.
- **Spectating a public club.** Membership is required to see a club's app, even for a `public` club whose rows RLS would happily serve. The signed-out gate already meant nobody could do this in practice.
- **A connect/disconnect-providers UI.** Supabase already links a second provider automatically when the verified email matches, which is the behaviour that mattered.
- **Captcha and sign-in rate limiting.** These mattered because *email* signup is a cheap bot vector. An account still costs a real Google or Discord account, and club creation is already capped at 3 per user per day.
- **Cadence** (`{ weekday, hour, weeks }` on a club). Nothing read it, and "when do we meet" is already answered per-read by the meeting scheduler.

## 4. Known gaps

Real, unresolved, and mostly not engineering.

- ~~No Terms or Privacy notice, and no way to reach the operator.~~ Closed: `#/legal`, reachable signed in or out, linked from the sign-in gate and the app footer. Points to GitHub Issues as the contact.
- ~~No moderation path~~ beyond deleting a club or an account. Closed, minimally: `clubs.suspended_at` (20260810140000_club_suspension.sql) is a reversible hold an operator sets by hand (no UI) — every club-scoped edge function refuses to write while it's set, but leaving, deleting, and a librarian's own settings changes stay allowed. A stranger's club is still not the same trust level as a friend's; this is a kill switch, not a review queue.
- **Backups depend on one laptop being awake.** See §2.
- ~~Two screens have never been looked at by a human~~: Admin → Club settings and the account page have both now been rendered and screenshotted (mocked Supabase backend, real page). Both hold up.

## 5. What scaling would actually cost

Supabase is not the bottleneck — a club's state is a few KB, and a thousand clubs is single-digit MB against a 500 MB free tier. Two things had to be right from the start and are: **`loadAll` is scoped by `club_id`** (an unscoped `select("*")` would make every client download every club's data), and **realtime subscriptions are filtered** (`club_id=eq.<id>`), so one club's activity doesn't re-render another's.

| Item | Cost |
|---|---|
| Supabase (free tier) | $0 — Pro declined, see §2 |
| Domain | ~$12/yr |
| GitHub Pages | $0 |

The free tier's real cost isn't capacity, it's that projects pause after about a week of inactivity and there are no automatic backups.

## 6. Verification

Four layers, all runnable on demand — see CLAUDE.md → Common commands:

- `node --test supabase/functions/_shared/*.test.mjs` — the pure draw/undo/rating/meeting logic.
- `node --test tests/*.test.mjs` — client logic (identity extraction, the post-auth redirect, the OAuth consent flag), sliced out of `index.html` at run time so it tests what ships and fails loudly if a function is renamed rather than passing against a stale copy.
- `deno check supabase/functions/*/index.ts` — **the only thing that typechecks the edge functions**; the Supabase deploy pipeline transpiles without checking.
- `node --test supabase/tests/rls-isolation.test.mjs` — cross-tenant isolation against the linked project, creating and cleaning up a throwaway private club.

Plus `scripts/rehearse-migrations.sh`, which applies a migration to production inside `BEGIN … ROLLBACK` — proving it works against real schema and real data while committing nothing.

Still uncovered: `render()` and the bulk of the client module beyond a parse check, and end-to-end request handling in the edge functions.

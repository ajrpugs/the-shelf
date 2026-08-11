# The Shelf — configurability plan (Phase 8+)

**This was a plan; it is now mostly a record.** Phases 8 through 11, and all of 12 except §2 (vote mode), are shipped and live. `docs/multi-tenant-plan.md` is the record of how the app became multi-tenant *structurally* — separate clubs, separate rows, enforced isolation. This document covers the half that didn't come with it: a club can be its own tenant, and can now genuinely be **its own book club** — its own selection mode, its own rating rubric, its own notification settings, its own Discord server. Vote mode (§2) is the one deliberately unbuilt piece; see §7's sequence table for why.

Read `docs/multi-tenant-plan.md` §2 and §3 first. Several things below were already considered and answered there; where this plan reverses or narrows one of those answers, it says so explicitly.

**Tenancy at the time this plan was written: one club**, `the-guild`, 12 members, 17 reads, no webhook of its own — the fact that made every migration below safe to assume a single well-known row, and every defect fixable before it had a second tenant to hurt. That's no longer the live count (a second club exists, and the-guild has its own webhook now); this section is left as the historical premise, not a live status line.

---

## 0. Fix first: three places the seeded club leaks into everyone else's

**Status: done (Phase 8).** All three are fixed in the working tree; the section is kept as the record of *why*, since none of the three is visible in the code that replaced it. Two things about the fix that the plan below did not anticipate:

- **The seeded club had no webhook of its own** — confirmed against production, not assumed. So removing the fallback makes it go *silent* rather than keep working, and the ordering in §0.1 is a hard prerequisite, not a nicety. `supabase/tests/rls-isolation.test.mjs` now fails until `club_secrets.discord_webhook_url` is set for `the-guild`, which turns that prerequisite into something that can't be forgotten.
- **`renderClubProblem` had already been fixed** (its eyebrow reads "Book club"), and the third literal the plan meant is in `renderDetailMissing`, not there. The line numbers in §0.2 below are from an earlier revision of the file.

Verification added: `tests/tenant-correctness.test.mjs` (offline; asserts the fallback is absent from all three copies, that the four functions require `club_id`, that every client call site passes one, and that no header eyebrow is a club-name literal) plus the two new cases in `rls-isolation.test.mjs`.

These are not features. They are live defects in what Phase 4–7 already shipped, and each one gets worse the moment a second club exists.

### 0.1 Every club posts into The Guild's Discord

`webhookFor()` (`admin-update/index.ts:444`, and its copies in `set-book:126` and `discord-interactions:71`) resolves the club's own webhook and then, finding none, **falls back to the `DISCORD_WEBHOOK_URL` env secret** — which is The Guild's channel:

```ts
const own = (data?.discord_webhook_url as string | null) || null;
if (own) return own;
return Deno.env.get("DISCORD_WEBHOOK_URL") || undefined;   // <- The Guild's channel
```

So a stranger's club, with no webhook configured, announces its draws, meeting times and locked scores — with member display names and avatars — into a Discord server none of its members are in. The Admin tab says the exact opposite: *"With none, this club posts nothing to Discord."*

It has never fired in production because no second club exists. It would fire on the first one.

**Fix:** delete the fallback in all three copies; `webhookFor` returns the club's own webhook or nothing. Before deploying, write the current env value into `club_secrets.discord_webhook_url` for `the-guild` so its posts keep working. The env secret then survives only as an operator convenience for seeding, and should be unset afterwards.

### 0.2 Every club's header says "The Guild"

`index.html:4163` is a literal:

```js
<div class="eyebrow">The Guild · Round ${state.roundNumber}...</div>
<h1>The Shelf</h1>
<div class="sub">Everyone drops a book on the shelf. The wheel picks one at random — ...</div>
```

`clubName()` exists and is used in a dozen other places. `clubs.tagline` is editable in Admin → Club settings, stored, length-checked — **and rendered nowhere**. A club that names itself and writes a tagline sees neither.

**Fix:** eyebrow → `clubName()`; `.sub` → the club's tagline, falling back to today's sentence only for a club that has none. Same for the two other hardcoded "The Guild" eyebrows (`renderClubProblem` at 5160, `renderLoginGate` at 5700 — the sign-in gate is the *product's* front door and should not carry one club's name at all).

### 0.3 `DEFAULT_CLUB_ID` is a fallback with no remaining purpose

Six edge functions default an absent `club_id` to the seeded club. CLAUDE.md is honest about why: it let the frontend and the functions deploy in either order. That ordering constraint expired several phases ago — the shipped client names a club on every call.

**Fix:** make `club_id` required in `admin-update`, `set-book`, `set-review` and `post-comment` (400 on absence). Leave it in `calendar-feed` (a tokenless URL predates the token and must keep resolving) and `discord-interactions` (see §5.4). This removes a whole category of "wrote to the wrong club" bug rather than relying on every future action remembering to pass one.

**Size:** all of §0 is small and mechanical. It should ship as one phase, before any of the below.

---

## 1. Where per-club configuration lives

Everything in §2–§4 is the same shape: *a club decides how something behaves, and both the browser and an edge function must agree on the decision.* The schema currently has nowhere to put that.

**Decision: one `clubs.config jsonb not null default '{}'`.**

- It is already fetched. `resolveClubFromRoute()` selects the club row on every load; config rides along for free.
- It is never queried by field — always read whole, for one club. That is precisely the case where a column per knob is wrong, because it means a migration per knob.
- It matches two patterns the repo already trusts: `shelf_state.data` (a whole-object jsonb edit under a version guard) and `club_secrets` (service-role-only config keyed by club).

**The cost, stated plainly:** jsonb takes no CHECK constraints, so the database will not stop a malformed config. Validation therefore lives in `club-admin.update_club`, which is exactly where `timezone` validation already lives, and where a rejection can be explained to a librarian. The DB keeps only a size guard.

**The rule that makes it safe:** *every read of config must default to today's behaviour.* A club row written before a feature existed has no key for it, and must behave identically to one written after. This is not a style preference — it is what lets migrations, function deploys and the GitHub Pages deploy land in any order without a window where clubs misbehave.

**Therefore: a shared config module.** `supabase/functions/_shared/club-config.mjs`, in the same plain-`.mjs` form as `shelf-logic.mjs` — a valid Deno import at deploy time, runnable under `node --test` with no tooling, and sliced into the client the way `tests/*.test.mjs` already slices client logic out of `index.html`. It exports the defaults and one `normalizeConfig(raw)`. Client and server then cannot disagree about what an absent key means, which is the failure mode that would otherwise produce a rubric the browser renders and the server rejects.

This is the load-bearing decision in the plan. Everything below assumes it.

---

## 2. How a club picks books

Today there is exactly one algorithm, and it is the app's identity: a `<canvas>` wheel picks a random reader from those with a book set, the picked reader is added to `eliminated` and sits out until the pool empties, at which point the round auto-advances. It is good, and it should stay the default.

It is also not how most book clubs choose. Proposed `config.selection.mode`:

| Mode | Behaviour | Cost |
|---|---|---|
| `wheel` | Today's. Default for every club. | — |
| `rotation` | Fixed order, next member in line. No randomness, no elimination — the cursor *is* the fairness guarantee. | **S** |
| `pick` | The librarian simply chooses whose book is next. | **S** |
| `vote` | Members nominate; everyone votes; the winner becomes the read. | **L** |

`rotation` and `pick` are small because they change *who is chosen* and nothing else: both end in the same `reads` insert, both go through the same `writeGameState()` optimistic lock, both fire the same Discord post. `rotation` needs one new key in `shelf_state.data` (a cursor over a stable member order — join order, so a new member joins the back of the queue rather than jumping it), and `pick` needs no state beyond the existing `eliminated`.

A second knob falls out of this and is worth having independently: `config.selection.sitOut` (default `true`). The sit-out rule is what `eliminated` and `roundNumber` exist for. A club that just wants "spin it, anyone can win twice" should be able to say so, and for `pick` and `rotation` the rule may not make sense at all.

**`vote` is a phase of its own.** It is not a variant of the draw; it is a lifecycle the app does not have — nomination window, voting window, close, tie-break — with two new tables (`club_polls`, `club_poll_votes`), their own RLS, their own realtime channel, an edge function action set, and a tab. Recommend building it only after §2's cheap modes and §3 are live and someone has actually asked for it.

**UI consequence to plan for, not discover:** "The Wheel" is a tab, a canvas renderer, and a spin animation with an announcement. Under `rotation` or `pick` that tab must become mode-aware rather than hidden — a club that switches mode still has 17 reads of history rendered by wheel-shaped code paths.

---

## 3. How a club rates books

Today: five fixed categories (`plot`, `characters`, `pacing`, `language`, `themes`), each 1–20, summed to a /100 "Guild score", with band thresholds at 80/55/30 and four paragraphs of Bibliomancer's Guild prose per category as scoring guidance.

**The good news is bigger than it looks.** The client is already entirely driven by the `RUBRIC` constant — all 21 references go through it, including `aggregateRubric`, the review wizard, the per-reviewer breakdown and the superlatives. Nothing reads `r.plot` directly. So "make the rubric configurable" is mostly "make `RUBRIC` come from the club" rather than a rewrite.

**Decision: keep the five typed columns; treat them as slots.** `shelf_reviews.plot…themes` stay exactly as they are physically. The club's config supplies, per slot, a label and whether the slot is in use. This buys:

- zero data migration, and every existing review still valid;
- the `between 1 and 20` CHECKs stay real, in the database, where they belong;
- a club can have 3 categories, or 1 (which *is* a simple single-score rating), or 5 with their own names.

```jsonc
config.rating = {
  scale: 20,                    // per-category max
  categories: [                 // 1..5 entries, mapped to slots in order
    { slot: "plot", label: "Plot", bands: { exc: "…", great: "…", good: "…", bad: "…" } },
    …
  ]
}
```

Three consequences to handle:

1. **The DNF constraint must be relaxed.** `shelf_reviews_dnf_scores_chk` currently demands all five columns null *or* all five non-null. With three active slots the other two are legitimately null. New form: `(dnf and all null) or (not dnf and at least one not null)`. One small migration, rehearsable against production with zero row changes.
2. **The total must normalize.** `aggregateRubric` sums five categories to /100 by arithmetic coincidence. It becomes `round(sum(active) / (count × scale) × 100)`, which leaves The Guild's numbers bit-identical and keeps the 80/55/30 bands meaningful for everyone.
3. **`set-review` must validate against the club's config, read server-side.** Not against the category list in the request body. This is the same rule as §0.3 — the client names a club, the server re-derives everything else.

**Changing a rubric mid-life makes old scores incomparable**, and that is a real problem, not a hypothetical: a club that renames "Pacing" to "Vibes" halfway through has a leaderboard mixing two things. **Fix cheaply: snapshot the profile onto the read at lock time.** `admin_set_rating` already writes `reads.rating = { total, cats }` as jsonb; adding the labels it was scored under means a locked score always renders with its own rubric, and history stays honest without versioning tables.

Also in scope, because it is the same edit: the string "Guild score" is hardcoded in six places. It should be a config label defaulting to "Club score", with `the-guild` set to "Guild score" so nothing visibly changes there.

**Size: M.** Bounded by the fact that the client is already constant-driven; the work is the config plumbing, the normalization, the constraint, and the three copies of the Discord embed labels.

---

## 4. Notifications

Today, in full: a per-club Discord webhook (plus the §0.1 leak), an @-ping of the winner when their `discord_id` is known, and a per-club iCalendar feed. There are **no per-user preferences of any kind**, and no channel at all for a club that doesn't use Discord.

Sequenced by value per unit of cost:

**4.1 — Stop the leak (§0.1).** Prerequisite. Note honestly what it does: after this, a club with no webhook gets *silence*, where before it got wrong-channel noise. That makes 4.3 matter more, not less.

**4.2 — Per-club event toggles. (S)** `config.notify = { draw, bookSet, meeting, rating, mentionWinner }`, all defaulting `true`. Read in `admin-update` and `set-book` immediately before posting. A club that finds the every-book-set post noisy can turn it off without abandoning Discord entirely. Cheap because the post sites already exist and already have no-op guards.

**4.3 — An in-app baseline that needs no integration. (M)** The honest answer for a club with no Discord is not "add email", it's that the app never tells you anything when you open it. Everything needed is already loaded by `loadAll`: reads, comments, reviews and their timestamps. A "since you last looked" marker — one `club_members.last_seen_at` column, written on load — turns that into an activity summary and unread badges on the tabs. No provider, no DNS, no deliverability, no new failure mode.

**4.4 — Per-user preferences. (M)** A `notification_prefs (club_id, user_id, …)` table, PK `(club_id, user_id)`, RLS "own row only" — one of the few writes that can safely go straight from the client under RLS, like `shelf_comment_reactions`. Minimum useful content: *don't @-me in Discord*. Per-club rather than per-user-global, because someone can reasonably want pings from their close club and not from the loud one.

**4.5 — A second channel: not yet, and here is the trigger.** Email was declined in `multi-tenant-plan.md` §2 for *auth*, where the blocking requirement was password reset. Notification mail is weaker — a dropped message is an annoyance, not a lockout — so the decision genuinely could be revisited. It still costs a transactional provider, SPF/DKIM on the domain, and deliverability as a permanent concern. Web push avoids all three (a service worker is fine on Pages, VAPID keys are free) but is dead on iOS unless the user adds the site to their home screen — which, for a phone-first book club, is most of the audience.

**Recommendation: build neither until 4.3 exists and someone still asks.** If the ask comes, web push first — it has no ongoing cost and no domain reputation to lose.

---

## 5. Other things "fully multi-tenant and flexible" implies

**5.1 — Per-club export. (S)** A librarian cannot currently get their club's data out; only the operator's `scripts/backup.sh` can, and it dumps everything. For a free product holding other people's clubs this is both a trust and a data-protection point, and §4 of the other document already closed the Terms/Privacy gap on the same reasoning. One `club-admin` action, `export_club`, returning the club's reads, members, reviews and comments as JSON. It reuses the librarian gate that already exists.

**5.2 — Meetings beyond 50% / 100%. (M)** `reads.meetings` is jsonb `{ half, full }` and the client hardcodes those two phases in six places. Clubs that meet weekly can't express it. jsonb means no migration — the work is the client and `calendar-feed`. Note the trap already documented in CLAUDE.md: event `UID`s must stay stable or every existing subscriber duplicates every event.

**5.3 — More than one book at a time.** Not recommended. "The current read is the oldest `reads` row without a committed rating" is load-bearing in both the client and `set-review`, and is what makes the review window unambiguous. Supporting concurrent reads means replacing that rule everywhere it appears. Worth doing only for a club that actually runs two tracks.

**5.4 — `/mybook` and the Discord guild. (S, blocked on demand)** Pinned to the seeded club because a slash command carries a guild and a user, never a club. `clubs.discord_guild_id` plus a lookup fixes it. Unchanged from the existing decision: worth doing when a second club wants Discord, not before.

**5.5 — Club vocabulary in general.** Beyond the specific labels in §2 and §3, resist it. A general rename-anything system is a large surface for a small return; the three strings that actually carry a club's identity are its name, its tagline and what it calls a score.

---

## 6. What this plan deliberately does not include

- **A frontend restructure.** `index.html` is now 6,224 lines, and this plan adds config-driven branching to it. That is a real argument for splitting it — and still not enough of one. The mitigation is §1's shared `club-config.mjs`, which pulls the part that *must not* drift out of the file entirely. Revisit when the pain is concrete.
- **A public club directory / spectating.** Already declined; nothing here changes the reasoning.
- **Billing, quotas, per-club limits.** Free forever, no billing model in the schema. Club creation is already capped at 3/user/day.
- **Structured book records** (ISBN, author as a field). `reads.book` is free text matched fuzzily against Open Library for covers. Making it structured would improve stats and dedupe and would touch the draw path, the embeds in three functions, and every historical row. Not for this plan.

---

## 7. Sequence

Each phase is independently shippable and leaves the app working. Migrations land before function deploys before the Pages push, per CLAUDE.md.

| Phase | Contents | Size |
|---|---|---|
| **8 — Tenant correctness** ✅ | §0.1 webhook leak, §0.2 club branding in the header and gate, §0.3 required `club_id` | S |
| **9 — Config foundation + selection** ✅ | `clubs.config`, `_shared/club-config.mjs`, `update_club` validation, §2 `rotation` / `pick` / `sitOut`, mode-aware Wheel tab | M |
| **10 — Rating profiles** ✅ | §3 slots, DNF constraint, normalized total, profile snapshot on lock, score label | M |
| **11 — Notification control** ✅ | §4.2 event toggles, §4.3 in-app activity + `last_seen_at`, §4.4 per-user prefs | M |
| **12 — On demand only** ◐ | §5.1 export ✅, §5.2 meeting phases ✅, §5.4 guild mapping ✅. §2 `vote` deliberately **not built** — see below | L |

Phase 8 should ship on its own and soon; it is the only one with a live defect in it, and it is the only one that gets harder once a second club exists.

**§2 `vote` mode stays unbuilt, on purpose.** Everything else in this document has shipped. Vote mode is the one item where the plan's own recommendation ("build it only after the cheap modes are live and someone has actually asked for it," §2) was followed rather than overridden: it's a real lifecycle — nomination window, voting window, close, tie-break — not a variant of the existing draw, and it needs two new tables, their own RLS, a realtime channel, and a tab, none of which piggyback on anything above. Build it when a club asks, not before.

## 8. Verification this plan owes

The four layers in `multi-tenant-plan.md` §6 all still apply. New coverage each phase must add:

- **Phase 8** ✅ — `rls-isolation.test.mjs`'s throwaway club now asserts it resolves *no* webhook, and a second test asserts the seeded club has one of its own (the deploy gate). `tests/tenant-correctness.test.mjs` covers the source-level half. Stated honestly: the source assertions prove the fallback is *absent*, not that the replacement behaves — nothing here executes an edge function, which is the gap §8's last paragraph already names.
- **Phase 9** ✅ — `_shared/club-config.mjs`'s `node --test` suite asserts `normalizeConfig({})` equals today's behaviour first; `shelf-logic.mjs` has rotation-cursor cases alongside `pickEligible`.
- **Phase 10** ✅ — the DNF constraint change was rehearsed with `scripts/rehearse-migrations.sh` and confirmed zero row changes on push; the normalized total is asserted bit-identical to the old sum-of-five formula at the default profile.
- **Phase 11** ✅ — `notification_prefs` joined the RLS isolation test (including a same-club-member-can't-see-another's-prefs case) and both files in `supabase/backup-sql/`; all 13 cases pass against the live project.
- **Phase 12** ✅ (minus vote mode) — `buildExtraMeetings` has its own `node --test` coverage, including that one malformed row doesn't drop the others in the same save; `calendar-feed` was smoke-tested live post-deploy and confirmed existing half/full UIDs are unchanged.

Still uncovered, unchanged: `render()` and the bulk of the client beyond a parse check, and end-to-end request handling in the edge functions.

# The Shelf — Librarian dashboard plan

**Status: written and tested, not deployed.** Steps A–E are implemented in one change and pass the suite, but the work is **uncommitted in the working tree** — `main` is still at `776efed` and `https://sh3lf.net/` serves the old Admin tab. Nothing here is live until it is committed and pushed (GitHub Pages serves `index.html` from `main`). §1's measurements are the "before" and are kept as the record of what was wrong, since none of it is visible in the code that replaced it. §9 is what happened, including the two places the plan was wrong.

Original framing follows. This covers the Admin tab (`index.html:4834–5058`), renamed the **Librarian dashboard** and rebuilt around what a librarian actually does rather than around the order the features happened to ship in — **plus the meeting scheduler, which moves in from the Calendar tab** (§3.5). Five other librarian-only controls were considered for the same move and deliberately left where they are; §3.6 records which and why, so the question doesn't have to be re-derived later.

Everything here is a **frontend-only change**. No migration, no edge-function change, no new table. Every number the proposed overview shows is already in memory after `loadAll` (`state.history`, `users`, `state.eliminated`, `invites`, `clubSettings`, `reviewsFor`). That is a deliberate constraint, not a coincidence — see §6.

---

## 1. What's actually wrong, measured

Taken from the live Admin tab of `the-guild` (round 17, 12 members), signed in as a librarian, at a 1288×681 viewport.

### 1.1 It's one 3,504px scroll — 5.1 viewports

Ten `.card no-rule` blocks, stacked, no grouping, no in-page navigation, no way to get to the bottom except to scroll past everything above it:

| Card | Height |
|---|---|
| Undo last spin | 64px |
| Manage readers | 698px |
| Club settings | 393px |
| How the club picks its next read | 143px |
| Rating rubric | 514px |
| Discord notifications | 240px |
| Discord & calendar | 454px |
| Invitations | 126px |
| Export | 86px |
| Danger zone | 145px |

The five heaviest cards are 2,299px — **66% of the page** — and four of those five are set-once configuration. "Delete this club" and "Reset the shelf" sit at 3,400px, below a 514px rubric editor most clubs will open once ever.

### 1.2 Frequency and prominence are inverted

Sorted by how often a librarian touches it:

- **Weekly:** undo a spin, fix someone's book, invite someone, promote a librarian.
- **A few times ever:** name, tagline, timezone, visibility, selection mode, rubric, webhook, guild ID, notification toggles.
- **Once or never:** export, reset the shelf, delete the club.

The page gives all three tiers the same card, the same `.tools-label` eyebrow, and the same width. Nothing on it says which is which.

### 1.3 `.btn-danger` and `.btn-primary` are literally the same colour

```
.btn-primary{ background: var(--stamp); color: var(--card); }              /* index.html:233 */
.btn-danger{  background: var(--stamp); color: var(--card); border: 1px solid var(--stamp); }  /* index.html:264 */
```

Computed on the live page, both are `rgb(213, 87, 63)` on `rgb(246, 236, 208)`. The border is the same colour as the fill, so it contributes nothing. **"Delete this club" is visually indistinguishable from "Save webhook."** This is the single most consequential item in this document and it is not really a layout problem — the app currently has no destructive affordance at all, anywhere.

The knock-on effect on this page specifically: nine red buttons in one column, so red carries no meaning and the eye has no anchor.

### 1.4 Consecutive `.tool-row`s are flush at 0px

`.tool-row` (`index.html:813`) sets `display:flex; gap:12px` and no vertical margin. In the Danger zone the two rows measure `top 587 → bottom 619` and `top 619 → bottom 676` — the "Reset the shelf" and "Delete this club" buttons touch edge to edge, which reads on screen as two overlapping boxes. Same defect in the Discord & calendar card.

### 1.5 26 inputs on one page, 15 of them unstyled native controls

12 `input[type=checkbox]` and 3 `input[type=number]`, none of them themed — `appearance` computes to `auto`. On dark felt, where every text input *is* themed, that's system-blue ticks and white number spinners next to house-styled fields. This is the loudest "amateur" tell after §1.3, and it's about 20 lines of CSS.

### 1.6 A credential is rendered as body prose

The calendar feed URL — `club_secrets.calendar_token`, the one shareable secret on the page — renders inside a `.tool-row-desc` as wrapping italic text across three lines. It has an `.invite-code` class that the italic parent overrides. It should be a read-only field with a copy button, which is what it is functionally.

### 1.7 Two save contracts on one page, unlabelled

"Club settings" and "Rating rubric" batch changes behind a **Save** button. Selection mode and the five notification toggles save **instantly on change**. Both behaviours are correct in isolation and there is no signal telling them apart, so a librarian who edits the rubric and navigates away loses it, having just watched a toggle two cards up save itself.

### 1.8 720px column, ~40% used

The content column is 720px. Most cards put a 220px field, a 280px field, or a single button in the left 40% and leave the rest empty felt. That emptiness is why the tiles read as taking too much space — they're tall *and* sparse.

---

## 2. What bookclubs.com does

Four things worth taking, and the reasoning is more useful than the layout.

**2.1 Their Admin Dashboard is a next-steps surface, not a settings dump.** New club creators get a dashboard "full of all the next steps to guide you through the process of setting up your book club, including inviting members, adding books, creating a meeting, sending your first poll." It answers *what should I do now*. It is not where you go to change the club's name.

**2.2 Configuration is demoted behind a gear.** Club Settings live under the About tab, opened by a gear icon, admins only. Settings are one entry on a page, not the page.

**2.3 Admin actions live next to the thing they act on.** Member management is on the Members list. Meeting creation is on Meetings. There is no page called "everything an admin can do" — which is exactly what The Shelf's Admin tab is, by accretion.

The Shelf already does this partly and by accident: the draw is on the Wheel tab (`index.html:4603`), meeting scheduling is on Calendar (`:3877`), opening and closing ratings is on Reviews (`:4196`). The Admin tab is the residue — everything that didn't have an obvious home. That's the actual origin of the problem.

**2.4 They redesigned *away* from a horizontally scrolling tab strip**, down to five tabs (About, Books, Meetings, Messages, Polls), by consolidating rather than adding: Members moved under About, three separate reading lists merged into Books. The Shelf has eight tabs and a scrolling strip with mask fades — `index.html:946` carries a three-paragraph comment about making that scroll behave. That comment is a symptom worth noting, though this plan does not propose touching the top-level tabs (§7).

**Not taken:** their permissions model (who may create a meeting, post a poll), paid membership, video meetings, ranked-choice polls. Vote-based selection is deliberately unbuilt — `docs/configurability-plan.md` §7.

---

## 3. Proposed structure

### 3.1 Naming

- Tab label `Admin` → **`Librarian`**.
- Section title "Librarian tools" → **"Librarian dashboard"**.
- **Keep the route segment `admin`.** `#/c/<slug>/admin` is bookmarked and appears in the tab id, `aria-controls`, and `tab-btn-admin`. Renaming the segment buys nothing and breaks links.
- One string elsewhere refers to the tab by name and must change with it: `index.html:5586`, *"Create an invite link in the **Admin** tab."*

### 3.2 Four sub-sections instead of one scroll

Second-level nav inside the tab, split on frequency (§1.2) rather than on feature history:

| Section | Contains | Touched |
|---|---|---|
| **Overview** (default) | Status, things needing attention, undo last spin, **schedule meetings** (§3.5) | Every visit |
| **Readers** | Member roster with roles and books, invite links | Weekly |
| **Settings** | Name, tagline, timezone, visibility, selection mode, rating rubric, Discord, calendar, notifications | Rarely |
| **Data** | Export, reset the shelf, delete the club | Once or never |

Overview and Readers are what a librarian opens the tab for. Settings and Data are two clicks away and stop competing for the same scroll.

An earlier revision of this plan added a fifth section, "This round", to hold everything relocated from the member-facing tabs. With §3.5 narrowed to the meeting scheduler alone, one card doesn't justify a section — it goes on Overview, under the attention list, which makes Overview the librarian's operational surface rather than a pure readout. Typical height is 200–400px (one in-flight read, plus any next-up), so it does not undo §1.1.

**Routing.** `parseRoute()` (`index.html:~5140`) matches `#/c/([^/]+)/?([a-z]*)$` — one path segment only. Extend it to an optional third: `#/c/<slug>/admin/<section>`, defaulting to `overview`. `goToTab(id)` grows an optional second argument. **CLAUDE.md's rule stands** — every programmatic switch goes through `goToTab()`, or `parseRoute()` reverts it on the next render. Putting the section in a module variable instead would be less code and would lose the section on reload and break the back button; not worth it.

Style the sub-nav distinctly from `.tabs` — a pill row, not a second underlined tab strip, so it doesn't read as a competing level of the same thing.

### 3.3 The Overview earns the name "dashboard"

This is the §2.1 borrow, adapted: bookclubs.com's dashboard is aimed at a club on day one, and most Shelf clubs opening this tab are mid-round. So the same slot renders one of two things.

**For a running club** — a compact stat strip plus an attention list. Every value is already derivable client-side:

- Round number, eligible readers (`eligibleEntries()`, `:3166`), readers with no book set, members, open invites (`inviteState()`, `:2342`).
- **Needs attention**, each row a one-line statement with one button:
  - *4 readers haven't set a book* → Readers
  - *No discussion date set for the current read* → the scheduler, further down Overview (§3.5)
  - *No Discord webhook — this club posts nothing* (`clubSettings.has_webhook`) → Settings
  - *You're the only librarian* → Readers
  - *Ratings are open on "X" — 3 of 9 have reviewed* (`reviewsFor()`, `:4094`) → Reading tab, since the ratings controls stay there (§3.6)

  Four of the five resolve inside the dashboard. The fifth links out, and should look like it does — a row that hands the librarian off to another tab shouldn't be styled the same as one that scrolls them down the page.
- **Undo last spin** stays here. It's the highest-frequency risky action and being first on the page today is already correct.

The attention list is the whole point: it's the only part of this tab that tells a librarian something they didn't already know.

**For a new club** (no reads, one member) the same slot renders a setup checklist with ticks — set your timezone, invite readers, connect Discord, set your book, spin the wheel. That is the direct bookclubs.com borrow, and it's the moment a librarian most needs the guidance.

**Guard it.** `app.innerHTML` is assigned once at the end of `render()`; a `TypeError` while building this section leaves the page on `Pulling the ledger…` forever, with the console as the only evidence. The overview reads more derived state than anything else on the page — every lookup optional-chained, every list defaulted. This is exactly the failure mode `clubConfig().notify` caused in production (CLAUDE.md → Gotchas → UI).

### 3.4 Collapse the rarely-used configuration

Inside Settings, the Rating rubric (514px) and Discord & calendar (454px) become a **summary row plus an expander**:

> Rating rubric — Guild score, 5 categories out of 20 each · **Edit**

Native `<details>`, the same mechanism `.row-menu` already uses (`index.html:832`) — no new machinery, no JS state, and it survives a re-render because it's DOM-native. Settings goes from roughly 1,750px to about 600px collapsed.

### 3.5 Move the meeting scheduler in from Calendar

Six librarian-only controls live outside this tab. **One moves now.** The other five were each considered and are staying put for now — recorded in §3.6 rather than dropped, so the reasoning survives.

**What moves:** the "Schedule meetings (librarian)" card, `index.html:3880–3927` — the per-in-flight-read editor and its four handlers (`data-me-save`, `data-me-add-extra`, `data-me-announce`, and the extra-phase removes).

It's the clearest case of the three defects converging. It is a **form only one person in the club can use**, sitting on a tab eleven members open to check a date; it's the tallest thing on Calendar; and the librarian reaches it by scrolling past the month grid, the upcoming list, the recent list, and the subscribe box every time. Nothing on it is contextual to the Calendar tab — it renders from `currentlyReading` + `nextUp`, both already in scope on the dashboard.

**Calendar keeps** the month grid, the upcoming and recent lists, and the subscribe box — i.e. everything a member goes there for, unchanged.

**No handler changes.** `data-me-save` builds the same `admin_set_meeting` payload and `data-me-announce` the same `admin_announce_meeting` regardless of which tab rendered the button. The wiring in `wireUp` (`:6277`, `:6309`, `:6322`) is `querySelectorAll` over the whole document, so it keeps working untouched — the move is markup only.

**Two things to get right in the move:**

- **The zone labels are a live bug.** They're hardcoded — `50% meeting (Toronto)`, `100% meeting (Toronto)`, and a hint reading *"Times are always entered and shown in Toronto time, wherever you are."* But the zone is `clubs.timezone`, configurable since Phase 6, and `toClubInputValue` correctly uses `clubTz()`. **The values are right and the labels lie to every club outside Toronto**, telling them to enter times in a zone they don't use. This markup is being rewritten anyway; substitute `clubTz()`. Worth fixing even if the rest of this plan is deferred.
- **`render()` bails while an input has focus.** The editor holds `datetime-local` and text inputs, and on Overview they now sit alongside an attention list that changes with realtime traffic. This is not new — the same inputs live under the same rule on Calendar today — but the deferred-render path (`pendingRender`) should be exercised deliberately here, since Overview re-renders more often than Calendar did.

### 3.6 Considered and left where they are

Not dropped — decided. Each of these was inventoried and priced; revisit with this section rather than from scratch.

| Control | Lives now | Why it's staying |
|---|---|---|
| Open ratings | Reading banner, `:4184` | Moves cleanly, but see below |
| Close ratings | Reading banner, `:4196` | Same |
| Lock in *score label* | Reading banner, `:4195` | Deferred — needs its context carried, see below |
| The draw — wheel spin | Wheel, `:4645` | Deferred — `runDraw` hard-returns without the canvas, see below |
| The draw — rotation / librarian-picks | Wheel, `:4596`, `:4606` | Would move with zero code change, but the draw's location shouldn't depend on selection mode |

**The three ratings controls stay together as a unit.** Open → members review → lock is one flow, and all three buttons sit on the Reading banner today. Moving two and leaving the third would split a three-step sequence across two surfaces — worse than either extreme. With Lock deferred, all three stay.

**Lock-in's cost, when it does move:** on the banner it sits directly under the live aggregate — running score, review count, DNF count (`:4188–4193`). Locking is durable and it's what drops the read to the leaderboard. The dashboard would have to reproduce that readout beside the button, or the librarian commits a score they can't see. `aggregateRubric` and `reviewsFor` are already client-side, so it's markup, not data — but it's not a button you can relocate on its own.

**The wheel spin's cost:** `runDraw` (`:3400`) does `const canvas = document.getElementById("wheel-canvas"); if (!canvas) return;` — it hard-returns when the canvas isn't in the DOM, so a spin button on the dashboard would do **nothing, silently**. The fix is a `goToTab("wheel")` hop before spinning (`runDraw` already ends with `goToTab("reading")`, so mid-draw tab hops are established), not a second canvas — the wheel is a shared moment and spinning it where only the librarian can see would drain that.

**Rotation and pick stay with it** so the draw is always in the same place whatever mode the club runs. Standalone, both would move for free — `runNonWheelDraw` (`:3466`) touches no canvas — and in `pick` mode the Wheel tab currently renders a bare list of clickable names visible to exactly one person, which is genuinely odd where it is. Not odd enough to make the draw's location mode-dependent.

---

## 4. Fix the visual defects

These are independent of the restructure, smaller than it, and fix most of "it looks amateur" on their own. Worth landing first (§7).

1. **Give `.btn-danger` a real treatment.** Outlined stamp on transparent, filling to solid on hover — the standard destructive pattern, and it reserves solid red for *actually* destructive. Then demote routine saves (`Save webhook`, `Save server ID`, `Copy feed URL`, `Download club data`) to `.btn-ghost`, leaving at most one solid primary per card. This changes destructive buttons everywhere in the app, not just this tab: audit `.btn-danger` call sites, including `.modal-actions button.btn-danger` (`:266`), which has the same bug.
2. **Theme the checkboxes and number inputs.** `appearance: none` plus a house tick and house spinners. ~20 lines.
3. **`.tool-row` gets vertical rhythm.** `+ .tool-row { margin-top: 10px }` — fixes §1.4 in one declaration.
4. **Two columns for settings forms at ≥640px.** A grid so short fields pair up instead of leaving 480px of felt.
5. **The calendar URL becomes a copy-field** — readonly `input` plus a copy button, monospace, no italic parent.
6. **Pick one save contract per card and label it.** Recommend: keep instant-save where it is (it's better), and for the two batched cards add a "Save" that enables only when something changed, so the button's state says whether there's anything unsaved.
7. **Verify every `var(--x)` used exists**, and don't pair `--card` with `--ink` — both are cream (CLAUDE.md → Gotchas → UI). All three UI gotchas in that file shipped because CSS was written against unverified tokens.

---

## 5. Mobile

Not measured yet — everything above is from a 1288px viewport. Before implementing §3.2, check the sub-nav at 390px: it must not become a second horizontally scrolling strip stacked under the first, under a top-level strip that *already* scrolls (`index.html:946`). Four pills may fit at 390px; five would not have. Measure before choosing, and keep the `<select>` fallback in reserve for narrow viewports rather than assuming it away.

---

## 6. What this deliberately does not include

- **No schema or edge-function change.** Every overview number comes from state `loadAll` already fetched, and §3.5 relocates markup only — the scheduler calls the same `callAdmin` actions with the same payloads from its new home. If a proposed stat needs a new query, drop the stat; a dashboard is not worth a round trip on every tab open.
- **No change to the top-level tab bar.** §2.4 is a real observation about eight tabs and a scrolling strip, but consolidating them is separate work with its own blast radius.
- **The four controls in §3.6.** Decided, not overlooked — that section is the record.
- **No new dependency, no build step, no framework.** Same constraint as the rest of the file.
- **No bulk member actions, no audit log, no analytics.** None has been asked for.

---

## 7. Sequence

| Step | Scope | Notes |
|---|---|---|
| **A** | §4 — danger buttons, native controls, `.tool-row` spacing, copy-field, two-column forms | Self-contained CSS plus small markup edits. Ships alone, fixes most of the "amateur" complaint, no routing risk. |
| **B** | §3.1 — rename to Librarian dashboard | Includes `index.html:5586`. Route segment unchanged. |
| **C** | §3.2 + §3.4 — sub-sections, collapsed config | The routing change. `parseRoute` + `goToTab` + regrouping the existing cards. No new features, so it's testable by "is everything still reachable." |
| **D** | §3.5 — move the meeting scheduler in, fix its zone labels | Markup-only; the handlers are wired by document-wide `querySelectorAll` and don't move. Needs C landed so Overview exists to hold it. The `clubTz()` fix rides along. |
| **E** | §3.3 — the Overview | Last: the only step that adds anything new, and the only one that can strand the page on the boot placeholder (§3.3's guard). One attention row points at D's scheduler, so D first. |

**A and D are independently shippable.** If this stalls after A, the tab still looks materially better; if it stalls after D, Calendar is cleaner and the zone labels have stopped lying. Only C→E are a chain.

## 8. Verification this owes

- `node --test tests/*.test.mjs supabase/functions/_shared/*.test.mjs` — the client tests slice logic out of `index.html` at run time, so a structural edit can break them.
- A route test for `#/c/<slug>/admin/<section>`: each section resolves, an unknown section falls back to `overview`, and the older two-segment `#/c/<slug>/admin` still lands on the tab.
- **The scheduler exercised end to end from its new home** — save a meeting, add an extra phase, remove one, announce in Discord. These are `callAdmin` writes against live club state, and a handler that silently didn't get rewired looks identical to one that did until you press it. Check specifically that an **extra phase keeps its existing `key`**: `calendar-feed` builds each event's `UID` from it, and regenerating one makes every subscriber's calendar duplicate the event (CLAUDE.md → Data model → `reads`).
- **The zone labels, on a club that isn't in Toronto.** Set `clubs.timezone` to something else and confirm the label follows `clubTz()`.
- **Confirm the member tabs are otherwise unchanged.** Signed in as a non-librarian: Calendar still shows the grid, upcoming/recent lists and subscribe box; Reading still shows the banner with its ratings controls intact for a librarian (§3.6 — nothing there was supposed to move).
- **Open the page.** Signed in as a librarian, at 1288px and 390px, in every sub-section, with the console visible. §1.3, §1.4 and §1.5 all shipped and survived because the tab was never actually looked at.
- Re-measure the total scroll height afterwards. Target: Overview and Readers each under two viewports.

---

## 9. What actually shipped

All five steps, in one change: `index.html`, plus `tests/client-librarian-dashboard.test.mjs` (new, 9 tests).

**Measured after.** The one 3,504px scroll is now four sections of **798px (Overview), 533px (Readers), 787px (Settings), 330px (Data)** — every one under 1.2 viewports, against a target of two. Settings holds more than it used to (it absorbed the selection-mode card) and is still 787px because the two heavyweight cards collapse to summary rows: *Rating rubric — Guild score · 5 categories out of 20 each · Edit*.

**Two things the plan got wrong.**

1. **§4.1 assumed demoting routine saves to `.btn-ghost` was needed for red to mean something.** Once `.btn-danger` was actually inverted (outlined, filling on hover), solid stamp read as "primary action here" on its own — the Data section's solid *Download club data* against outlined *Reset the shelf* / *Delete this club* has no ambiguity left. The `.btn-ghost` sweep was dropped as unnecessary churn across the rest of the app. Two buttons did move to ghost where they genuinely aren't primary: *Copy* on the calendar field, and the attention-list jump links.

2. **§3.3's guard note was right for the wrong reason.** The plan worried about the Overview's derived reads. The `TypeError` that actually got reintroduced was in **Settings**, from `clubConfig().notify` — the exact production incident CLAUDE.md documents, recreated verbatim while transcribing the old markup. It was caught by `tests/client-librarian-dashboard.test.mjs` before it shipped, not by inspection. `dashSettingsHtml()` now defaults `selection`/`rating`/`notify` at the point of use. **This does not close the underlying gap** — nothing still asserts the client and server copies of `normalizeConfig` agree. It only means the next drift breaks one card's defaults instead of stranding the page on `Pulling the ledger…`.

**A trap worth knowing about, found while writing the tests.** The slice in `client-librarian-dashboard.test.mjs` originally ran to the next big section marker and swallowed ~1,300 unrelated lines, including the real `ratingsOpen()` — which shadowed the stub and made an attention row silently not render, in a test that still passed. The slice now ends at `computeStats()` and asserts it hasn't widened. Any future test using this repo's slice-out-of-`index.html` technique wants the same guard.

**Verification run.** 110 offline tests pass (`node --test`), `deno check` clean on all seven edge functions, the app boots with no console errors, and every section was rendered and looked at — at 1288px and at 390px, where the four pills correctly hand over to the `<select>` with no horizontal overflow (`scrollWidth === clientWidth === 390`).

**Not yet done — needs a live librarian session.** The rendering was verified against a harness built from the real CSS and the real builders, driven with fixture data, because a local `python3 -m http.server` origin has no Supabase session. Still to exercise against production data, per §8: saving a meeting, adding and removing an extra phase (checking the `key` survives — `calendar-feed` builds each `UID` from it), announcing in Discord, and the zone labels on a club that isn't in Toronto.

// The librarian dashboard's render path.
//
// Same technique as client-identity.test.mjs -- the builders are sliced out of
// index.html at run time, so this tests what actually ships and fails loudly if
// they're renamed rather than passing against a stale copy.
//
// Why this exists at all: `app.innerHTML = html` happens ONCE, at the very end of
// render(). A TypeError anywhere while building that string means the assignment
// never runs, so the DOM keeps showing whatever the previous successful render
// left -- on a first load, the boot placeholder. A render-time crash therefore
// looks exactly like a hung network request, and the console is the only place
// the real error appears. That is precisely what the clubs.config normalizer
// drift did in production (CLAUDE.md -> Gotchas -> UI).
//
// The dashboard reads more derived, optional state than anything else on the
// page -- club config, club_secrets that arrive separately and are null until
// they land, an invite list, a rating profile, a rating scale, meetings that may
// or may not exist -- so it is the likeliest place for that failure to recur.
// These tests run each section against the states that actually occur, including
// the empty ones, and assert only that a string comes back.
//
// Run: node --test tests/client-librarian-dashboard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

// The slice has to stop at the end of the dashboard block. Taking it out to the
// next big section marker instead would swallow ~1,300 unrelated lines,
// including the real ratingsOpen(), which then silently shadows the stub below
// and makes these tests exercise a different code path than they claim to.
const START = "function librarianDashboardHtml(currentlyReading, nextUp)";
const END = "function computeStats()";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from !== -1, "could not find librarianDashboardHtml in index.html — was it renamed?");
assert.ok(to > from, "could not find the end of the dashboard block in index.html");
assert.ok(
  !/^function ratingsOpen/m.test(html.slice(from, to)),
  "the slice has widened past the dashboard block — it now shadows the stubs below",
);

// Everything the sliced block reaches for that lives elsewhere in the module.
// Deliberately minimal and dumb: the point is to exercise the builders' own
// control flow, not to re-implement the app.
function makeContext(over = {}) {
  const ctx = {
    esc: (s) => String(s ?? ""),
    attr: (s) => String(s ?? ""),
    clubName: () => "The Guild",
    clubTz: () => "America/Toronto",
    nowInClubTz: () => "3:00 pm",
    calendarFeedUrl: (t) => `https://example.test/feed?token=${t}`,
    readerHref: () => "#reader=x",
    isLibrarianId: (id) => id === "u1",
    tabHash: (id, sub) => (sub ? `#/c/the-guild/${id}/${sub}` : `#/c/the-guild/${id}`),
    inviteState: (i) => ({ dead: !!i.revoked, label: i.revoked ? "revoked" : "active" }),
    eligibleEntries: () => [],
    reviewsFor: () => [],
    ratingsOpen: () => false,
    allMeetings: () => [],
    nextBiweeklyWednesday: () => new Date("2026-09-02T20:00:00Z"),
    toClubInputValue: () => "2026-09-02T20:00",
    extraMeetingRowHtml: () => "<div></div>",
    ADMIN_SECTIONS: [
      { id: "overview", label: "Overview" },
      { id: "readers", label: "Readers" },
      { id: "settings", label: "Settings" },
      { id: "data", label: "Data" },
    ],
    RATING_SLOTS: ["plot", "characters", "pacing", "language", "themes"],
    RATING_SLOT_LABELS: {
      plot: "Plot", characters: "Characters", pacing: "Organization / Pacing",
      language: "Use of Language", themes: "Themes / Ideas",
    },
    COMMON_TIMEZONES: ["America/Toronto", "Europe/London"],
    currentSubTab: "overview",
    club: { name: "The Guild", tagline: "long live the revolution", visibility: "private", discord_guild_id: null },
    clubConfig: () => ({
      selection: { mode: "wheel", sitOut: true },
      rating: {
        scale: 20, scoreLabel: "Guild score",
        categories: [{ slot: "plot", label: "Plot" }, { slot: "themes", label: "Themes / Ideas" }],
      },
      notify: { draw: true, bookSet: false, meeting: true, rating: true, mentionWinner: true },
    }),
    clubSettings: { has_webhook: true, calendar_token: "tok" },
    invites: [],
    users: [],
    librarianIds: new Set(["u1"]),
    session: { user: { id: "u1" } },
    state: { history: [], eliminated: [], roundNumber: 1 },
  };
  Object.assign(ctx, over);
  vm.createContext(ctx);
  // The scheduler is defined above the slice; stub it so these tests stay
  // focused on the dashboard's own branching.
  vm.runInContext("function meetingSchedulerHtml(){ return '<div></div>'; }", ctx);
  vm.runInContext(html.slice(from, to), ctx);
  return ctx;
}

const SECTIONS = ["overview", "readers", "settings", "data"];

test("every section renders for a club in mid-flight", () => {
  const ctx = makeContext({
    users: [
      { id: "u1", discord_username: "adampugs", book: "The Third Policeman", avatar_url: "a.png" },
      { id: "u2", discord_username: "Alec", book: "", avatar_url: null },
    ],
    state: { history: [{ ts: "2026-01-01T00:00:00.000Z", book: "Superheavy", winner_username: "Keks", winner_id: "u2" }], eliminated: ["u2"], roundNumber: 17 },
    invites: [{ code: "J1A2K3TGS3C0", revoked: true, uses: 0 }],
  });
  for (const sec of SECTIONS) {
    ctx.currentSubTab = sec;
    const out = ctx.librarianDashboardHtml(null, []);
    assert.equal(typeof out, "string", `${sec} did not return a string`);
    assert.ok(out.length > 0, `${sec} rendered empty`);
  }
});

test("every section renders for a brand-new club with nothing in it", () => {
  const ctx = makeContext();
  for (const sec of SECTIONS) {
    ctx.currentSubTab = sec;
    const out = ctx.librarianDashboardHtml(null, []);
    assert.equal(typeof out, "string", `${sec} did not return a string`);
  }
});

// club_secrets arrives through club-admin's get_club_settings on a separate
// request, so clubSettings is null on the first render after a tab switch. The
// old markup handled that with a "…" ternary; the collapsed summary rows have to
// as well, and neither may read a field off null.
test("settings renders while club_secrets has not arrived yet", () => {
  const ctx = makeContext({ clubSettings: null, currentSubTab: "settings" });
  const out = ctx.librarianDashboardHtml(null, []);
  assert.ok(out.includes("Discord"), "the Discord card vanished when clubSettings was null");
});

test("overview renders while club_secrets has not arrived yet", () => {
  const ctx = makeContext({ clubSettings: null, currentSubTab: "overview" });
  assert.equal(typeof ctx.librarianDashboardHtml(null, []), "string");
});

// The failure that actually shipped: a key added to normalizeConfig server-side
// without the client copy, so clubConfig().notify was undefined and the Admin tab
// threw reading .draw off it, mid-render. The two copies are still maintained by
// hand, so the same drift can recur with the next key.
test("settings survives a config whose normalizer has drifted", () => {
  for (const cfg of [
    { selection: { mode: "wheel", sitOut: true }, rating: { scale: 20, scoreLabel: "s", categories: [] } }, // no notify
    { selection: { mode: "wheel", sitOut: true }, notify: {} },                                             // no rating
    {},                                                                                                     // nothing at all
  ]) {
    const ctx = makeContext({ clubConfig: () => cfg, currentSubTab: "settings" });
    // A drifted config must not take the page down. Keeping the two copies of
    // normalizeConfig in step is still the requirement; this only asserts the
    // blast radius when they aren't.
    let out, err = null;
    try { out = ctx.librarianDashboardHtml(null, []); } catch (e) { err = e; }
    assert.equal(err, null, `settings threw on a partial config: ${err && err.message}`);
    assert.equal(typeof out, "string");
  }
});

test("the sub-nav marks exactly one section active, and an unknown one falls back to overview", () => {
  const ctx = makeContext({ currentSubTab: "settings" });
  const out = ctx.librarianDashboardHtml(null, []);
  assert.equal((out.match(/aria-selected="true"/g) || []).length, 1);

  ctx.currentSubTab = "not-a-section";
  const fallback = ctx.librarianDashboardHtml(null, []);
  assert.ok(
    fallback.includes('data-subtab="overview"') && /aria-selected="true"[^>]*data-subtab="overview"|data-subtab="overview"[^>]*aria-selected="true"/.test(
      fallback.replace(/<button class="on"/g, '<button aria-selected="true"'),
    ) || fallback.includes("at a glance"),
    "an unknown sub-section did not fall back to overview",
  );
});

// Both are destructive and both were rendered in a colour identical to the
// routine save buttons until the dashboard rebuild.
test("the destructive actions carry the danger class, not the primary one", () => {
  const ctx = makeContext({ currentSubTab: "data" });
  const out = ctx.librarianDashboardHtml(null, []);
  for (const id of ["reset-btn", "delete-club-btn"]) {
    const m = out.match(new RegExp(`<button[^>]*id="${id}"`));
    assert.ok(m, `${id} is missing from the Data section`);
    assert.ok(/btn-danger/.test(m[0]), `${id} is not styled as destructive`);
  }
});

// ---- The route ----
// The dashboard's sub-section is the URL's optional third segment. "Optional"
// is the load-bearing word: two-segment #/c/<slug>/admin URLs are already
// bookmarked, and every tab the app has ever linked to is two-segment.
test("the route parses the dashboard's optional third segment", () => {
  const rFrom = html.indexOf("function parseRoute()");
  const rTo = html.indexOf("function tabHash(");
  assert.ok(rFrom !== -1 && rTo > rFrom, "could not find parseRoute in index.html");
  const ctx = { location: { hash: "" } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(rFrom, rTo), ctx);
  const at = (hash) => { ctx.location.hash = hash; return ctx.parseRoute(); };

  for (const sec of SECTIONS) {
    const r = at(`#/c/the-guild/admin/${sec}`);
    assert.equal(r.name, "main");
    assert.equal(r.clubSlug, "the-guild");
    assert.equal(r.tab, "admin");
    assert.equal(r.sub, sec, `#/c/the-guild/admin/${sec} did not resolve its sub-section`);
  }

  // The forms that predate sub-sections, which must keep working unchanged.
  const two = at("#/c/the-guild/admin");
  assert.equal(two.tab, "admin");
  assert.equal(two.sub, null, "a two-segment admin URL invented a sub-section");
  assert.equal(at("#/c/the-guild/reading").tab, "reading");
  assert.equal(at("#/c/the-guild/reading").sub, null);
  assert.equal(at("#/c/the-guild/").tab, null);
  assert.equal(at("#/c/the-guild").clubSlug, "the-guild");

  // Routes matched ahead of the club route must stay ahead of it.
  assert.equal(at("#/new").name, "new-club");
  assert.equal(at("#/account").name, "account");
  assert.equal(at("#/join/ABC123").name, "join");
  assert.equal(at("#book=3").name, "book");
  assert.equal(at("#recap=2026").name, "recap");
});

// Every control the old single-scroll Admin tab offered has to still be
// reachable somewhere in the new four sections -- a regrouping must not quietly
// drop a feature. Ids are what wireUp() binds to, so a missing one is a dead
// button, not just a missing card.
test("no control was lost in the regrouping", () => {
  const ctx = makeContext({
    // Both roles present: the per-reader menu renders "Make librarian" only for
    // a non-librarian and "Revoke librarian" only for someone else's librarian
    // row, so a single-user roster would silently skip half the hooks.
    users: [
      { id: "u1", discord_username: "adampugs", book: "A book", avatar_url: null },
      { id: "u2", discord_username: "Alec", book: "Carrie", avatar_url: null },
    ],
    state: { history: [{ ts: "2026-01-01T00:00:00.000Z", book: "Superheavy", winner_username: "Keks", winner_id: "u2" }], eliminated: [], roundNumber: 17 },
    invites: [{ code: "ABC", revoked: false, uses: 1 }],
  });
  let all = "";
  for (const sec of SECTIONS) { ctx.currentSubTab = sec; all += ctx.librarianDashboardHtml(null, []); }

  const ids = [
    "undo-btn", "cs-name", "cs-tagline", "cs-tz", "cs-public", "cs-save",
    "cs-sitout", "cs-score-label", "cs-rating-scale", "cs-rating-save",
    "rating-style-row", "cs-rating-simple-label",
    "cs-webhook", "cs-webhook-save", "cs-guild-id", "cs-guild-save",
    "cs-cal-copy", "cs-cal-rotate", "inv-new", "inv-max", "inv-days",
    "export-club-btn", "reset-btn", "delete-club-btn",
  ];
  for (const id of ids) assert.ok(all.includes(`id="${id}"`), `control "${id}" is no longer rendered anywhere`);

  const hooks = [
    "data-sel-mode=", "data-rating-slot=", "data-rating-label=", "data-notify-key=",
    "data-rating-style-btn=", "data-admin-editbook=", "data-admin-clear=",
    "data-admin-grant-lib=", "data-admin-remove=", "data-inv-copy=", "data-inv-revoke=",
  ];
  for (const h of hooks) assert.ok(all.includes(h), `handler hook "${h}" is no longer rendered anywhere`);
});

// The rating style picker (Rubric / Simple scale / Off) is derived, not
// stored: a rubric with exactly one active category *is* Simple scale, and
// config.rating.enabled === false is Off. Each state must render without
// throwing and mark the right button active -- this is the surface most
// likely to drift the way notify did (CLAUDE.md's drift note), since it's a
// third hand-maintained reading of the same normalizeRatingProfile shape.
test("the rating style picker reflects rubric/simple/off correctly", () => {
  const cases = [
    {
      name: "rubric",
      rating: { scale: 20, scoreLabel: "Guild score", categories: [{ slot: "plot", label: "Plot" }, { slot: "themes", label: "Themes" }] },
      activeBtn: "rubric",
    },
    {
      name: "simple scale",
      rating: { scale: 10, scoreLabel: "Club score", categories: [{ slot: "plot", label: "Overall" }] },
      activeBtn: "simple",
    },
    {
      name: "off",
      rating: { scale: 20, scoreLabel: "Club score", categories: [{ slot: "plot", label: "Plot" }], enabled: false },
      activeBtn: "off",
    },
  ];
  for (const c of cases) {
    const ctx = makeContext({
      currentSubTab: "settings",
      clubConfig: () => ({
        selection: { mode: "wheel", sitOut: true },
        rating: c.rating,
        notify: { draw: true, bookSet: true, meeting: true, rating: true, mentionWinner: true },
      }),
    });
    const out = ctx.librarianDashboardHtml(null, []);
    assert.ok(out.includes(`data-rating-style="${c.activeBtn}"`), `${c.name}: rating-style-row did not report "${c.activeBtn}"`);
    const activeBtnMatch = out.match(new RegExp(`<button[^>]*data-rating-style-btn="${c.activeBtn}"[^>]*>`));
    assert.ok(activeBtnMatch && /btn-primary/.test(activeBtnMatch[0]), `${c.name}: the ${c.activeBtn} button isn't shown as selected`);
  }
});

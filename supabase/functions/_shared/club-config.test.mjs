import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConfig,
  normalizeRatingProfile,
  validateSelectionPatch,
  validateRatingPatch,
  validateNotifyPatch,
  normalizeRatingTotal,
  SELECTION_MODES,
  RATING_SLOTS,
  NOTIFY_EVENTS,
} from "./club-config.mjs";

const DEFAULT_NOTIFY = { draw: true, bookSet: true, meeting: true, rating: true, mentionWinner: true };

const DEFAULT_RATING = {
  scale: 20,
  categories: [
    { slot: "plot", label: "Plot" },
    { slot: "characters", label: "Characters" },
    { slot: "pacing", label: "Organization / Pacing" },
    { slot: "language", label: "Use of Language" },
    { slot: "themes", label: "Themes / Ideas" },
  ],
  scoreLabel: "Club score",
  enabled: true,
};

// ---- normalizeConfig --------------------------------------------------------
// First assertion, per docs/configurability-plan.md §8: a club row that
// predates this feature (config = {}) must normalize to exactly today's
// behaviour. Every other case is secondary to this one holding.

test("normalizeConfig({}) is today's behaviour: wheel, sit-out on, five categories at scale 20, every notification on", () => {
  assert.deepEqual(normalizeConfig({}), {
    selection: { mode: "wheel", sitOut: true },
    rating: DEFAULT_RATING,
    notify: DEFAULT_NOTIFY,
  });
});

test("normalizeConfig(null/undefined) matches normalizeConfig({})", () => {
  assert.deepEqual(normalizeConfig(null), normalizeConfig({}));
  assert.deepEqual(normalizeConfig(undefined), normalizeConfig({}));
});

test("normalizeConfig passes through a valid selection mode", () => {
  assert.equal(normalizeConfig({ selection: { mode: "rotation" } }).selection.mode, "rotation");
  assert.equal(normalizeConfig({ selection: { mode: "pick" } }).selection.mode, "pick");
});

test("normalizeConfig falls back to wheel on an unknown mode rather than throwing", () => {
  assert.equal(normalizeConfig({ selection: { mode: "roulette" } }).selection.mode, "wheel");
});

test("normalizeConfig: only an explicit false turns sit-out off", () => {
  assert.equal(normalizeConfig({ selection: { sitOut: false } }).selection.sitOut, false);
  assert.equal(normalizeConfig({ selection: { sitOut: "off" } }).selection.sitOut, true);
  assert.equal(normalizeConfig({ selection: {} }).selection.sitOut, true);
});

test("normalizeConfig ignores garbage shapes instead of throwing", () => {
  assert.deepEqual(normalizeConfig("not an object"), normalizeConfig({}));
  assert.deepEqual(normalizeConfig({ selection: "not an object either" }), normalizeConfig({}));
});

// ---- validateSelectionPatch --------------------------------------------------

test("validateSelectionPatch accepts a known mode", () => {
  assert.deepEqual(validateSelectionPatch({ mode: "pick" }), { selection: { mode: "pick" } });
});

test("validateSelectionPatch rejects an unknown mode, naming the real options", () => {
  const v = validateSelectionPatch({ mode: "roulette" });
  assert.ok("error" in v);
  for (const m of SELECTION_MODES) assert.ok(v.error.includes(m));
});

test("validateSelectionPatch accepts a boolean sitOut and rejects anything else", () => {
  assert.deepEqual(validateSelectionPatch({ sitOut: false }), { selection: { sitOut: false } });
  assert.ok("error" in validateSelectionPatch({ sitOut: "false" }));
});

test("validateSelectionPatch with neither field returns an empty patch, not an error", () => {
  assert.deepEqual(validateSelectionPatch({}), { selection: {} });
});

// ---- normalizeRatingProfile (Phase 10, §3) -----------------------------------

test("normalizeRatingProfile({}) matches normalizeConfig({}).rating", () => {
  assert.deepEqual(normalizeRatingProfile({}), DEFAULT_RATING);
  assert.deepEqual(normalizeRatingProfile(undefined), DEFAULT_RATING);
});

test("normalizeRatingProfile keeps a valid partial category set, in the order given", () => {
  const p = normalizeRatingProfile({ categories: [{ slot: "themes", label: "Vibes" }, { slot: "plot", label: "Plot" }] });
  assert.deepEqual(p.categories, [{ slot: "themes", label: "Vibes" }, { slot: "plot", label: "Plot" }]);
  assert.equal(p.scale, 20);
});

test("normalizeRatingProfile drops unknown slots and de-dupes repeats", () => {
  const p = normalizeRatingProfile({
    categories: [{ slot: "plot", label: "Plot" }, { slot: "vibes", label: "Vibes" }, { slot: "plot", label: "Again" }],
  });
  assert.deepEqual(p.categories, [{ slot: "plot", label: "Plot" }]);
});

test("normalizeRatingProfile falls back to all five when the category list is empty or garbage", () => {
  assert.deepEqual(normalizeRatingProfile({ categories: [] }).categories, DEFAULT_RATING.categories);
  assert.deepEqual(normalizeRatingProfile({ categories: "nope" }).categories, DEFAULT_RATING.categories);
});

test("normalizeRatingProfile: a category with no/blank label gets its canonical default", () => {
  const p = normalizeRatingProfile({ categories: [{ slot: "plot", label: "  " }] });
  assert.equal(p.categories[0].label, "Plot");
});

test("normalizeRatingProfile clamps scale to 2..20, defaulting to 20", () => {
  assert.equal(normalizeRatingProfile({ scale: 1 }).scale, 20);
  assert.equal(normalizeRatingProfile({ scale: 25 }).scale, 20);
  assert.equal(normalizeRatingProfile({ scale: 10 }).scale, 10);
  assert.equal(normalizeRatingProfile({ scale: "10" }).scale, 20); // not an integer type -- rejected, not coerced
});

test("normalizeRatingProfile: only a non-blank string overrides the score label", () => {
  assert.equal(normalizeRatingProfile({ scoreLabel: "Guild score" }).scoreLabel, "Guild score");
  assert.equal(normalizeRatingProfile({ scoreLabel: "   " }).scoreLabel, "Club score");
  assert.equal(normalizeRatingProfile({}).scoreLabel, "Club score");
});

test("normalizeRatingProfile: only an explicit false turns ratings off", () => {
  assert.equal(normalizeRatingProfile({}).enabled, true);
  assert.equal(normalizeRatingProfile({ enabled: false }).enabled, false);
  assert.equal(normalizeRatingProfile({ enabled: "off" }).enabled, true); // not a real false -- stays on
  assert.equal(normalizeRatingProfile({ enabled: true }).enabled, true);
});

// A locked read's profile snapshot (admin_set_rating) is built from scale +
// categories only, never scoring while ratings were off is the only way a
// read gets scored at all, so re-normalizing that snapshot must always land
// back on enabled: true regardless of the club's *current* live setting.
test("normalizeRatingProfile: a locked read's snapshot (no enabled key) always re-normalizes to enabled true", () => {
  const snapshot = { scale: 10, categories: [{ slot: "plot", label: "Overall" }] };
  assert.equal(normalizeRatingProfile(snapshot).enabled, true);
});

// ---- validateRatingPatch ------------------------------------------------------

test("validateRatingPatch accepts a valid categories patch, in order", () => {
  const v = validateRatingPatch({ categories: [{ slot: "plot", label: "Plot" }, { slot: "pacing", label: "Pace" }] });
  assert.deepEqual(v, { rating: { categories: [{ slot: "plot", label: "Plot" }, { slot: "pacing", label: "Pace" }] } });
});

test("validateRatingPatch rejects an empty category list", () => {
  assert.ok("error" in validateRatingPatch({ categories: [] }));
});

test("validateRatingPatch rejects an unknown slot", () => {
  const v = validateRatingPatch({ categories: [{ slot: "vibes", label: "Vibes" }] });
  assert.ok("error" in v);
});

test("validateRatingPatch rejects a duplicate slot", () => {
  const v = validateRatingPatch({ categories: [{ slot: "plot", label: "A" }, { slot: "plot", label: "B" }] });
  assert.ok("error" in v);
});

test("validateRatingPatch rejects a blank label", () => {
  const v = validateRatingPatch({ categories: [{ slot: "plot", label: "  " }] });
  assert.ok("error" in v);
});

test("validateRatingPatch validates scale range", () => {
  assert.deepEqual(validateRatingPatch({ scale: 10 }), { rating: { scale: 10 } });
  assert.ok("error" in validateRatingPatch({ scale: 1 }));
  assert.ok("error" in validateRatingPatch({ scale: 25 }));
});

test("validateRatingPatch validates scoreLabel length and blankness", () => {
  assert.deepEqual(validateRatingPatch({ scoreLabel: "Guild score" }), { rating: { scoreLabel: "Guild score" } });
  assert.ok("error" in validateRatingPatch({ scoreLabel: "" }));
  assert.ok("error" in validateRatingPatch({ scoreLabel: "x".repeat(41) }));
});

test("validateRatingPatch with nothing set returns an empty patch, not an error", () => {
  assert.deepEqual(validateRatingPatch({}), { rating: {} });
});

test("validateRatingPatch accepts a boolean enabled and rejects anything else", () => {
  assert.deepEqual(validateRatingPatch({ enabled: false }), { rating: { enabled: false } });
  assert.deepEqual(validateRatingPatch({ enabled: true }), { rating: { enabled: true } });
  assert.ok("error" in validateRatingPatch({ enabled: "false" }));
});

// { enabled: false } alone must be a valid, complete patch on its own -- the
// Settings UI sends exactly this for "Off" so it doesn't overwrite
// categories/scale/scoreLabel just because ratings are off right now.
test("an enabled-only patch doesn't require or touch categories", () => {
  assert.deepEqual(validateRatingPatch({ enabled: false }), { rating: { enabled: false } });
});

// ---- normalizeRatingTotal (the /100 normalization, §3 point 2) --------------

test("normalizeRatingTotal is bit-identical to the old sum-of-five formula at the default profile", () => {
  // Five categories at scale 20: summing them was always secretly /100.
  assert.equal(normalizeRatingTotal([20, 20, 20, 20, 20], 20), 100);
  assert.equal(normalizeRatingTotal([1, 1, 1, 1, 1], 20), 5);
  assert.equal(normalizeRatingTotal([16, 13, 8, 3, 10], 20), 50);
});

test("normalizeRatingTotal generalizes to fewer categories or a different scale", () => {
  assert.equal(normalizeRatingTotal([10], 10), 100); // one category, maxed out at its own scale
  assert.equal(normalizeRatingTotal([5], 10), 50);
  assert.equal(normalizeRatingTotal([8, 8, 8], 10), 80); // three categories at scale 10
});

test("normalizeRatingTotal returns null for no categories or no scale", () => {
  assert.equal(normalizeRatingTotal([], 20), null);
  assert.equal(normalizeRatingTotal([10], 0), null);
});

test("RATING_SLOTS lists exactly the five physical shelf_reviews columns", () => {
  assert.deepEqual(RATING_SLOTS, ["plot", "characters", "pacing", "language", "themes"]);
});

// ---- notify (Phase 11, §4.2) -------------------------------------------------

test("normalizeConfig({}).notify is every event on", () => {
  assert.deepEqual(normalizeConfig({}).notify, DEFAULT_NOTIFY);
});

test("normalizeConfig: only an explicit false turns an event off, per key", () => {
  const cfg = normalizeConfig({ notify: { draw: false, mentionWinner: false } });
  assert.deepEqual(cfg.notify, { draw: false, bookSet: true, meeting: true, rating: true, mentionWinner: false });
});

test("normalizeConfig notify ignores a non-boolean or unknown key instead of throwing", () => {
  assert.deepEqual(normalizeConfig({ notify: { draw: "no", vibes: false } }).notify, DEFAULT_NOTIFY);
});

test("validateNotifyPatch accepts booleans for known events", () => {
  assert.deepEqual(validateNotifyPatch({ draw: false }), { notify: { draw: false } });
  assert.deepEqual(validateNotifyPatch({ draw: false, rating: true }), { notify: { draw: false, rating: true } });
});

test("validateNotifyPatch rejects a non-boolean value", () => {
  assert.ok("error" in validateNotifyPatch({ draw: "false" }));
});

test("validateNotifyPatch ignores unknown keys rather than erroring", () => {
  assert.deepEqual(validateNotifyPatch({ vibes: false }), { notify: {} });
});

test("validateNotifyPatch with nothing set returns an empty patch, not an error", () => {
  assert.deepEqual(validateNotifyPatch({}), { notify: {} });
});

test("NOTIFY_EVENTS lists the five toggles", () => {
  assert.deepEqual(NOTIFY_EVENTS, ["draw", "bookSet", "meeting", "rating", "mentionWinner"]);
});

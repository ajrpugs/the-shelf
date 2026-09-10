// Non-fiction reads (docs/nonfiction-rubric-plan.md): reads.kind picks the
// rubric a read is scored under. The load-bearing rule is the same as the rest
// of club-config.mjs -- an absent kind must mean exactly today's behaviour.
//
// Run: node --test supabase/functions/_shared/read-kind.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConfig,
  normalizeReadKind,
  ratingProfileForKind,
  NONFICTION_RATING_CATEGORIES,
  READ_KINDS,
  RATING_SLOTS,
} from "./club-config.mjs";

test("normalizeReadKind: only 'nonfiction' is non-fiction; null, absent and garbage are fiction", () => {
  assert.equal(normalizeReadKind("nonfiction"), "nonfiction");
  for (const raw of [null, undefined, "", "fiction", "Nonfiction", "non-fiction", 1, {}]) {
    assert.equal(normalizeReadKind(raw), "fiction", `for ${JSON.stringify(raw)}`);
  }
});

test("READ_KINDS is exactly what the reads_kind_chk constraint allows", () => {
  assert.deepEqual(READ_KINDS, ["fiction", "nonfiction"]);
});

test("a fiction read (or one with no kind) gets the club's own rubric, untouched", () => {
  const custom = { scale: 10, categories: [{ slot: "plot", label: "Story" }, { slot: "themes", label: "Vibes" }], scoreLabel: "Guild score" };
  for (const kind of [null, undefined, "fiction"]) {
    assert.deepEqual(ratingProfileForKind(custom, kind), normalizeConfig({ rating: custom }).rating);
    assert.deepEqual(ratingProfileForKind(undefined, kind), normalizeConfig({}).rating);
  }
});

test("a non-fiction read gets the five non-fiction categories, in slot order", () => {
  const p = ratingProfileForKind(undefined, "nonfiction");
  assert.deepEqual(p.categories, [
    { slot: "plot", label: "Engagement" },
    { slot: "characters", label: "Clarity" },
    { slot: "pacing", label: "Structure & Pacing" },
    { slot: "language", label: "Voice & Prose" },
    { slot: "themes", label: "Insight & Credibility" },
  ]);
  assert.deepEqual(p.categories.map(c => c.slot), RATING_SLOTS);
});

test("non-fiction keeps the club's scale and score label, but always runs all five slots", () => {
  const club = { scale: 10, categories: [{ slot: "plot", label: "Story" }], scoreLabel: "Guild score" };
  const p = ratingProfileForKind(club, "nonfiction");
  assert.equal(p.scale, 10);
  assert.equal(p.scoreLabel, "Guild score");
  assert.equal(p.categories.length, 5);
});

test("at the Guild's config, a non-fiction total is on the same /100 footing as fiction", () => {
  // Same five slots at scale 20 either way -- which is what lets the two
  // leaderboards (and the combined recap/reader averages) use one band scale.
  const guild = normalizeConfig({ rating: { scoreLabel: "Guild score" } }).rating;
  const nf = ratingProfileForKind(guild, "nonfiction");
  assert.equal(nf.scale, guild.scale);
  assert.equal(nf.categories.length, guild.categories.length);
});

test("non-fiction inherits the club's ratings on/off switch", () => {
  assert.equal(ratingProfileForKind(undefined, "nonfiction").enabled, true);
  assert.equal(ratingProfileForKind({ enabled: false }, "nonfiction").enabled, false);
});

test("non-fiction never inherits the club's fiction band overrides", () => {
  const club = { categories: [{ slot: "plot", label: "Story", bands: { exc: "custom" } }] };
  for (const c of ratingProfileForKind(club, "nonfiction").categories) assert.equal(c.bands, undefined);
});

test("ratingProfileForKind never hands back the shared constant (callers can't mutate it)", () => {
  const p = ratingProfileForKind(undefined, "nonfiction");
  p.categories[0].label = "mutated";
  assert.equal(NONFICTION_RATING_CATEGORIES[0].label, "Engagement");
});

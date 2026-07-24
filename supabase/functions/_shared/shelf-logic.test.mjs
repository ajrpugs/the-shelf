import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickEligible,
  advanceIfEmpty,
  rollbackUndo,
  clampRatingTotal,
  clampCategoryScore,
  buildMeeting,
} from "./shelf-logic.mjs";

// ---- pickEligible --------------------------------------------------------

test("pickEligible excludes eliminated readers", () => {
  const readers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const { eligible, chosen } = pickEligible(readers, ["a"]);
  assert.deepEqual(eligible.map(u => u.id), ["b", "c"]);
  assert.ok(["b", "c"].includes(chosen.id));
});

test("pickEligible throws when nobody is eligible", () => {
  const readers = [{ id: "a" }, { id: "b" }];
  assert.throws(() => pickEligible(readers, ["a", "b"]), /no eligible readers/);
});

test("pickEligible throws on an empty reader list", () => {
  assert.throws(() => pickEligible([], []), /no eligible readers/);
});

// ---- advanceIfEmpty -------------------------------------------------------

test("advanceIfEmpty fires only when the pick emptied a pool of exactly one", () => {
  assert.equal(advanceIfEmpty(1), true);
  assert.equal(advanceIfEmpty(2), false);
  assert.equal(advanceIfEmpty(5), false);
});

// ---- rollbackUndo ----------------------------------------------------------

test("rollbackUndo: undoing a normal pick removes it from eliminated", () => {
  const result = rollbackUndo(
    [{ round: 2, winner_id: "x" }],           // historyAfterShift
    ["y", "z"],                                // eliminated (before removing z)
    2,                                          // roundNumber
    { round: 2, winner_id: "z" },              // last (the undone pick)
  );
  assert.deepEqual(result, { roundNumber: 2, eliminated: ["y"] });
});

test("rollbackUndo: undoing a round-advancing pick rolls the round back", () => {
  // Round 3 has just started (empty so far); the pick that advanced to round 3
  // was the last entry of round 2 and is being undone.
  const historyAfterShift = [
    { round: 2, winner_id: "b" },
    { round: 2, winner_id: "a" },
  ];
  const result = rollbackUndo(
    historyAfterShift,
    [],           // eliminated is empty because round 3 just started
    3,            // roundNumber (already advanced)
    { round: 2, winner_id: "c" },
  );
  assert.equal(result.roundNumber, 2);
  // Rebuilt from whoever else was picked in round 2.
  assert.deepEqual(new Set(result.eliminated), new Set(["b", "a"]));
});

test("rollbackUndo: last pick with no winner_id leaves eliminated untouched", () => {
  const result = rollbackUndo([], ["y"], 2, { round: 2, winner_id: null });
  assert.deepEqual(result, { roundNumber: 2, eliminated: ["y"] });
});

// ---- clampRatingTotal ------------------------------------------------------

test("clampRatingTotal clamps into 0..100", () => {
  assert.equal(clampRatingTotal(-5), 0);
  assert.equal(clampRatingTotal(150), 100);
  assert.equal(clampRatingTotal(0), 0);
  assert.equal(clampRatingTotal(100), 100);
  assert.equal(clampRatingTotal(42.6), 43);
});

test("clampRatingTotal throws on non-numeric input", () => {
  assert.throws(() => clampRatingTotal("abc"), /total must be a number/);
  assert.throws(() => clampRatingTotal(NaN), /total must be a number/);
});

// ---- clampCategoryScore -----------------------------------------------------

test("clampCategoryScore clamps into 1..20", () => {
  assert.equal(clampCategoryScore(0), 1);
  assert.equal(clampCategoryScore(25), 20);
  assert.equal(clampCategoryScore(1), 1);
  assert.equal(clampCategoryScore(20), 20);
});

test("clampCategoryScore returns undefined (not throw) on bad input", () => {
  assert.equal(clampCategoryScore("nope"), undefined);
  assert.equal(clampCategoryScore(undefined), undefined);
});

// ---- buildMeeting -----------------------------------------------------------

test("buildMeeting returns undefined for empty/blank input (clears the phase)", () => {
  assert.equal(buildMeeting("", ""), undefined);
  assert.equal(buildMeeting("   ", ""), undefined);
  assert.equal(buildMeeting(undefined, undefined), undefined);
});

test("buildMeeting parses a valid date and preserves upTo", () => {
  const m = buildMeeting("2026-08-05T20:00:00.000Z", "Chapter 12");
  assert.equal(m.at, "2026-08-05T20:00:00.000Z");
  assert.equal(m.upTo, "Chapter 12");
});

test("buildMeeting omits upTo when blank", () => {
  const m = buildMeeting("2026-08-05T20:00:00.000Z", "");
  assert.equal(m.at, "2026-08-05T20:00:00.000Z");
  assert.equal("upTo" in m, false);
});

test("buildMeeting throws on an unparsable date", () => {
  assert.throws(() => buildMeeting("not a date", ""), /invalid meeting date/);
});

test("buildMeeting truncates an overlong upTo to 200 chars", () => {
  const long = "x".repeat(250);
  const m = buildMeeting("2026-08-05T20:00:00.000Z", long);
  assert.equal(m.upTo.length, 200);
});

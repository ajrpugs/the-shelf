import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, validateSelectionPatch, SELECTION_MODES } from "./club-config.mjs";

// ---- normalizeConfig --------------------------------------------------------
// First assertion, per docs/configurability-plan.md §8: a club row that
// predates this feature (config = {}) must normalize to exactly today's
// behaviour. Every other case is secondary to this one holding.

test("normalizeConfig({}) is today's behaviour: wheel, sit-out on", () => {
  assert.deepEqual(normalizeConfig({}), { selection: { mode: "wheel", sitOut: true } });
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

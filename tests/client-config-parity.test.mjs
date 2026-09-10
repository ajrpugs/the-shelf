// The client's clubs.config normalizers must agree with the server's.
//
// index.html can't import supabase/functions/_shared/club-config.mjs (a
// Deno-side module), so it carries its own copy of normalizeConfig and
// friends. The two have drifted in production before: `notify` landed
// server-side only, clubConfig().notify was undefined, and the Admin tab threw
// mid-render, leaving the page stuck on "Pulling the ledger…" (CLAUDE.md ->
// Gotchas -> Multi-club). Nothing asserted the copies agreed; this does.
//
// The client block is sliced out of index.html at run time, so this tests what
// actually ships and fails loudly if the block is moved or renamed.
//
// Run: node --test tests/client-config-parity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import * as server from "../supabase/functions/_shared/club-config.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

const START = "const SELECTION_MODES = [";
const END = "const clubConfig = () =>";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from !== -1, "could not find the client config block (SELECTION_MODES) in index.html");
assert.ok(to > from, "could not find the end of the client config block (clubConfig) in index.html");

const client = vm.runInNewContext(
  html.slice(from, to) +
  "\n;({ normalizeConfig, normalizeRatingProfile, normalizeReadKind, ratingProfileForKind, NONFICTION_RATING_CATEGORIES, RATING_SLOTS, SELECTION_MODES, NOTIFY_EVENTS });",
  {},
);

// Objects built inside the vm have that realm's prototypes, which deepStrictEqual
// counts as a difference. Compare plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Configs that actually occur: an empty/predating row, garbage, each key
// partly set, and the fully-customised case.
const CONFIGS = [
  undefined, null, {}, "garbage", [],
  { selection: { mode: "rotation" } },
  { selection: { mode: "nonsense", sitOut: "no" } },
  { selection: { mode: "pick", sitOut: false } },
  { rating: { scoreLabel: "Guild score" } },
  { rating: { scale: 10, categories: [{ slot: "plot", label: "Story" }, { slot: "themes" }] } },
  { rating: { scale: 99, categories: [{ slot: "bogus" }, { slot: "plot" }, { slot: "plot", label: "Dup" }] } },
  { rating: { categories: [] } },
  { rating: { enabled: false } },
  { rating: { enabled: "no" } },
  { rating: { categories: [{ slot: "plot", label: "Story", bands: { exc: "  Gripping  ", bad: "", nope: "x" } }, { slot: "themes", bands: "garbage" }] } },
  { notify: { draw: false, mentionWinner: false } },
  { notify: { draw: "false", unknown: false } },
  {
    selection: { mode: "rotation", sitOut: false },
    rating: { scale: 5, scoreLabel: "  Vibes  ", categories: [{ slot: "language", label: "Words" }] },
    notify: { bookSet: false },
  },
];

test("the shared constants match", () => {
  assert.deepEqual(plain(client.RATING_SLOTS), server.RATING_SLOTS);
  assert.deepEqual(plain(client.SELECTION_MODES), server.SELECTION_MODES);
  assert.deepEqual(plain(client.NOTIFY_EVENTS), server.NOTIFY_EVENTS);
  assert.deepEqual(plain(client.NONFICTION_RATING_CATEGORIES), server.NONFICTION_RATING_CATEGORIES);
});

test("normalizeConfig agrees for every config shape that occurs", () => {
  for (const cfg of CONFIGS) {
    assert.deepEqual(plain(client.normalizeConfig(cfg)), plain(server.normalizeConfig(cfg)), `for ${JSON.stringify(cfg)}`);
  }
});

test("normalizeRatingProfile agrees, including on a locked read's snapshot", () => {
  for (const cfg of CONFIGS) {
    const raw = cfg && typeof cfg === "object" ? cfg.rating : cfg;
    assert.deepEqual(plain(client.normalizeRatingProfile(raw)), plain(server.normalizeRatingProfile(raw)), `for ${JSON.stringify(raw)}`);
  }
});

test("normalizeReadKind and ratingProfileForKind agree for every kind", () => {
  for (const kind of [undefined, null, "", "fiction", "nonfiction", "Nonfiction", 7]) {
    assert.equal(client.normalizeReadKind(kind), server.normalizeReadKind(kind));
    for (const cfg of CONFIGS) {
      const rating = cfg && typeof cfg === "object" ? cfg.rating : undefined;
      assert.deepEqual(
        plain(client.ratingProfileForKind(rating, kind)),
        plain(server.ratingProfileForKind(rating, kind)),
        `for kind ${JSON.stringify(kind)} and ${JSON.stringify(rating)}`,
      );
    }
  }
});

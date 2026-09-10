// Non-fiction reads, client side (docs/nonfiction-rubric-plan.md): each read
// is shown and totalled under its own rubric, and a read only competes for
// "Top rated" / "Lowest rated" against reads of the same kind.
//
// Same technique as the other client tests: the real functions are sliced out
// of index.html at run time and run in a vm against minimal stubs.
//
// Run: node --test tests/client-read-kind.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

function sliceBetween(start, end) {
  const from = html.indexOf(start);
  assert.ok(from !== -1, `could not find ${JSON.stringify(start)} in index.html — was it renamed?`);
  const to = html.indexOf(end, from);
  assert.ok(to > from, `could not find the end of ${JSON.stringify(start)} in index.html`);
  return html.slice(from, to);
}
// A top-level `function name(...) {...}` up to its closing brace at column 0.
const fn = (name) => sliceBetween(`function ${name}(`, "\n}\n") + "\n}\n";

const source = [
  sliceBetween("const SELECTION_MODES = [", "const clubConfig = () =>"),
  fn("normalizeTotal"),
  sliceBetween("const RUBRIC_ALL = [", "\n];\n") + "\n];\n",
  // RUBRIC / RATING_SCALE / SCORE_LABEL are module lets in index.html; the
  // sliced refreshRubric() assigns them from the club's config.
  "let RUBRIC = RUBRIC_ALL; let RATING_SCALE = 20; let SCORE_LABEL = 'Club score';",
  "let club = null; let state = { history: [] }; let reviews = [];",
  "const clubConfig = () => normalizeConfig(club?.config);",
  fn("refreshRubric"),
  sliceBetween("const RUBRIC_NONFICTION = [", "function kindTagHtml(") + fn("kindTagHtml"),
  fn("ratingTotal"),
  fn("reviewTotal"),
  fn("bookBadges"),
  `;({
    setClub(c) { club = c; refreshRubric(); },
    setHistory(h) { state = { history: h }; },
    setReviews(r) { reviews = r; },
    rubricForRead, reviewTotal, bookBadges, kindTagHtml, readKind,
  });`,
].join("\n");

function load(config = {}) {
  const app = vm.runInNewContext(source, {});
  app.setClub({ config });
  return app;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test("a fiction read (no kind) is shown under the club's own rubric, as before", () => {
  const app = load({ rating: { scoreLabel: "Guild score" } });
  const { rubric, scale, kind } = app.rubricForRead({ ts: "a" });
  assert.equal(kind, "fiction");
  assert.equal(scale, 20);
  assert.deepEqual(plain(rubric.map(r => r.label)), ["Plot", "Characters", "Organization / Pacing", "Use of Language", "Themes / Ideas"]);
  assert.match(rubric[0].bands.exc, /story/);
});

test("a non-fiction read gets the non-fiction labels and its own scoring guidance", () => {
  const app = load();
  const { rubric, scale, kind } = app.rubricForRead({ ts: "b", kind: "nonfiction" });
  assert.equal(kind, "nonfiction");
  assert.equal(scale, 20);
  assert.deepEqual(plain(rubric.map(r => [r.key, r.label, r.short])), [
    ["plot", "Engagement", "Engagement"],
    ["characters", "Clarity", "Clarity"],
    ["pacing", "Structure & Pacing", "Structure"],
    ["language", "Voice & Prose", "Voice"],
    ["themes", "Insight & Credibility", "Insight"],
  ]);
  for (const r of rubric) {
    for (const band of ["exc", "great", "good", "bad"]) assert.ok(r.bands[band], `${r.key} is missing its ${band} guidance`);
  }
  assert.doesNotMatch(rubric[0].bands.exc, /story|novel/i);
});

test("a review is totalled under its own read's rubric", () => {
  // A club scoring fiction on two categories at scale 10: a fiction review
  // totals over those two; a non-fiction review totals over all five.
  const app = load({ rating: { scale: 10, categories: [{ slot: "plot", label: "Story" }, { slot: "themes", label: "Ideas" }] } });
  app.setHistory([{ ts: "f" }, { ts: "n", kind: "nonfiction" }]);
  const scores = { plot: 10, characters: 0, pacing: 0, language: 0, themes: 10 };
  assert.equal(app.reviewTotal({ book_ts: "f", ...scores }), 100);
  assert.equal(app.reviewTotal({ book_ts: "n", ...scores }), 40);
});

test("top/lowest-rated badges only compare reads of the same kind", () => {
  const app = load();
  const history = [
    { ts: "f1", rating: { total: 90 } },
    { ts: "f2", rating: { total: 40 } },
    { ts: "n1", kind: "nonfiction", rating: { total: 20 } },
  ];
  app.setHistory(history);
  const labels = (h) => plain(app.bookBadges(h)).map(b => b.label);
  assert.deepEqual(labels(history[0]), ["Top rated"]);
  assert.deepEqual(labels(history[1]), ["Lowest rated"]);
  // The only non-fiction read: no badge, rather than "Lowest rated" among novels.
  assert.deepEqual(labels(history[2]), []);
});

test("only a non-fiction read carries the tag", () => {
  const app = load();
  assert.equal(app.kindTagHtml({ kind: "fiction" }), "");
  assert.equal(app.kindTagHtml({}), "");
  assert.match(app.kindTagHtml({ kind: "nonfiction" }), /Non-fiction/);
});

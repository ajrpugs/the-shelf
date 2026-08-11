// Phase 8: the seeded club must not leak into everyone else's.
//
// Three defects shipped in Phases 4-7 and were invisible because only one club
// existed. Each would have fired on the second one. None of the three is
// reachable by a unit test in the ordinary sense -- two live inside Deno edge
// functions that need a request, a JWT and a service-role key, and the third is
// a string in a render function. So these are *source* assertions: they read the
// files that ship and fail if the old shape comes back.
//
// That is a weaker guarantee than executing the code, and worth stating plainly:
// these tests prove the fallback is absent, not that the replacement behaves. The
// behavioural half is supabase/tests/rls-isolation.test.mjs, which asks the live
// database what a fresh club actually resolves.
//
// Run: node --test tests/tenant-correctness.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fn = (name) => readFileSync(join(repoRoot, "supabase/functions", name, "index.ts"), "utf8");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

// The three functions that carry their own copy of webhookFor + the Discord
// embed helpers. CLAUDE.md's rule is that a change to one is a change to all
// three; this list is what makes "all three" checkable.
const WEBHOOK_FUNCTIONS = ["admin-update", "set-book", "discord-interactions"];

// The four club-scoped functions whose club_id became required. calendar-feed and
// discord-interactions are deliberately excluded: a tokenless feed URL predates
// the token and must keep resolving, and a slash command carries a guild and a
// Discord user but never a club.
const CLUB_SCOPED_FUNCTIONS = ["admin-update", "set-book", "set-review", "post-comment"];

test("no copy of webhookFor falls back to the project-wide webhook secret", async (t) => {
  for (const name of WEBHOOK_FUNCTIONS) {
    await t.test(name, () => {
      const src = fn(name);
      assert.ok(src.includes("async function webhookFor("), "webhookFor is gone — was it renamed?");

      // The leak itself: reading the env secret anywhere in the file. A club with
      // no webhook of its own would otherwise announce its draws, meeting times
      // and locked scores -- with member names and avatars -- into the seeded
      // club's Discord server, which none of its members are in.
      const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(
        !/DISCORD_WEBHOOK_URL/.test(codeOnly),
        "DISCORD_WEBHOOK_URL is read again in " + name + " — that is the Phase 8 leak returning",
      );
    });
  }
});

test("the club-scoped functions require a club_id rather than defaulting to the seeded club", async (t) => {
  for (const name of CLUB_SCOPED_FUNCTIONS) {
    await t.test(name, () => {
      const src = fn(name);
      const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

      // The seeded club's id must not appear as a value at all in these four. Its
      // presence was the whole mechanism: any action that forgot to pass a club
      // wrote to The Guild instead of failing.
      assert.ok(
        !codeOnly.includes("8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8"),
        "the seeded club id is still hardcoded in " + name,
      );
      assert.ok(
        /body\.club_id\s*\?\?\s*""/.test(codeOnly),
        "expected " + name + " to coerce an absent club_id to \"\" so the uuid check rejects it",
      );
      assert.ok(
        /club_id required/.test(src),
        "expected " + name + " to 400 with \"club_id required\"",
      );
    });
  }
});

test("every client call to a club-scoped function names the club", () => {
  // The functions above now 400 without a club_id, so a call site that forgot one
  // is a broken feature rather than a write to the wrong club. Cheap to check and
  // it fails at the moment a new call site is added, not in production.
  for (const name of CLUB_SCOPED_FUNCTIONS) {
    const marker = "/functions/v1/" + name + "`";
    let at = html.indexOf(marker);
    assert.ok(at !== -1, "no client call to " + name + " found — was the URL built differently?");
    let calls = 0;
    while (at !== -1) {
      calls++;
      // The fetch's body literal is within the next few lines of the URL.
      const window = html.slice(at, at + 700);
      const body = window.slice(window.indexOf("JSON.stringify("));
      assert.ok(
        /club_id:\s*clubId\(\)/.test(body.slice(0, 300)),
        "a call to " + name + " at offset " + at + " does not pass club_id: clubId()",
      );
      at = html.indexOf(marker, at + 1);
    }
    assert.ok(calls > 0);
  }
});

test("the header and the sign-in gate carry no club's name as a literal", () => {
  // clubName()/clubTagline() render the club the URL resolved to. The literals
  // they replaced meant a club that named itself and wrote a tagline saw neither,
  // and every visitor to the front door was greeted by one club's name.
  const codeOnly = html
    .split("\n")
    .filter((line) => !/^\s*(\/\/|<!--)/.test(line))
    .join("\n");
  assert.ok(
    !/"eyebrow">The Guild/.test(codeOnly),
    "a header eyebrow is hardcoded to The Guild again",
  );
  assert.ok(
    html.includes("const clubTagline = ()"),
    "clubTagline() is gone — the header would be back to a hardcoded description",
  );
  // A tagline is member-supplied text and must be escaped where it renders.
  assert.ok(
    html.includes("${esc(clubTagline())}"),
    "clubTagline() must render through esc()",
  );
  assert.ok(
    html.includes('${esc(clubName())} · Round '),
    "the main header eyebrow should name the club, escaped",
  );
});

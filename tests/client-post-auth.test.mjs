// The first client-side test in the repo.
//
// index.html is one 4,000-line module with no exports and a hard dependency on a
// DOM, so it can't be imported. Rather than copy the logic here (where it would
// rot), this slices the post-auth-redirect block straight out of the served file
// and runs it in a vm context with the three browser globals it touches. It
// therefore tests the code that actually ships; if someone renames the functions
// the extraction fails loudly instead of passing against a stale copy.
//
// What's under test: a signed-out reader who clicks an invite link is sent through
// Discord's OAuth round trip, which strips the URL fragment (Supabase returns its
// own token fragment, so `redirectTo` can't carry ours). The destination is
// stashed in sessionStorage and restored afterwards. The case that matters most is
// the negative one -- this must never stash Supabase's `#access_token=...`
// fragment, which would put a credential into storage and then replay it into the
// address bar.
//
// Run: node --test tests/client-post-auth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

const START = "const POST_AUTH_KEY";
const END = "async function signIn()";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from !== -1 && to > from, "could not find the post-auth block in index.html — was it renamed?");
const source = html.slice(from, to);

// Fresh sandbox per case: sessionStorage is stateful and the stash is single-use.
function sandbox(hash = "", store = {}) {
  const ctx = {
    location: { hash, pathname: "/", search: "" },
    sessionStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    history: { replaceState: (_s, _t, url) => { ctx.__replaced = url; } },
    __replaced: null,
    __store: store,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}

const KEY = "shelf:post-auth-dest";

test("stashes the routes a reader can be interrupted on", () => {
  for (const hash of ["#/join/ABC123XYZ789", "#/new", "#/c/the-guild/reading", "#/c/bookwyrms"]) {
    const ctx = sandbox(hash);
    ctx.stashPostAuthDest();
    assert.equal(ctx.__store[KEY], hash, `should stash ${hash}`);
  }
});

test("never stashes an auth fragment, an error, or a malformed route", () => {
  const refuse = [
    // The one that would be a security bug: Supabase's implicit-flow tokens.
    "#access_token=eyJhbGciOiJIUzI1NiJ9.body.sig&refresh_token=r&token_type=bearer",
    "#error=access_denied&error_description=nope",
    // Older detail routes are club-agnostic and deliberately out of scope.
    "#book=3", "#reader=abc", "#recap=2026",
    // Nothing, and near-misses.
    "", "#", "#/join/", "#/joinABC", "#/c/", "#/../etc", "#/new/extra/deep",
  ];
  for (const hash of refuse) {
    const ctx = sandbox(hash);
    ctx.stashPostAuthDest();
    assert.equal(ctx.__store[KEY], undefined, `should refuse ${JSON.stringify(hash)}`);
  }
});

test("restores through replaceState, not by assigning location.hash", () => {
  // Assigning the hash would fire a hashchange, racing the load onSignedIn is
  // already about to do for this same route.
  const ctx = sandbox("", { [KEY]: "#/join/CODE1" });
  ctx.restorePostAuthDest();
  assert.equal(ctx.__replaced, "/#/join/CODE1");
});

test("the stash is single-use, so a later sign-in can't replay a stale destination", () => {
  const ctx = sandbox("", { [KEY]: "#/join/OLD" });
  ctx.restorePostAuthDest();
  assert.equal(ctx.__store[KEY], undefined, "should be consumed");
  ctx.__replaced = null;
  ctx.restorePostAuthDest();
  assert.equal(ctx.__replaced, null, "second restore should do nothing");
});

test("restoring is a no-op with nothing stashed, or when already there", () => {
  const empty = sandbox("#/c/the-guild/reading");
  empty.restorePostAuthDest();
  assert.equal(empty.__replaced, null);

  const same = sandbox("#/new", { [KEY]: "#/new" });
  same.restorePostAuthDest();
  assert.equal(same.__replaced, null);
});

test("a storage that throws (private mode) doesn't break sign-in", () => {
  const ctx = {
    location: { hash: "#/join/ABC123", pathname: "/", search: "" },
    sessionStorage: {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    },
    history: { replaceState() { throw new Error("denied"); } },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  // Both must swallow the failure: losing the destination is a worse experience,
  // not a broken app.
  assert.doesNotThrow(() => ctx.stashPostAuthDest());
  assert.doesNotThrow(() => ctx.restorePostAuthDest());
});

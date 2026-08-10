// Discord re-showed its "authorise" screen on every sign-in, because Discord's
// OAuth `prompt` parameter defaults to `consent`. Sending `prompt=none` skips it —
// but that *errors* instead of prompting when the account hasn't authorised the app
// yet, so it can only be sent once we know this browser has completed a sign-in
// with that provider before.
//
// The real round trip can't be exercised from here (it needs a Discord account and
// a browser), so this pins the decision logic around it: when the flag is set, when
// it's cleared, and that an OAuth error is recovered from the URL before supabase-js
// consumes the fragment.
//
// Run: node --test tests/client-oauth-consent.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

function slice(startMarker, endMarker) {
  const from = html.indexOf(startMarker);
  const to = html.indexOf(endMarker);
  assert.ok(from !== -1 && to > from, `could not find ${startMarker} … ${endMarker} in index.html — renamed?`);
  return html.slice(from, to);
}

// --- the "have we signed in with this provider before" flag -------------------

const flagSource = slice("const AUTH_PROVIDERS = [", "async function signIn(")
  + "\nglobalThis.__PROVIDERS = AUTH_PROVIDERS;";

function flagCtx(store = {}, throwing = false) {
  const ls = throwing
    ? {
        getItem() { throw new Error("denied"); },
        setItem() { throw new Error("denied"); },
        removeItem() { throw new Error("denied"); },
      }
    : {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
      };
  const ctx = { localStorage: ls, __store: store };
  vm.createContext(ctx);
  vm.runInContext(flagSource, ctx);
  return ctx;
}

test("a provider is only 'seen' after a sign-in is recorded for it", () => {
  const ctx = flagCtx();
  assert.equal(ctx.providerSeen("discord"), false, "fresh browser must not skip consent");
  ctx.markProviderSeen("discord");
  assert.equal(ctx.providerSeen("discord"), true);
  assert.equal(ctx.providerSeen("google"), false, "one provider must not vouch for another");
});

test("an undefined provider is not recorded", () => {
  // session.user.app_metadata.provider can be absent; this must not write a
  // "shelf:oauth-seen:undefined" flag that then matches nothing usefully.
  const ctx = flagCtx();
  ctx.markProviderSeen(undefined);
  assert.deepEqual(Object.keys(ctx.__store), []);
});

test("forgetting clears every known provider, so the next attempt shows consent", () => {
  const ctx = flagCtx();
  ctx.markProviderSeen("discord");
  ctx.markProviderSeen("google");
  ctx.forgetProvidersSeen();
  assert.equal(ctx.providerSeen("discord"), false);
  assert.equal(ctx.providerSeen("google"), false);
});

test("the flag list covers every provider on the gate", () => {
  // forgetProvidersSeen iterates AUTH_PROVIDERS, so a provider added there is
  // cleared automatically — this guards against it iterating a stale list.
  const ctx = flagCtx();
  const ids = ctx.__PROVIDERS.map(p => p.id);
  assert.ok(ids.includes("discord") && ids.includes("google"), `unexpected providers: ${ids}`);
  for (const id of ids) ctx.markProviderSeen(id);
  ctx.forgetProvidersSeen();
  for (const id of ids) assert.equal(ctx.providerSeen(id), false, `${id} not cleared`);
});

test("a storage that throws degrades to 'never seen' rather than breaking sign-in", () => {
  const ctx = flagCtx({}, true);
  assert.doesNotThrow(() => ctx.markProviderSeen("discord"));
  // False is the safe answer: it means send no prompt, i.e. today's behaviour.
  assert.equal(ctx.providerSeen("discord"), false);
  assert.doesNotThrow(() => ctx.forgetProvidersSeen());
});

// --- recovering the OAuth error from the URL ----------------------------------

const errSource = slice("const INITIAL_OAUTH_ERROR", "const supabase =")
  + "\nglobalThis.__ERR = INITIAL_OAUTH_ERROR;";

function errFor(hash, search = "") {
  const ctx = { location: { hash, search }, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(errSource, ctx);
  return ctx.__ERR;
}

test("no error in the URL means no error", () => {
  assert.equal(errFor(""), null);
  assert.equal(errFor("#/c/the-guild/reading"), null);
  // A successful implicit-flow return carries tokens, not an error.
  assert.equal(errFor("#access_token=abc&token_type=bearer"), null);
});

test("an error in the fragment is recovered, with its description", () => {
  const e = errFor("#error=consent_required&error_description=User+has+not+authorized");
  assert.equal(e.code, "consent_required");
  assert.equal(e.description, "User has not authorized");
});

test("an error in the query string is recovered too", () => {
  // PKCE-style returns put it in the query rather than the fragment.
  const e = errFor("", "?error=access_denied&error_description=nope");
  assert.equal(e.code, "access_denied");
  assert.equal(e.description, "nope");
});

test("a missing description doesn't produce undefined", () => {
  const e = errFor("#error=server_error");
  assert.equal(e.code, "server_error");
  assert.equal(e.description, "");
});

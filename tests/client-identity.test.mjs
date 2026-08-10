// Phase 5 prep: per-provider identity extraction.
//
// Same technique as client-post-auth.test.mjs -- the functions are sliced out of
// index.html at run time so this tests what actually ships, and fails loudly if
// they're renamed rather than passing against a stale copy.
//
// The case that matters most is discordIdFromUser(). It used to read
// `user_metadata.provider_id || .sub`, which are whatever the MOST RECENT provider
// wrote -- so a Google sign-in would have put a Google subject id into
// shelf_users.discord_id. That's the column discord-interactions looks readers up
// by for /mybook, and profiles.discord_id is unique, so the outcomes ranged from
// an inert wrong value, to overwriting a real Discord id and breaking that
// reader's slash command, to a unique-violation on sign-in.
//
// Run: node --test tests/client-identity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");

const START = "function displayNameFromMeta(user)";
const END = "async function ensureUserRow(user)";
const from = html.indexOf(START);
const to = html.indexOf(END);
assert.ok(from !== -1 && to > from, "could not find the identity block in index.html — was it renamed?");

const ctx = {};
vm.createContext(ctx);
vm.runInContext(html.slice(from, to), ctx);
const { displayNameFromMeta, nameFromEmail, avatarFromMeta, discordIdFromUser } = ctx;

// Shapes as the providers actually deliver them.
const discordUser = {
  id: "u-discord",
  email: "ada@discord.example",
  app_metadata: { provider: "discord" },
  user_metadata: {
    avatar_url: "https://cdn.discordapp.com/avatars/1/2.png",
    custom_claims: { global_name: "Ada" },
    full_name: "ada_lovelace",
    preferred_username: "ada_lovelace",
    provider_id: "111111111111111111",
    sub: "111111111111111111",
  },
  identities: [{ provider: "discord", id: "111111111111111111" }],
};

const googleUser = {
  id: "u-google",
  email: "ada.lovelace+books@gmail.com",
  app_metadata: { provider: "google" },
  user_metadata: {
    full_name: "Ada Lovelace",
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/a/x",
    provider_id: "999999999999999999",   // a GOOGLE subject id
    sub: "999999999999999999",
  },
  identities: [{ provider: "google", id: "999999999999999999" }],
};

const emailUser = {
  id: "u-email",
  email: "ada.lovelace+books@example.com",
  app_metadata: { provider: "email" },
  user_metadata: {},
  identities: [{ provider: "email", id: "u-email" }],
};

test("Discord readers keep exactly the name and avatar they have today", () => {
  assert.equal(displayNameFromMeta(discordUser), "Ada");
  assert.equal(avatarFromMeta(discordUser), "https://cdn.discordapp.com/avatars/1/2.png");
  assert.equal(discordIdFromUser(discordUser), "111111111111111111");
});

test("Google supplies a name and a picture", () => {
  assert.equal(displayNameFromMeta(googleUser), "Ada Lovelace");
  assert.equal(avatarFromMeta(googleUser), "https://lh3.googleusercontent.com/a/x");
});

test("a Google subject id is NEVER written as a discord_id", () => {
  assert.equal(discordIdFromUser(googleUser), null);
});

test("email accounts fall back to the address, tidied, and have no avatar", () => {
  assert.equal(displayNameFromMeta(emailUser), "ada lovelace");
  assert.equal(avatarFromMeta(emailUser), null);
  assert.equal(discordIdFromUser(emailUser), null);
});

test("nameFromEmail drops +tags and separators, and gives up gracefully", () => {
  assert.equal(nameFromEmail("ada@example.com"), "ada");
  assert.equal(nameFromEmail("ada.lovelace@example.com"), "ada lovelace");
  assert.equal(nameFromEmail("ada+books@example.com"), "ada");
  assert.equal(nameFromEmail("ada_b-c@example.com"), "ada b c");
  assert.equal(nameFromEmail(""), null);
  assert.equal(nameFromEmail(undefined), null);
  assert.equal(nameFromEmail("@example.com"), null);
});

test("with no name anywhere, a reader is still a Reader", () => {
  assert.equal(displayNameFromMeta({ id: "x", user_metadata: {} }), "Reader");
  assert.equal(displayNameFromMeta({ id: "x" }), "Reader");
});

test("a Discord reader who also links Google keeps their real discord_id", () => {
  // This is the regression that mattered: metadata now describes Google (the more
  // recent link), but the Discord identity is still there and is what counts.
  const linked = {
    ...discordUser,
    user_metadata: { ...googleUser.user_metadata },
    app_metadata: { provider: "google", providers: ["discord", "google"] },
    identities: [
      { provider: "discord", id: "111111111111111111" },
      { provider: "google", id: "999999999999999999" },
    ],
  };
  assert.equal(discordIdFromUser(linked), "111111111111111111");
});

test("a legacy Discord account with no identities array still resolves", () => {
  // Older sessions didn't always carry `identities`; metadata is trusted only
  // because app_metadata.provider says discord.
  const legacy = {
    id: "u-old",
    app_metadata: { provider: "discord" },
    user_metadata: { provider_id: "222222222222222222", custom_claims: { global_name: "Old" } },
  };
  assert.equal(discordIdFromUser(legacy), "222222222222222222");
  assert.equal(displayNameFromMeta(legacy), "Old");
});

test("identity_data is used when an identity carries no top-level id", () => {
  const odd = {
    id: "u-odd",
    app_metadata: { provider: "discord" },
    user_metadata: {},
    identities: [{ provider: "discord", identity_data: { provider_id: "333333333333333333" } }],
  };
  assert.equal(discordIdFromUser(odd), "333333333333333333");
});

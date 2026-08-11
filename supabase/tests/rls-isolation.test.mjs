// Automated version of the manual cross-tenant RLS check performed
// 2026-07-26 (see docs/multi-tenant-plan.md, Phase 1). There is no local
// Postgres/Docker in this environment, so this is NOT an offline unit test
// like shelf-logic.test.mjs -- it shells out to the already-authenticated
// `supabase` CLI and runs against the LINKED (live) project. It creates one
// throwaway private club, seeds one row per club-scoped table, asserts on
// visibility under `SET ROLE`/simulated JWT claims, then deletes everything
// it created (in a try/finally, so cleanup runs even on assertion failure).
//
// Requires: `supabase login` done once on this machine, and at least 2
// existing members of the seeded default club (DEFAULT_CLUB_ID) to act as
// "member of the private test club" / "member of a different club".
//
// Run: node --test supabase/tests/rls-isolation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CLUB_ID = "8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8";

// A throwaway slug that satisfies clubs_slug_shape_chk:
//   ^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$  and  no '--'
// i.e. 3..32 chars, alphanumeric at both ends. This test originally interpolated
// a whole randomUUID() into the slug, which was fine until the shape constraint
// landed (20260808150000) and silently made every insert here a 23514 -- so both
// tests in this file were failing before they asserted anything, and nobody saw
// it because this file is deliberately not part of the default `node --test`
// run. 12 hex chars is 48 bits, ample for a row that is deleted seconds later.
// The club *id* stays a full uuid; only the slug has a shape to satisfy.
function throwawaySlug(prefix) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const slug = `${prefix}-${suffix}`;
  assert.ok(
    /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(slug) && !slug.includes("--"),
    `throwaway slug "${slug}" would violate clubs_slug_shape_chk — shorten the prefix`,
  );
  return slug;
}

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "shelf-rls-"));
  const file = join(dir, "query.sql");
  writeFileSync(file, sql, "utf8");
  try {
    // .cmd shims (npm's Windows install of the CLI) can only run through a
    // shell, so this is a shell command string rather than execFile's argv
    // array -- `file` is always our own mkdtempSync path, never user input.
    const bin = process.platform === "win32" ? "supabase.cmd" : "supabase";
    const out = execSync(`${bin} db query --linked -f "${file}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out).rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Six subqueries in one SELECT because the CLI only surfaces the last
// statement's result set -- each persona's whole check has to be one query.
function countsSql(clubId) {
  return `
    select
      (select count(*) from reads where club_id = '${clubId}') as reads_n,
      (select count(*) from shelf_state where club_id = '${clubId}') as state_n,
      (select count(*) from shelf_reviews where club_id = '${clubId}') as reviews_n,
      (select count(*) from shelf_comments where club_id = '${clubId}') as comments_n,
      (select count(*) from shelf_comment_reactions where club_id = '${clubId}') as reactions_n,
      (select count(*) from club_members where club_id = '${clubId}') as members_n,
      (select count(*) from notification_prefs where club_id = '${clubId}') as prefs_n;
  `;
}

function toCounts(row) {
  return {
    reads: Number(row.reads_n),
    state: Number(row.state_n),
    reviews: Number(row.reviews_n),
    comments: Number(row.comments_n),
    reactions: Number(row.reactions_n),
    members: Number(row.members_n),
    prefs: Number(row.prefs_n),
  };
}

const ZERO_COUNTS = { reads: 0, state: 0, reviews: 0, comments: 0, reactions: 0, members: 0, prefs: 0 };

test("RLS isolates a private club's data from everyone but its own members", async (t) => {
  const [{ user_a: userA, user_b: userB }] = runSql(`
    select
      (array_agg(user_id order by user_id))[1] as user_a,
      (array_agg(user_id order by user_id))[2] as user_b
    from club_members
    where club_id = '${DEFAULT_CLUB_ID}';
  `);
  assert.ok(userA && userB, "need at least 2 existing club_members on the default club to run this test");

  const testClubId = randomUUID();
  const testSlug = throwawaySlug("rls-isolation");
  // book_ts is plain text with no constraint, so this one can stay long and
  // obvious -- it's what makes a stray row recognisable if cleanup ever fails.
  const testTs = `rls-isolation-test-${testClubId}`;
  const testCommentId = randomUUID();

  runSql(`
    insert into clubs (id, slug, name, visibility)
      values ('${testClubId}', '${testSlug}', 'RLS isolation test', 'private');
    insert into club_members (club_id, user_id, role)
      values ('${testClubId}', '${userA}', 'member');
    insert into reads (club_id, round, winner_id, winner_username, book, ts)
      values ('${testClubId}', 1, '${userA}', 'Test', '__rls_isolation_test__', '${testTs}');
    -- No explicit id: shelf_state stopped being the id=1 singleton in Phase 3.5
    -- and its id column now defaults off a sequence, so a club's state row is
    -- created by naming only its club_id. Inserting without an id is itself
    -- part of what is under test here.
    insert into shelf_state (club_id, data)
      values ('${testClubId}', '{"eliminated":[],"roundNumber":1}'::jsonb);
    insert into shelf_reviews (book_ts, user_id, club_id, dnf)
      values ('${testTs}', '${userA}', '${testClubId}', true);
    insert into shelf_comments (id, book_ts, user_id, club_id, body)
      values ('${testCommentId}', '${testTs}', '${userA}', '${testClubId}', 'rls isolation test comment');
    insert into shelf_comment_reactions (comment_id, user_id, emoji, club_id)
      values ('${testCommentId}', '${userA}', '\u{1F512}', '${testClubId}');
    insert into notification_prefs (club_id, user_id, mention_winner)
      values ('${testClubId}', '${userA}', false);
  `);

  try {
    await t.test("anon sees nothing in the private club", () => {
      const [row] = runSql(`set role anon; ${countsSql(testClubId)} reset role;`);
      assert.deepEqual(toCounts(row), ZERO_COUNTS);
    });

    await t.test("a member of a different club sees nothing in the private club", () => {
      const [row] = runSql(`
        set role authenticated;
        set request.jwt.claims to '{"sub":"${userB}"}';
        ${countsSql(testClubId)}
        reset role;
      `);
      assert.deepEqual(toCounts(row), ZERO_COUNTS);
    });

    await t.test("that same member's own club visibility is unaffected", () => {
      const [row] = runSql(`
        set role authenticated;
        set request.jwt.claims to '{"sub":"${userB}"}';
        ${countsSql(DEFAULT_CLUB_ID)}
        reset role;
      `);
      const counts = toCounts(row);
      assert.ok(counts.reads > 0, "expected to still see reads in their own club");
      assert.ok(counts.members > 0, "expected to still see club_members in their own club");
    });

    await t.test("the private club's own member sees exactly its seeded rows", () => {
      const [row] = runSql(`
        set role authenticated;
        set request.jwt.claims to '{"sub":"${userA}"}';
        ${countsSql(testClubId)}
        reset role;
      `);
      assert.deepEqual(toCounts(row), { reads: 1, state: 1, reviews: 1, comments: 1, reactions: 1, members: 1, prefs: 1 });
    });

    // Phase 11 §4.4: a preference is nobody else's business -- unlike every
    // other table here, notification_prefs isn't even publicly readable to
    // other members of the SAME club, only the owning row. Seeds userB as a
    // second member of the throwaway club first (via the default/service
    // connection -- club_members has no INSERT policy at all, so this insert
    // would be denied outright, not just filtered, if attempted as
    // `authenticated`), then checks under userB's own JWT.
    await t.test("even a fellow member of the same club can't see another reader's notification_prefs row", () => {
      runSql(`
        insert into club_members (club_id, user_id, role) values ('${testClubId}', '${userB}', 'member')
          on conflict (club_id, user_id) do nothing;
      `);
      const [row] = runSql(`
        set role authenticated;
        set request.jwt.claims to '{"sub":"${userB}"}';
        select count(*) as n from notification_prefs where club_id = '${testClubId}' and user_id = '${userA}';
        reset role;
      `);
      assert.equal(Number(row.n), 0);
    });

    // Phase 8 (§0.1). webhookFor() used to resolve the club's own webhook and
    // then, finding none, fall back to the DISCORD_WEBHOOK_URL env secret -- the
    // seeded club's channel. So this throwaway club, and every real club created
    // by a stranger, would have posted its draws, meeting times and locked scores
    // into a Discord server none of its members are in, while the Admin tab said
    // "With none, this club posts nothing to Discord."
    //
    // The env secret is not visible from SQL, so what this asserts is the input
    // the three copies of webhookFor now read and nothing else: a fresh club's
    // club_secrets row carries no webhook, therefore resolves to undefined,
    // therefore posts nothing. tests/tenant-correctness.test.mjs holds the other
    // half -- that no copy reads the env var any more.
    await t.test("a fresh club resolves no Discord webhook", () => {
      // Exactly what club-admin's create_club inserts: a row with a club_id and
      // nothing else. A club with no club_secrets row at all resolves to
      // undefined too, but the row is the case that used to be misread as
      // "configured, fall through".
      runSql(`insert into club_secrets (club_id) values ('${testClubId}');`);
      const [row] = runSql(`
        select discord_webhook_url is null as no_webhook
        from club_secrets where club_id = '${testClubId}';
      `);
      assert.equal(row.no_webhook, true, "a newly created club must carry no webhook of its own");
    });
  } finally {
    runSql(`
      delete from notification_prefs where club_id = '${testClubId}';
      delete from shelf_comment_reactions where club_id = '${testClubId}';
      delete from shelf_comments where club_id = '${testClubId}';
      delete from shelf_reviews where club_id = '${testClubId}';
      delete from reads where club_id = '${testClubId}';
      delete from shelf_state where club_id = '${testClubId}';
      delete from club_secrets where club_id = '${testClubId}';
      delete from club_members where club_id = '${testClubId}';
      delete from clubs where id = '${testClubId}';
    `);
  }
});

// Phase 8 deploy gate, not an isolation check.
//
// Removing the env fallback is safe for every club except the one that was
// relying on it. The seeded club has been posting through DISCORD_WEBHOOK_URL
// since Phase 6a with no webhook of its own, so deploying the three functions
// before its URL is in club_secrets makes it go quiet -- no error, no warning,
// just a club that stops announcing its draws.
//
// This test failing means: open Admin -> Club settings on the seeded club and
// paste the webhook URL in (club-admin's set_club_webhook), THEN deploy. It is a
// separate test rather than an assertion inside the one above because its
// subject is production data, not the throwaway club.
test("the seeded club has a webhook of its own, so removing the env fallback keeps it posting", () => {
  const [row] = runSql(`
    select coalesce(discord_webhook_url, '') <> '' as has_webhook
    from club_secrets where club_id = '${DEFAULT_CLUB_ID}';
  `) ?? [];
  assert.ok(
    row && row.has_webhook === true,
    "the seeded club has no club_secrets.discord_webhook_url. Set it in Admin -> Club settings " +
      "before deploying admin-update / set-book / discord-interactions, or its Discord posts stop.",
  );
});

// Phase 3.5: the keys that identify a club's state and its reads are per-club,
// not global. Two throwaway clubs (the real club is never written to) prove that
// one club can neither block nor be confused with another.
test("club state and read keys are scoped per club", async (t) => {
  const clubOne = randomUUID();
  const clubTwo = randomUUID();
  const slugOne = throwawaySlug("key-scoping-one");
  const slugTwo = throwawaySlug("key-scoping-two");
  const sharedTs = `key-scoping-test-${randomUUID()}`;

  runSql(`
    insert into clubs (id, slug, name, visibility) values
      ('${clubOne}', '${slugOne}', 'Key scoping one', 'private'),
      ('${clubTwo}', '${slugTwo}', 'Key scoping two', 'private');
    insert into shelf_state (club_id) values ('${clubOne}'), ('${clubTwo}');
  `);

  try {
    await t.test("two clubs can hold a read with the same ts", () => {
      // Previously `reads.ts` was globally unique, so whichever club drew second
      // in a given millisecond got a hard insert failure from the other's row.
      runSql(`
        insert into reads (club_id, round, winner_username, book, ts) values
          ('${clubOne}', 1, 'Test', '__key_scoping_one__', '${sharedTs}'),
          ('${clubTwo}', 1, 'Test', '__key_scoping_two__', '${sharedTs}');
      `);
      const [row] = runSql(`select count(*) as n from reads where ts = '${sharedTs}';`);
      assert.equal(Number(row.n), 2);
    });

    await t.test("one club can hold a read with that ts only once", () => {
      assert.throws(() => runSql(`
        insert into reads (club_id, round, winner_username, book, ts)
          values ('${clubOne}', 1, 'Test', '__key_scoping_dupe__', '${sharedTs}');
      `));
    });

    await t.test("a club can only have one state row", () => {
      assert.throws(() => runSql(`insert into shelf_state (club_id) values ('${clubOne}');`));
    });

    await t.test("the same reader can review each club's same-ts read", () => {
      const [{ user_a: userA }] = runSql(`
        select (array_agg(user_id order by user_id))[1] as user_a
        from club_members where club_id = '${DEFAULT_CLUB_ID}';
      `);
      // shelf_reviews used to be primary-keyed (book_ts, user_id) alone, so the
      // second of these was a key collision across two unrelated clubs.
      runSql(`
        insert into shelf_reviews (club_id, book_ts, user_id, dnf) values
          ('${clubOne}', '${sharedTs}', '${userA}', true),
          ('${clubTwo}', '${sharedTs}', '${userA}', true);
      `);
      const [row] = runSql(`select count(*) as n from shelf_reviews where book_ts = '${sharedTs}';`);
      assert.equal(Number(row.n), 2);
    });
  } finally {
    runSql(`
      delete from shelf_reviews where book_ts = '${sharedTs}';
      delete from reads where ts = '${sharedTs}';
      delete from shelf_state where club_id in ('${clubOne}', '${clubTwo}');
      delete from clubs where id in ('${clubOne}', '${clubTwo}');
    `);
  }
});

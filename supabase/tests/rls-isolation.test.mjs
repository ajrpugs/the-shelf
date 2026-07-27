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
      (select count(*) from club_members where club_id = '${clubId}') as members_n;
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
  };
}

const ZERO_COUNTS = { reads: 0, state: 0, reviews: 0, comments: 0, reactions: 0, members: 0 };

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
  const testSlug = `rls-isolation-test-${testClubId}`;
  const testTs = `rls-isolation-test-${testClubId}`;
  const testCommentId = randomUUID();

  runSql(`
    insert into clubs (id, slug, name, visibility)
      values ('${testClubId}', '${testSlug}', 'RLS isolation test', 'private');
    insert into club_members (club_id, user_id, role)
      values ('${testClubId}', '${userA}', 'member');
    insert into reads (club_id, round, winner_id, winner_username, book, ts)
      values ('${testClubId}', 1, '${userA}', 'Test', '__rls_isolation_test__', '${testTs}');
    insert into shelf_state (id, club_id, data)
      select coalesce(max(id), 0) + 1, '${testClubId}', '{"eliminated":[],"roundNumber":1}'::jsonb
      from shelf_state;
    insert into shelf_reviews (book_ts, user_id, club_id, dnf)
      values ('${testTs}', '${userA}', '${testClubId}', true);
    insert into shelf_comments (id, book_ts, user_id, club_id, body)
      values ('${testCommentId}', '${testTs}', '${userA}', '${testClubId}', 'rls isolation test comment');
    insert into shelf_comment_reactions (comment_id, user_id, emoji, club_id)
      values ('${testCommentId}', '${userA}', '\u{1F512}', '${testClubId}');
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
      assert.deepEqual(toCounts(row), { reads: 1, state: 1, reviews: 1, comments: 1, reactions: 1, members: 1 });
    });
  } finally {
    runSql(`
      delete from shelf_comment_reactions where club_id = '${testClubId}';
      delete from shelf_comments where club_id = '${testClubId}';
      delete from shelf_reviews where club_id = '${testClubId}';
      delete from reads where club_id = '${testClubId}';
      delete from shelf_state where club_id = '${testClubId}';
      delete from club_members where club_id = '${testClubId}';
      delete from clubs where id = '${testClubId}';
    `);
  }
});

// Supabase Edge Function: admin-update
//
// Librarian-gated writes for shelf_state. The caller's JWT is verified here
// (deployed --no-verify-jwt so we can pull the user id out, same as set-book)
// and must have role = 'librarian' in club_members for the club named in the
// request body (club_id; defaults to the seeded club) --
// club-scoped, not the global shelf_librarians table. Draw picks a random
// eligible reader (a club_members row for this club with a book set, whose id
// isn't already in eliminated). Round auto-advances when a pick empties the
// pool. Every query in here is filtered by club_id -- see Phase 3.5 of
// docs/multi-tenant-plan.md.
//
// Deploy:
//   supabase functions deploy admin-update --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  pickEligible,
  pickRotation,
  pickChosen,
  advanceIfEmpty,
  rollbackUndo,
  clampRatingTotal,
  clampCategoryScore,
  buildMeeting,
} from "../_shared/shelf-logic.mjs";
import { normalizeConfig } from "../_shared/club-config.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Base URL of the live app, so Discord embeds can link back to a book's page.
const SITE_URL = "https://sh3lf.net/";

// Derive the client type from an actual createClient(...) call rather than from
// `ReturnType<typeof createClient>`. The latter resolves supabase-js's generic
// defaults to never/unknown instead of the any/"public" a real call infers, so
// every helper below rejects the real client (TS2345) and `.upsert()` rejects
// every object literal against a `never` schema (TS2353). `deno check` catches
// this; the Supabase deploy pipeline only transpiles, so it never surfaced.
function createServiceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type AdminClient = ReturnType<typeof createServiceClient>;

// club_members is the source of truth for membership, role, and a reader's
// current book (Phase 3.5). The direction of these writes is now the reverse of
// what it was: the club_members write is the one that must not fail, and
// shelf_users.book / shelf_librarians are best-effort legacy mirrors. Nothing
// reads the mirrors any more -- they're kept in step only so the cutover stays
// reversible, and they go away in Phase 6.

async function mirrorShelfUsersBook(client: AdminClient, userId: string, book: string | null): Promise<void> {
  try {
    const { error } = await client
      .from("shelf_users")
      .update({ book, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (error) console.error("shelf_users book mirror failed:", error.message);
  } catch (err) {
    console.error("shelf_users book mirror error:", err);
  }
}

async function setMemberBook(client: AdminClient, clubId: string, userId: string, book: string | null): Promise<void> {
  const { error } = await client
    .from("club_members")
    .upsert({ club_id: clubId, user_id: userId, book }, { onConflict: "club_id,user_id" });
  if (error) throw error;
  await mirrorShelfUsersBook(client, userId, book);
}

async function clearAllMemberBooks(client: AdminClient, clubId: string): Promise<void> {
  const { error } = await client.from("club_members").update({ book: null }).eq("club_id", clubId);
  if (error) throw error;
  // Mirror only this club's members -- the old version cleared `book` on every
  // shelf_users row in the database, which with a second club present would
  // have wiped that club's shelf too. Every step from here down is mirror-only,
  // so nothing in it may fail the reset: club_members is already cleared, and
  // that's the write that counts.
  try {
    const { data, error: idErr } = await client
      .from("club_members").select("user_id").eq("club_id", clubId);
    if (idErr) {
      console.error("shelf_users bulk book mirror skipped:", idErr.message);
      return;
    }
    const ids = (data ?? []).map((m: { user_id: string }) => m.user_id);
    if (!ids.length) return;
    const { error: mErr } = await client.from("shelf_users").update({ book: null }).in("id", ids);
    if (mErr) console.error("shelf_users bulk book mirror failed:", mErr.message);
  } catch (err) {
    console.error("shelf_users bulk book mirror error:", err);
  }
}

async function setMemberRole(client: AdminClient, clubId: string, userId: string, role: "librarian" | "member"): Promise<void> {
  const { error } = await client
    .from("club_members")
    .upsert({ club_id: clubId, user_id: userId, role }, { onConflict: "club_id,user_id" });
  if (error) throw error;
  try {
    const mirror = role === "librarian"
      ? await client.from("shelf_librarians").upsert({ user_id: userId }, { onConflict: "user_id" })
      : await client.from("shelf_librarians").delete().eq("user_id", userId);
    if (mirror.error) console.error("shelf_librarians mirror failed:", mirror.error.message);
  } catch (err) {
    console.error("shelf_librarians mirror error:", err);
  }
}

// Removing a reader from the club deletes their *membership*, not their
// identity. shelf_users is global (no club_id), so deleting that row -- which
// is what this action used to do -- would have removed the person from every
// club they belong to, and taken their profile with them. Their shelf_users row
// stays; signing in again re-creates the membership via join_default_club(),
// which is the same "sign in again to rejoin" behavior as before.
async function removeMember(client: AdminClient, clubId: string, userId: string): Promise<void> {
  const { error } = await client
    .from("club_members").delete().eq("club_id", clubId).eq("user_id", userId);
  if (error) throw error;
  await mirrorShelfUsersBook(client, userId, null);
  try {
    const { error: mErr } = await client.from("shelf_librarians").delete().eq("user_id", userId);
    if (mErr) console.error("shelf_librarians removal mirror failed:", mErr.message);
  } catch (err) {
    console.error("shelf_librarians removal mirror error:", err);
  }
}

type Rating = {
  total: number;
  // Optional per-category breakdown (1..scale each) snapshotted from member
  // reviews when the librarian locks in the score.
  plot?: number;
  characters?: number;
  pacing?: number;
  language?: number;
  themes?: number;
  reviews?: number; // how many member reviews the snapshot averaged
  // Phase 10: the rubric this read was actually scored under -- scale and
  // which slots were active/labeled what -- so a later change to the club's
  // live rating config can't retroactively scramble what a locked score
  // means. Absent on anything locked before this existed; callers fall back
  // to normalizeRatingProfile(undefined) for those rows.
  profile?: { scale: number; categories: { slot: string; label: string }[] };
};
// A book-club meeting for a read: the 50% checkpoint (with how far to read) and
// the 100% finish meeting. Each `at` is an ISO instant; either may be absent
// until the librarian schedules it.
type Meeting = { at: string; upTo?: string };
type Meetings = { half?: Meeting; full?: Meeting };

type HistoryItem = {
  round: number;
  winner_id: string | null;
  winner_username: string;
  book: string;
  ts: string;
  rating?: Rating | null;
  ratingsOpen?: boolean; // librarian has opened member reviews for this read
  meetings?: Meetings | null; // 50% / 100% discussion dates for this read
};

// shelf_state.data now holds only these fields — history moved out to the
// `reads` table (Phase 0 of docs/multi-tenant-plan.md). rotationCursor is
// Phase 9: the id config.selection.mode === "rotation" chose last, so the
// deterministic queue can pick up where it left off across draws. Unused
// (stays null) for any club not in rotation mode.
type GameState = {
  eliminated: string[];       // user ids
  roundNumber: number;
  rotationCursor: string | null;
};

// --- Open Library cover lookup + Discord webhook -----------------------------

function normalizeForMatch(s: string): string {
  return (s || "")
    .replace(/\s+by\s+.+$/i, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/^\s*(the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTitleAuthor(raw: string): { title: string; author: string | null } {
  const m = (raw || "").match(/^(.+?)\s+(?:by|[-–—])\s+(.+)$/i);
  return m
    ? { title: m[1].trim(), author: m[2].trim() }
    : { title: (raw || "").trim(), author: null };
}

type BookMeta = {
  cover: string | null;
  year: number | null;
  pages: number | null;
  description: string | null;
};

async function fetchWorkDescription(key: string): Promise<string | null> {
  try {
    const res = await fetch(`https://openlibrary.org${key}.json`);
    if (!res.ok) return null;
    const w = await res.json();
    let d: unknown = (w as { description?: unknown }).description;
    if (d && typeof d === "object") d = (d as { value?: string }).value;
    if (typeof d !== "string") return null;
    const first = d.replace(/\r/g, "").split("\n\n")[0].trim(); // lead paragraph
    if (!first) return null;
    return first.length > 600 ? first.slice(0, 597).trimEnd() + "…" : first;
  } catch { return null; }
}

async function fetchBookMeta(rawTitle: string): Promise<BookMeta> {
  const empty: BookMeta = { cover: null, year: null, pages: null, description: null };
  const { title, author } = parseTitleAuthor(rawTitle);
  if (!title) return empty;
  const params = new URLSearchParams({
    title,
    limit: "5",
    fields: "title,cover_i,first_publish_year,number_of_pages_median,key",
  });
  if (author) params.set("author", author);
  try {
    const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`);
    if (!res.ok) return empty;
    const body = await res.json();
    type OLDoc = { title?: string; cover_i?: number; first_publish_year?: number; number_of_pages_median?: number; key?: string };
    const docs = (body.docs ?? []) as OLDoc[];
    const normTitle = normalizeForMatch(title);
    let metaDoc: OLDoc | null = null;
    let coverId: number | null = null;
    for (const doc of docs) {
      const resultNorm = normalizeForMatch(doc.title || "");
      if (!resultNorm) continue;
      const matches = resultNorm === normTitle
        || resultNorm.includes(normTitle)
        || normTitle.includes(resultNorm);
      if (!matches) continue;
      if (!metaDoc) metaDoc = doc;
      if (coverId === null && doc.cover_i) coverId = doc.cover_i;
      if (metaDoc && coverId !== null) break;
    }
    if (!metaDoc) return empty;
    const description = metaDoc.key ? await fetchWorkDescription(metaDoc.key) : null;
    return {
      cover: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg` : null,
      year: Number.isFinite(metaDoc.first_publish_year) ? metaDoc.first_publish_year! : null,
      pages: Number.isFinite(metaDoc.number_of_pages_median) ? metaDoc.number_of_pages_median! : null,
      description,
    };
  } catch { return empty; }
}

type DiscordArgs = {
  book: string;
  cover: string | null;
  year: number | null;
  pages: number | null;
  description: string | null;
  username: string;
  avatarUrl: string | null;
  discordId: string | null;
  round: number;
  roundAdvanced: boolean;
};

async function postToDiscord(webhookUrl: string, args: DiscordArgs): Promise<void> {
  let description = `Picked by **${args.username}** for round ${args.round}.`;
  if (args.description) description += `\n\n${args.description}`;

  const embed: Record<string, unknown> = {
    title: args.book || "—",
    url: `${SITE_URL}#book=${args.round}`,
    description,
    color: 0xc94a37,
    footer: {
      text: args.roundAdvanced
        ? `Round ${args.round} complete — round ${args.round + 1} opens now`
        : `Round ${args.round}`,
    },
    timestamp: new Date().toISOString(),
  };
  const fields: Array<Record<string, unknown>> = [];
  if (args.year) fields.push({ name: "First published", value: String(args.year), inline: true });
  if (args.pages) fields.push({ name: "Length", value: `${args.pages} pages`, inline: true });
  if (fields.length) embed.fields = fields;
  if (args.cover) embed.thumbnail = { url: args.cover };
  if (args.avatarUrl) embed.author = { name: args.username, icon_url: args.avatarUrl };

  // Personally ping the winner when their web account is linked to Discord;
  // otherwise fall back to a plain announcement.
  const content = args.discordId
    ? `📖 <@${args.discordId}>, the wheel picked you — your book is the next read!`
    : "📖 A new read has been chosen.";
  const payload: Record<string, unknown> = { content, embeds: [embed] };
  if (args.discordId) payload.allowed_mentions = { users: [args.discordId] };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord webhook non-2xx:", res.status, text);
    }
  } catch (err) {
    console.error("Discord webhook error:", err);
  }
}

// Announce a change to a read's discussion schedule. Times go out as Discord
// timestamp markup (<t:unix:F>) so every member sees them rendered in their own
// timezone, with a relative countdown alongside.
async function postMeetingsToDiscord(
  webhookUrl: string,
  args: { book: string; round: number; cover: string | null; prev: Meetings | null; next: Meetings | null },
): Promise<void> {
  const stamp = (iso: string) => {
    const t = Math.floor(new Date(iso).getTime() / 1000);
    return `<t:${t}:F> · <t:${t}:R>`;
  };
  const cleared = !args.next || (!args.next.half && !args.next.full);
  const hadAny = !!(args.prev && (args.prev.half || args.prev.full));

  const embed: Record<string, unknown> = {
    title: args.book || "—",
    url: `${SITE_URL}#book=${args.round}`,
    color: 0xe0b45a,
    footer: { text: `Round ${args.round}` },
    timestamp: new Date().toISOString(),
  };
  if (args.cover) embed.thumbnail = { url: args.cover };

  if (cleared) {
    embed.description = "The discussion dates for this read were cleared.";
  } else {
    const fields: Array<Record<string, unknown>> = [];
    if (args.next!.half?.at) {
      const upTo = args.next!.half!.upTo;
      fields.push({
        name: "50% · halfway",
        value: stamp(args.next!.half!.at) + (upTo ? `\nRead up to **${upTo}**` : ""),
      });
    }
    if (args.next!.full?.at) {
      fields.push({ name: "100% · finish the book", value: stamp(args.next!.full!.at) });
    }
    embed.fields = fields;
  }

  const content = cleared
    ? "🗓️ Discussion dates cleared."
    : hadAny
      ? "🗓️ The discussion schedule has been updated."
      : "🗓️ Discussion dates are set — add them to your calendar.";

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord meetings webhook non-2xx:", res.status, text);
    }
  } catch (err) {
    console.error("Discord meetings webhook error:", err);
  }
}

// Band for a /100 total, mirroring ratingBand() in index.html (bands come from
// the average category score, total/5): Excellent ≥80, Great ≥55, Good ≥30,
// else Bad. `color` tints the Discord embed to match.
function ratingBand(total: number): { label: string; color: number } {
  if (total >= 80) return { label: "Excellent", color: 0x3a9d5a };
  if (total >= 55) return { label: "Great", color: 0x6fae3a };
  if (total >= 30) return { label: "Good", color: 0xe0b45a };
  return { label: "Bad", color: 0xc94a37 };
}

// Announce that a read has been scored and moved onto the leaderboard. Posts the
// committed /100 Guild score, its band, the per-category breakdown when present,
// and how many member reviews it averaged.
async function postRatingToDiscord(
  webhookUrl: string,
  args: { book: string; round: number; cover: string | null; rating: Rating },
): Promise<void> {
  const { total } = args.rating;
  const band = ratingBand(total);

  const embed: Record<string, unknown> = {
    title: args.book || "—",
    url: `${SITE_URL}#book=${args.round}`,
    description: `**${total}/100** · ${band.label}`,
    color: band.color,
    footer: { text: `Round ${args.round}` },
    timestamp: new Date().toISOString(),
  };
  if (args.cover) embed.thumbnail = { url: args.cover };

  const catLabels: Record<string, string> = {
    plot: "Plot",
    characters: "Characters",
    pacing: "Organization / Pacing",
    language: "Use of Language",
    themes: "Themes / Ideas",
  };
  const fields: Array<Record<string, unknown>> = [];
  for (const key of ["plot", "characters", "pacing", "language", "themes"] as const) {
    const v = args.rating[key];
    if (Number.isFinite(v)) fields.push({ name: catLabels[key], value: `${v}/20`, inline: true });
  }
  if (fields.length) embed.fields = fields;
  if (Number.isFinite(args.rating.reviews)) {
    const n = args.rating.reviews!;
    embed.footer = { text: `Round ${args.round} · averaged from ${n} review${n === 1 ? "" : "s"}` };
  }

  const content = "🏅 A read has been scored — it's on the leaderboard.";
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed], allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord rating webhook non-2xx:", res.status, text);
    }
  } catch (err) {
    console.error("Discord rating webhook error:", err);
  }
}

// The club's own Discord webhook, and nothing else. A club with none posts
// nothing, which is exactly what the Admin tab promises.
//
// This used to fall back to the project-wide DISCORD_WEBHOOK_URL env secret --
// i.e. the seeded club's channel -- so that the seeded club kept working without
// anyone re-entering anything. That was safe only while one club existed. With a
// second, a stranger's club would announce its draws, meeting times and locked
// scores, with member names and avatars, into a Discord server none of its
// members are in. Phase 8 removes the fallback; the seeded club's URL now lives
// in its own club_secrets row like everyone else's.
//
// club_secrets has no RLS policies -- only the service role can read this, which
// is the whole reason the table exists.
//
// Three copies of this exist (here, set-book, discord-interactions). Change all
// three or one channel silently keeps the old behaviour.
async function webhookFor(client: AdminClient, clubId: string): Promise<string | undefined> {
  try {
    const { data } = await client
      .from("club_secrets").select("discord_webhook_url").eq("club_id", clubId).maybeSingle();
    return (data?.discord_webhook_url as string | null) || undefined;
  } catch (err) {
    console.error("club webhook lookup failed:", err);
    return undefined;
  }
}

function normalizeGameState(raw: any): GameState {
  const r = raw ?? {};
  return {
    eliminated: Array.isArray(r.eliminated) ? r.eliminated : [],
    roundNumber: r.roundNumber ?? r.cycleNumber ?? 1,
    rotationCursor: typeof r.rotationCursor === "string" ? r.rotationCursor : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;

  // Verify the caller's JWT ourselves (same pattern as set-book), then confirm
  // they're a librarian. Replaces the old shared ADMIN_PASSWORD gate: who did an
  // admin action is now a real identity, and rights are per-user and revocable.
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no auth token" }, 401);

  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) return json({ error: "invalid auth" }, 401);
  const callerId = userData.user.id;

  const client = createServiceClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Parsed before the authorization check, because which club the caller must be
  // a librarian OF comes out of the body (Phase 4 slice 4b).
  let body: { action?: string; club_id?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  // The caller names the club; the gate below is what makes that safe.
  //
  // Required, as of Phase 8. It used to default to the seeded club so that a
  // frontend deployed before slice 4b (which started sending club_id) kept
  // working through the window where the two are at different versions. That
  // window closed several phases ago, and the default's remaining effect was to
  // turn any future action that forgot to pass a club into a silent write against
  // somebody else's club. A 400 is the whole point: the failure is loud.
  const clubId = String(body.club_id ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId)) {
    return json({ error: "club_id required" }, 400);
  }

  // Club-scoped, not global: a shelf_librarians row makes someone a librarian
  // everywhere, but club_members.role is per (club_id, user_id) -- this is the
  // check that actually stops a librarian of one club from acting as one in
  // another, and it is the only thing standing between a caller and any club_id
  // they care to send. As of Phase 3.5 it's also the same table the client's
  // amLibrarian tab-gate reads, so the UI and the server can't disagree.
  const { data: membership } = await client
    .from("club_members").select("role").eq("club_id", clubId).eq("user_id", callerId).maybeSingle();
  if (membership?.role !== "librarian") return json({ error: "not a librarian" }, 403);

  // A suspended club is a moderation hold, not a delete -- its data stays put,
  // but every write path here stops, including a librarian's own. There's no
  // UI for setting this; an operator flips it by hand (see the migration).
  const { data: clubRow } = await client
    .from("clubs").select("suspended_at, config").eq("id", clubId).maybeSingle();
  if (clubRow?.suspended_at) return json({ error: "This club has been suspended." }, 403);

  // Phase 9: how this club picks its next read. Every club whose row predates
  // this key gets normalizeConfig({})'s defaults -- today's wheel/sit-out
  // behaviour -- so this is safe to compute unconditionally.
  const clubConfig = normalizeConfig(clubRow?.config);

  // shelf_state.data now holds only { eliminated, roundNumber } -- history
  // lives in the `reads` table. `version` guards against two concurrent admin
  // actions clobbering each other: every action that touches eliminated/
  // roundNumber writes via writeGameState(), conditioned on this exact value.
  // Addressed by club_id, not by the old fixed `id = 1` singleton -- shelf_state
  // now holds one row per club (unique (club_id), see the Phase 3.5 migration).
  const { data: row, error: readErr } = await client
    .from("shelf_state").select("data, version").eq("club_id", clubId).single();
  if (readErr && readErr.code !== "PGRST116") return json({ error: readErr.message }, 500);
  const gameState: GameState = normalizeGameState(row?.data);
  const version: number = row?.version ?? 0;

  async function writeGameState(next: GameState): Promise<Response | null> {
    const { data: updated, error } = await client
      .from("shelf_state")
      .update({ data: next, version: version + 1, updated_at: new Date().toISOString() })
      .eq("club_id", clubId)
      .eq("version", version)
      .select()
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!updated) return json({ error: "The shelf changed while you were acting — try again." }, 409);
    return null;
  }

  const action = body.action;
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  let winner: HistoryItem | null = null;
  let winnerAvatarUrl: string | null = null;
  let winnerDiscordId: string | null = null;
  let roundAdvanced = false;
  // Set when admin_set_meeting actually changes the schedule, so we only ping
  // Discord on a real edit (not on a no-op Save).
  let meetingChange: { book: string; round: number; prev: Meetings | null; next: Meetings | null } | null = null;
  let ratingChange: { book: string; round: number; rating: Rating } | null = null;

  try {
    switch (action) {
      case "draw": {
        // The eligible pool is *this club's* members who have a book set, read
        // from club_members. It used to come straight from shelf_users, which
        // is global identity with no club_id at all -- so the wheel would have
        // offered up every reader of every club. shelf_users is still where the
        // winner's display name / avatar / Discord id come from.
        const { data: members, error: mErr } = await client
          .from("club_members")
          .select("user_id, book")
          .eq("club_id", clubId)
          .not("book", "is", null)
          .neq("book", "");
        if (mErr) throw mErr;
        type Identity = {
          id: string;
          discord_username?: string | null;
          avatar_url?: string | null;
          discord_id?: string | null;
        };
        const memberIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
        let identities: Identity[] = [];
        if (memberIds.length) {
          const { data: idRows, error: idErr } = await client
            .from("shelf_users")
            .select("id, discord_username, avatar_url, discord_id")
            .in("id", memberIds);
          if (idErr) throw idErr;
          identities = (idRows ?? []) as Identity[];
        }
        const identityById = new Map(identities.map(u => [u.id, u]));
        // Same row shape pickEligible has always been handed, so
        // _shared/shelf-logic.mjs and its tests are untouched.
        const readers = (members ?? []).map((m: { user_id: string; book: string }) => {
          const who = identityById.get(m.user_id);
          return {
            id: m.user_id,
            book: m.book,
            discord_username: who?.discord_username ?? "Reader",
            avatar_url: who?.avatar_url ?? null,
            discord_id: who?.discord_id ?? null,
          };
        });

        // Phase 9 (docs/configurability-plan.md §2): sit-out governs whether a
        // pick is removed from the pool until the round turns over. With it
        // off, the eligible pool is simply everyone with a book set -- nobody
        // is ever added to `eliminated`, so the round never auto-advances by
        // emptying (a librarian still can, via new_round).
        const pool = clubConfig.selection.sitOut
          ? readers.filter(r => !gameState.eliminated.includes(r.id))
          : readers;
        if (!pool.length) throw new Error("no eligible readers");

        let chosen: (typeof readers)[number];
        if (clubConfig.selection.mode === "pick") {
          // The librarian names who's next; validated against the real pool
          // rather than trusted from the request.
          const chosenId = String(payload.user_id ?? "");
          if (!chosenId) throw new Error("user_id required for pick mode");
          ({ chosen } = pickChosen(pool, chosenId));
        } else if (clubConfig.selection.mode === "rotation") {
          // Stable join order, not the wheel's randomness -- the cursor is
          // the fairness guarantee.
          const { data: memberRows, error: ordErr } = await client
            .from("club_members")
            .select("user_id, joined_at")
            .eq("club_id", clubId)
            .order("joined_at", { ascending: true });
          if (ordErr) throw ordErr;
          const order = (memberRows ?? []).map((m: { user_id: string }) => m.user_id);
          const chosenId = pickRotation(order, pool.map(r => r.id), gameState.rotationCursor);
          chosen = pool.find(r => r.id === chosenId)!;
        } else {
          // pool already excludes eliminated readers (when sit-out is on), so
          // handing pickEligible an empty eliminated set is a no-op filter --
          // its return shape (eligible, chosen) is what the bookkeeping below
          // still expects.
          ({ chosen } = pickEligible(pool, []));
        }

        const pickRound = gameState.roundNumber;
        let newEliminated = gameState.eliminated;
        let newRoundNumber = pickRound;
        if (clubConfig.selection.sitOut) {
          newEliminated = [...gameState.eliminated, chosen.id];
          // If this pick emptied the eligible pool, roll to the next round.
          if (advanceIfEmpty(pool.length)) {
            newEliminated = [];
            newRoundNumber = pickRound + 1;
            roundAdvanced = true;
          }
        }
        const newRotationCursor = clubConfig.selection.mode === "rotation" ? chosen.id : gameState.rotationCursor;
        const conflict = await writeGameState({ eliminated: newEliminated, roundNumber: newRoundNumber, rotationCursor: newRotationCursor });
        if (conflict) return conflict;
        gameState.eliminated = newEliminated;
        gameState.roundNumber = newRoundNumber;
        gameState.rotationCursor = newRotationCursor;

        const ts = new Date().toISOString();
        const { error: insErr } = await client
          .from("reads")
          .insert({ club_id: clubId, round: pickRound, winner_id: chosen.id, winner_username: chosen.discord_username, book: chosen.book, ts });
        if (insErr) return json({ error: insErr.message }, 500);
        winner = { round: pickRound, winner_id: chosen.id, winner_username: chosen.discord_username, book: chosen.book, ts };
        winnerAvatarUrl = (chosen as { avatar_url?: string | null }).avatar_url ?? null;
        winnerDiscordId = (chosen as { discord_id?: string | null }).discord_id ?? null;
        break;
      }
      case "new_round": {
        // Manual round advance (librarian override). rotationCursor carries
        // forward unchanged -- it's about who's next in the rotation queue,
        // not about which round is open.
        const conflict = await writeGameState({ eliminated: [], roundNumber: gameState.roundNumber + 1, rotationCursor: gameState.rotationCursor });
        if (conflict) return conflict;
        gameState.eliminated = [];
        gameState.roundNumber += 1;
        roundAdvanced = true;
        break;
      }
      case "reset": {
        // Wipes the shelf entirely (books, past reads), so the rotation
        // queue starts over too rather than remembering a cursor into a
        // roster that's about to be cleared.
        const conflict = await writeGameState({ eliminated: [], roundNumber: 1, rotationCursor: null });
        if (conflict) return conflict;
        gameState.eliminated = [];
        gameState.roundNumber = 1;
        gameState.rotationCursor = null;
        // Wipe this club's books and this club's past reads so its shelf is
        // truly empty. Both deletes used to be table-wide (`.neq("id", <zero
        // uuid>)`), which with a second club present would have destroyed every
        // club's history from one librarian's reset.
        await clearAllMemberBooks(client, clubId);
        const { error: delReadsErr } = await client
          .from("reads").delete().eq("club_id", clubId);
        if (delReadsErr) throw delReadsErr;
        break;
      }
      case "undo_last_spin": {
        const { data: lastRows, error: lastErr } = await client
          .from("reads")
          .select("id, round, winner_id, winner_username, book, ts")
          .eq("club_id", clubId)
          .order("ts", { ascending: false })
          .limit(1);
        if (lastErr) throw lastErr;
        const last = lastRows?.[0];
        if (!last) throw new Error("nothing to undo");
        // Same-round rows other than `last` itself -- mirrors the old
        // "historyAfterShift" (full history with `last` already removed).
        const { data: sameRoundReads, error: srErr } = await client
          .from("reads")
          .select("round, winner_id")
          .eq("club_id", clubId)
          .eq("round", last.round)
          .neq("id", last.id);
        if (srErr) throw srErr;
        const rolled = rollbackUndo(sameRoundReads ?? [], gameState.eliminated, gameState.roundNumber, last);
        // rotationCursor is deliberately NOT rolled back to whatever it was
        // before the undone pick: it only affects which reader rotation
        // offers next, not who's eligible, so a stale cursor after an undo is
        // a minor ordering nit (rotation skips one extra queue slot) rather
        // than a fairness bug. Recovering the exact prior value would need
        // storing it on every `reads` row, which is more machinery than a
        // Phase 9-sized feature earns.
        const conflict = await writeGameState({ eliminated: rolled.eliminated, roundNumber: rolled.roundNumber, rotationCursor: gameState.rotationCursor });
        if (conflict) return conflict;
        gameState.eliminated = rolled.eliminated;
        gameState.roundNumber = rolled.roundNumber;
        const { error: delErr } = await client.from("reads").delete().eq("id", last.id);
        if (delErr) return json({ error: delErr.message }, 500);
        break;
      }
      case "admin_clear_book": {
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        await setMemberBook(client, clubId, userId, null);
        break;
      }
      case "admin_set_book": {
        // Librarian typo-fixes a reader's pick. Deliberately does NOT post to
        // Discord (unlike set-book) — it's a silent correction.
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        const bookVal = String(payload.book ?? "").trim();
        await setMemberBook(client, clubId, userId, bookVal || null);
        break;
      }
      case "admin_set_rating": {
        // Librarian sets/clears the Guild rating (score /100) on a past read,
        // identified by its history timestamp. total === null clears it.
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const { data: entry, error: findErr } = await client
          .from("reads").select("book, round, rating")
          .eq("club_id", clubId).eq("ts", ts).maybeSingle();
        if (findErr) throw findErr;
        if (!entry) throw new Error("history item not found");
        const raw = payload.total;
        const prevRating = entry.rating ?? null;
        let newRating: Rating | null;
        if (raw === null || raw === "" || raw === undefined) {
          newRating = null;
        } else {
          const rating: Rating = { total: clampRatingTotal(raw) };
          // Optional per-category breakdown, sent when locking in an aggregate
          // of member reviews. Restricted to this club's currently-active
          // slots (never trust the request's own category list) and clamped
          // to 1..scale; bad or inactive values are dropped.
          const activeSlots = new Set(clubConfig.rating.categories.map((c: { slot: string }) => c.slot));
          for (const cat of ["plot", "characters", "pacing", "language", "themes"] as const) {
            if (!activeSlots.has(cat)) continue;
            const c = clampCategoryScore((payload as Record<string, unknown>)[cat], clubConfig.rating.scale);
            if (c !== undefined) rating[cat] = c;
          }
          const rc = Math.round(Number((payload as Record<string, unknown>).reviews));
          if (Number.isFinite(rc) && rc > 0) rating.reviews = rc;
          // Phase 10: snapshot the live profile at lock time, server-derived
          // -- never trust a `profile` the client might send -- so this read
          // renders under the rubric it was actually scored with even after
          // the club later renames or reorders its categories.
          rating.profile = { scale: clubConfig.rating.scale, categories: clubConfig.rating.categories };
          newRating = rating;
          // Announce the score only when it actually changed (a re-lock of the
          // same total stays silent, matching the meeting no-op behavior).
          if (JSON.stringify(prevRating) !== JSON.stringify(rating)) {
            ratingChange = { book: entry.book, round: entry.round, rating };
          }
        }
        const { error: updErr } = await client
          .from("reads").update({ rating: newRating })
          .eq("club_id", clubId).eq("ts", ts);
        if (updErr) throw updErr;
        break;
      }
      case "admin_set_ratings_open": {
        // Librarian opens/closes member reviews for one read. Members can only
        // submit a review while it's open (also enforced in set-review).
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const { data: entry, error: findErr } = await client
          .from("reads").select("ratings_open")
          .eq("club_id", clubId).eq("ts", ts).maybeSingle();
        if (findErr) throw findErr;
        if (!entry) throw new Error("history item not found");
        const nextOpen = payload.open === true
          ? true
          : payload.open === false ? false : !entry.ratings_open;
        const { error: updErr } = await client
          .from("reads").update({ ratings_open: nextOpen })
          .eq("club_id", clubId).eq("ts", ts);
        if (updErr) throw updErr;
        break;
      }
      case "admin_set_meeting": {
        // Librarian sets the 50% / 100% discussion dates for a read, identified
        // by its history timestamp. Empty dates clear that phase; clearing both
        // drops the meetings block entirely.
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const { data: entry, error: findErr } = await client
          .from("reads").select("book, round, meetings")
          .eq("club_id", clubId).eq("ts", ts).maybeSingle();
        if (findErr) throw findErr;
        if (!entry) throw new Error("history item not found");
        const half = buildMeeting(payload.half_at, payload.half_upto);
        const full = buildMeeting(payload.full_at, undefined);
        const prev = entry.meetings ?? null;
        let next: Meetings | null = null;
        if (half || full) {
          next = {};
          if (half) next.half = half;
          if (full) next.full = full;
        }
        const { error: updErr } = await client
          .from("reads").update({ meetings: next })
          .eq("club_id", clubId).eq("ts", ts);
        if (updErr) throw updErr;
        // Only worth announcing if something actually moved.
        if (JSON.stringify(prev) !== JSON.stringify(next)) {
          meetingChange = { book: entry.book, round: entry.round, prev, next };
        }
        break;
      }
      case "admin_announce_meeting": {
        // Re-announce a read's existing schedule without changing it — for dates
        // set before the Discord hook existed, or any time the club needs a
        // second nudge. Posts as a fresh "dates are set" message (prev: null).
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const { data: entry, error: findErr } = await client
          .from("reads").select("book, round, meetings")
          .eq("club_id", clubId).eq("ts", ts).maybeSingle();
        if (findErr) throw findErr;
        if (!entry) throw new Error("history item not found");
        if (!entry.meetings || (!entry.meetings.half && !entry.meetings.full)) {
          throw new Error("no meetings scheduled for this read");
        }
        meetingChange = { book: entry.book, round: entry.round, prev: null, next: entry.meetings };
        break;
      }
      case "admin_remove_user": {
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        await removeMember(client, clubId, userId);
        const newEliminated = gameState.eliminated.filter(id => id !== userId);
        // A removed member who was the rotation cursor is handled for free:
        // they're gone from club_members, so the next draw's `order` query
        // won't contain them and pickRotation treats a cursor absent from the
        // queue the same as an unset one.
        const conflict = await writeGameState({ eliminated: newEliminated, roundNumber: gameState.roundNumber, rotationCursor: gameState.rotationCursor });
        if (conflict) return conflict;
        gameState.eliminated = newEliminated;
        break;
      }
      case "admin_import_reviews": {
        // Bulk-import member rubric reviews (e.g. from a spreadsheet) on behalf
        // of readers. Each entry writes one shelf_reviews row keyed by
        // (book_ts, user_id); an existing row for that pair is overwritten.
        // Returns early — it touches shelf_reviews, not shelf_state/reads.
        const list = Array.isArray(payload.reviews) ? payload.reviews : null;
        if (!list || !list.length) throw new Error("reviews[] required");
        const { data: existingReads, error: existingErr } = await client
          .from("reads").select("ts").eq("club_id", clubId);
        if (existingErr) throw existingErr;
        const knownTs = new Set((existingReads ?? []).map((r: { ts: string }) => r.ts));
        const cats = ["plot", "characters", "pacing", "language", "themes"] as const;
        const rows = list.map((r, i) => {
          const rec = r as Record<string, unknown>;
          const book_ts = String(rec.book_ts ?? "");
          const user_id = String(rec.user_id ?? "");
          if (!book_ts) throw new Error(`row ${i}: book_ts required`);
          if (!user_id) throw new Error(`row ${i}: user_id required`);
          if (!knownTs.has(book_ts)) {
            throw new Error(`row ${i}: no read with ts ${book_ts}`);
          }
          const out: Record<string, unknown> = { club_id: clubId, book_ts, user_id };
          for (const c of cats) {
            const n = Math.round(Number(rec[c]));
            if (!Number.isFinite(n) || n < 1 || n > 20) {
              throw new Error(`row ${i}: ${c} must be a whole number 1..20`);
            }
            out[c] = n;
          }
          if (typeof rec.note === "string" && rec.note.trim()) out.note = rec.note.trim().slice(0, 2000);
          return out;
        });
        const { error } = await client
          .from("shelf_reviews")
          .upsert(rows, { onConflict: "club_id,book_ts,user_id" });
        if (error) throw error;
        return json({ ok: true, imported: rows.length });
      }
      case "admin_grant_librarian": {
        // Promote a reader to librarian in *this* club. Idempotent.
        const uid = String(payload.user_id ?? "");
        if (!uid) throw new Error("user_id required");
        await setMemberRole(client, clubId, uid, "librarian");
        return json({ ok: true });
      }
      case "admin_revoke_librarian": {
        // Demote a librarian. A librarian can't revoke themselves — that avoids
        // orphaning the club with zero librarians; another librarian must do it.
        const uid = String(payload.user_id ?? "");
        if (!uid) throw new Error("user_id required");
        if (uid === callerId) throw new Error("you can't revoke your own librarian role");
        await setMemberRole(client, clubId, uid, "member");
        return json({ ok: true });
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  // Every action (whether or not it touched shelf_state) responds with the
  // full current history, reconstructed fresh from `reads` -- this keeps the
  // client's response contract (`normalizeState(body.state)`) identical to
  // before the cutover. ratingsOpen:ratings_open aliases the column so the
  // shape lands exactly as the client's normalizeState already expects.
  const { data: readsRows, error: readsErr } = await client
    .from("reads")
    .select("round, winner_id, winner_username, book, ts, rating, ratingsOpen:ratings_open, meetings")
    .eq("club_id", clubId)
    .order("ts", { ascending: false });
  if (readsErr) return json({ error: readsErr.message }, 500);
  const state = {
    eliminated: gameState.eliminated,
    roundNumber: gameState.roundNumber,
    rotationCursor: gameState.rotationCursor,
    history: readsRows ?? [],
  };

  // Fire-and-await the Discord webhook after the pick is durable. Failures are
  // logged but do not affect the response — a busted webhook shouldn't block
  // the app.
  if (action === "draw" && winner) {
    const webhookUrl = await webhookFor(client, clubId);
    if (webhookUrl) {
      const meta = await fetchBookMeta(winner.book);
      await postToDiscord(webhookUrl, {
        book: winner.book,
        cover: meta.cover,
        year: meta.year,
        pages: meta.pages,
        description: meta.description,
        username: winner.winner_username,
        avatarUrl: winnerAvatarUrl,
        discordId: winnerDiscordId,
        round: winner.round,
        roundAdvanced,
      });
    }
  }

  // Same treatment for a schedule change: announced only after it's durable,
  // and a busted webhook must never fail the librarian's save.
  if (meetingChange) {
    const webhookUrl = await webhookFor(client, clubId);
    if (webhookUrl) {
      const meta = await fetchBookMeta(meetingChange.book);
      await postMeetingsToDiscord(webhookUrl, {
        book: meetingChange.book,
        round: meetingChange.round,
        cover: meta.cover,
        prev: meetingChange.prev,
        next: meetingChange.next,
      });
    }
  }

  // And for a newly committed Guild score: announced after the write, webhook
  // failures logged but never fatal to the librarian's action.
  if (ratingChange) {
    const webhookUrl = await webhookFor(client, clubId);
    if (webhookUrl) {
      const meta = await fetchBookMeta(ratingChange.book);
      await postRatingToDiscord(webhookUrl, {
        book: ratingChange.book,
        round: ratingChange.round,
        cover: meta.cover,
        rating: ratingChange.rating,
      });
    }
  }

  return json({ state, winner, roundAdvanced });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

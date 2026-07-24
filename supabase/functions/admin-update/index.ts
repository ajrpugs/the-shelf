// Supabase Edge Function: admin-update
//
// Librarian-gated writes for shelf_state. The caller's JWT is verified here
// (deployed --no-verify-jwt so we can pull the user id out, same as set-book)
// and must belong to a user present in shelf_librarians. Draw picks a random
// eligible reader (from shelf_users where a book is set and their id isn't
// already in eliminated). Round auto-advances when a pick empties the pool.
//
// Deploy:
//   supabase functions deploy admin-update --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  pickEligible,
  advanceIfEmpty,
  rollbackUndo,
  clampRatingTotal,
  clampCategoryScore,
  buildMeeting,
} from "../_shared/shelf-logic.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Base URL of the live app, so Discord embeds can link back to a book's page.
const SITE_URL = "https://sh3lf.net/";

type Rating = {
  total: number;
  // Optional per-category breakdown (1..20 each) snapshotted from member
  // reviews when the librarian locks in the Guild score.
  plot?: number;
  characters?: number;
  pacing?: number;
  language?: number;
  themes?: number;
  reviews?: number; // how many member reviews the snapshot averaged
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

type State = {
  eliminated: string[];       // user ids
  history: HistoryItem[];
  roundNumber: number;
};

const emptyState = (): State => ({ eliminated: [], history: [], roundNumber: 1 });

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

function normalizeState(raw: any): State {
  const r = raw ?? {};
  return {
    eliminated: Array.isArray(r.eliminated) ? r.eliminated : [],
    history: Array.isArray(r.history)
      ? r.history.map((h: any) => ({
          round: h.round ?? h.cycle ?? 1,
          winner_id: h.winner_id ?? null,
          winner_username: h.winner_username ?? h.winner ?? "Reader",
          book: h.book ?? "",
          ts: h.ts,
          rating: h.rating ?? null,
          ratingsOpen: !!h.ratingsOpen,
          meetings: h.meetings ?? null,
        }))
      : [],
    roundNumber: r.roundNumber ?? r.cycleNumber ?? 1,
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

  const client = createClient(
    url,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: lib } = await client
    .from("shelf_librarians").select("user_id").eq("user_id", callerId).maybeSingle();
  if (!lib) return json({ error: "not a librarian" }, 403);

  let body: { action?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const { data: row, error: readErr } = await client
    .from("shelf_state").select("data").eq("id", 1).single();
  if (readErr && readErr.code !== "PGRST116") return json({ error: readErr.message }, 500);
  const state: State = normalizeState(row?.data);

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
        const { data: readers, error: rErr } = await client
          .from("shelf_users")
          .select("id, discord_username, book, avatar_url, discord_id")
          .not("book", "is", null)
          .neq("book", "");
        if (rErr) throw rErr;
        const { eligible, chosen } = pickEligible(readers, state.eliminated);
        const entry: HistoryItem = {
          round: state.roundNumber,
          winner_id: chosen.id,
          winner_username: chosen.discord_username,
          book: chosen.book,
          ts: new Date().toISOString(),
        };
        state.history.unshift(entry);
        state.eliminated.push(chosen.id);
        winner = entry;
        winnerAvatarUrl = (chosen as { avatar_url?: string | null }).avatar_url ?? null;
        winnerDiscordId = (chosen as { discord_id?: string | null }).discord_id ?? null;

        // If this pick emptied the eligible pool, roll to the next round.
        if (advanceIfEmpty(eligible.length)) {
          state.eliminated = [];
          state.roundNumber += 1;
          roundAdvanced = true;
        }
        break;
      }
      case "new_round": {
        // Manual round advance (librarian override).
        state.eliminated = [];
        state.roundNumber += 1;
        roundAdvanced = true;
        break;
      }
      case "reset": {
        Object.assign(state, emptyState());
        // Also wipe everyone's book so the shelf is truly empty.
        await client.from("shelf_users").update({ book: null }).neq("id", "00000000-0000-0000-0000-000000000000");
        break;
      }
      case "undo_last_spin": {
        if (state.history.length === 0) throw new Error("nothing to undo");
        const last = state.history.shift()!;
        const rolled = rollbackUndo(state.history, state.eliminated, state.roundNumber, last);
        state.roundNumber = rolled.roundNumber;
        state.eliminated = rolled.eliminated;
        break;
      }
      case "admin_clear_book": {
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        const { error } = await client.from("shelf_users").update({ book: null }).eq("id", userId);
        if (error) throw error;
        break;
      }
      case "admin_set_book": {
        // Librarian typo-fixes a reader's pick. Deliberately does NOT post to
        // Discord (unlike set-book) — it's a silent correction.
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        const bookVal = String(payload.book ?? "").trim();
        const { error } = await client
          .from("shelf_users")
          .update({ book: bookVal || null, updated_at: new Date().toISOString() })
          .eq("id", userId);
        if (error) throw error;
        break;
      }
      case "admin_set_rating": {
        // Librarian sets/clears the Guild rating (score /100) on a past read,
        // identified by its history timestamp. total === null clears it.
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const entry = state.history.find(h => h.ts === ts);
        if (!entry) throw new Error("history item not found");
        const raw = payload.total;
        const prevRating = entry.rating ?? null;
        if (raw === null || raw === "" || raw === undefined) {
          entry.rating = null;
        } else {
          const rating: Rating = { total: clampRatingTotal(raw) };
          // Optional per-category breakdown, sent when locking in an aggregate
          // of member reviews. Each is clamped to 1..20; bad values are dropped.
          for (const cat of ["plot", "characters", "pacing", "language", "themes"] as const) {
            const c = clampCategoryScore((payload as Record<string, unknown>)[cat]);
            if (c !== undefined) rating[cat] = c;
          }
          const rc = Math.round(Number((payload as Record<string, unknown>).reviews));
          if (Number.isFinite(rc) && rc > 0) rating.reviews = rc;
          entry.rating = rating;
          // Announce the score only when it actually changed (a re-lock of the
          // same total stays silent, matching the meeting no-op behavior).
          if (JSON.stringify(prevRating) !== JSON.stringify(rating)) {
            ratingChange = { book: entry.book, round: entry.round, rating };
          }
        }
        break;
      }
      case "admin_set_ratings_open": {
        // Librarian opens/closes member reviews for one read. Members can only
        // submit a review while it's open (also enforced in set-review).
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const entry = state.history.find(h => h.ts === ts);
        if (!entry) throw new Error("history item not found");
        entry.ratingsOpen = payload.open === true
          ? true
          : payload.open === false ? false : !entry.ratingsOpen;
        break;
      }
      case "admin_set_meeting": {
        // Librarian sets the 50% / 100% discussion dates for a read, identified
        // by its history timestamp. Empty dates clear that phase; clearing both
        // drops the meetings block entirely.
        const ts = String(payload.ts ?? "");
        if (!ts) throw new Error("ts required");
        const entry = state.history.find(h => h.ts === ts);
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
        entry.meetings = next;
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
        const entry = state.history.find(h => h.ts === ts);
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
        const { error } = await client.from("shelf_users").delete().eq("id", userId);
        if (error) throw error;
        state.eliminated = state.eliminated.filter(id => id !== userId);
        break;
      }
      case "admin_import_reviews": {
        // Bulk-import member rubric reviews (e.g. from a spreadsheet) on behalf
        // of readers. Each entry writes one shelf_reviews row keyed by
        // (book_ts, user_id); an existing row for that pair is overwritten.
        // Returns early — it touches shelf_reviews, not shelf_state.
        const list = Array.isArray(payload.reviews) ? payload.reviews : null;
        if (!list || !list.length) throw new Error("reviews[] required");
        const cats = ["plot", "characters", "pacing", "language", "themes"] as const;
        const rows = list.map((r, i) => {
          const rec = r as Record<string, unknown>;
          const book_ts = String(rec.book_ts ?? "");
          const user_id = String(rec.user_id ?? "");
          if (!book_ts) throw new Error(`row ${i}: book_ts required`);
          if (!user_id) throw new Error(`row ${i}: user_id required`);
          if (!state.history.some(h => h.ts === book_ts)) {
            throw new Error(`row ${i}: no read with ts ${book_ts}`);
          }
          const out: Record<string, unknown> = { book_ts, user_id };
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
          .upsert(rows, { onConflict: "book_ts,user_id" });
        if (error) throw error;
        return json({ ok: true, imported: rows.length });
      }
      case "admin_grant_librarian": {
        // Promote a reader to librarian (insert their row). Idempotent.
        const uid = String(payload.user_id ?? "");
        if (!uid) throw new Error("user_id required");
        const { error } = await client
          .from("shelf_librarians").upsert({ user_id: uid }, { onConflict: "user_id" });
        if (error) throw error;
        return json({ ok: true });
      }
      case "admin_revoke_librarian": {
        // Demote a librarian (delete their row). A librarian can't revoke
        // themselves — that avoids orphaning the club with zero librarians;
        // another librarian must do it.
        const uid = String(payload.user_id ?? "");
        if (!uid) throw new Error("user_id required");
        if (uid === callerId) throw new Error("you can't revoke your own librarian role");
        const { error } = await client.from("shelf_librarians").delete().eq("user_id", uid);
        if (error) throw error;
        return json({ ok: true });
      }
      default:
        throw new Error(`unknown action: ${action}`);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  const { error: writeErr } = await client
    .from("shelf_state")
    .upsert({ id: 1, data: state, updated_at: new Date().toISOString() });
  if (writeErr) return json({ error: writeErr.message }, 500);

  // Fire-and-await the Discord webhook after the pick is durable. Failures are
  // logged but do not affect the response — a busted webhook shouldn't block
  // the app.
  if (action === "draw" && winner) {
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
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
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
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
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
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

// Supabase Edge Function: admin-update
//
// Password-gated writes for shelf_state. Draw picks a random eligible reader
// (from shelf_users where a book is set and their id isn't already in
// eliminated). Round auto-advances when a pick empties the eligible pool.
//
// Deploy:
//   supabase functions deploy admin-update --no-verify-jwt
//   supabase secrets set ADMIN_PASSWORD='your-password-here'

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Rating = { total: number };
type HistoryItem = {
  round: number;
  winner_id: string | null;
  winner_username: string;
  book: string;
  ts: string;
  rating?: Rating | null;
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
  round: number;
  roundAdvanced: boolean;
};

async function postToDiscord(webhookUrl: string, args: DiscordArgs): Promise<void> {
  let description = `Picked by **${args.username}** for round ${args.round}.`;
  if (args.description) description += `\n\n${args.description}`;

  const embed: Record<string, unknown> = {
    title: args.book || "—",
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

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "📖 A new read has been chosen.",
        embeds: [embed],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord webhook non-2xx:", res.status, text);
    }
  } catch (err) {
    console.error("Discord webhook error:", err);
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
        }))
      : [],
    roundNumber: r.roundNumber ?? r.cycleNumber ?? 1,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const adminPw = Deno.env.get("ADMIN_PASSWORD");
  if (!adminPw) return json({ error: "ADMIN_PASSWORD not configured on the server" }, 500);

  let body: { password?: string; action?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  if (!body.password || body.password !== adminPw) {
    return json({ error: "unauthorized" }, 401);
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: row, error: readErr } = await client
    .from("shelf_state").select("data").eq("id", 1).single();
  if (readErr && readErr.code !== "PGRST116") return json({ error: readErr.message }, 500);
  const state: State = normalizeState(row?.data);

  const action = body.action;
  const payload = (body.payload ?? {}) as Record<string, unknown>;
  let winner: HistoryItem | null = null;
  let winnerAvatarUrl: string | null = null;
  let roundAdvanced = false;

  try {
    switch (action) {
      case "draw": {
        const { data: readers, error: rErr } = await client
          .from("shelf_users")
          .select("id, discord_username, book, avatar_url")
          .not("book", "is", null)
          .neq("book", "");
        if (rErr) throw rErr;
        const eliminatedSet = new Set(state.eliminated);
        const eligible = (readers ?? []).filter(u => !eliminatedSet.has(u.id));
        if (eligible.length === 0) throw new Error("no eligible readers");
        const chosen = eligible[Math.floor(Math.random() * eligible.length)];
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

        // If this pick emptied the eligible pool, roll to the next round.
        if (eligible.length - 1 === 0) {
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
        if (last.round < state.roundNumber) {
          // The undone pick had auto-advanced the round — roll back.
          state.roundNumber = last.round;
          state.eliminated = state.history
            .filter(h => h.round === last.round && h.winner_id)
            .map(h => h.winner_id as string);
        } else if (last.winner_id) {
          state.eliminated = state.eliminated.filter(id => id !== last.winner_id);
        }
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
      case "admin_remove_user": {
        const userId = String(payload.user_id ?? "");
        if (!userId) throw new Error("user_id required");
        const { error } = await client.from("shelf_users").delete().eq("id", userId);
        if (error) throw error;
        state.eliminated = state.eliminated.filter(id => id !== userId);
        break;
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
        round: winner.round,
        roundAdvanced,
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

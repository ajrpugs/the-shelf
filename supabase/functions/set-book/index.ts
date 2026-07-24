// Supabase Edge Function: set-book
//
// Client-invoked endpoint that lets a signed-in reader change (or clear) their
// own persistent book on shelf_users. Also posts a channel message to Discord
// when the book is set or updated, so the webhook URL never touches the
// browser.
//
// Deploy:
//   supabase functions deploy set-book --no-verify-jwt
//
// (--no-verify-jwt because we verify the JWT ourselves so we can pull the
// user id out; Supabase's built-in JWT check would 401 before we got there
// on any missing header, without the nice error message.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Base URL of the live app, so Discord embeds can link back to the book's page.
const SITE_URL = "https://sh3lf.net/";

// --- Open Library cover lookup -----------------------------------------------

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
  return m ? { title: m[1].trim(), author: m[2].trim() } : { title: (raw || "").trim(), author: null };
}

async function fetchCover(rawTitle: string): Promise<string | null> {
  const { title, author } = parseTitleAuthor(rawTitle);
  if (!title) return null;
  const params = new URLSearchParams({ title, limit: "5", fields: "title,cover_i" });
  if (author) params.set("author", author);
  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const docs = (body.docs ?? []) as Array<{ title?: string; cover_i?: number }>;
    const normTitle = normalizeForMatch(title);
    for (const doc of docs) {
      if (!doc.cover_i) continue;
      const resultNorm = normalizeForMatch(doc.title || "");
      if (!resultNorm) continue;
      const matches = resultNorm === normTitle || resultNorm.includes(normTitle) || normTitle.includes(resultNorm);
      if (!matches) continue;
      return `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
    }
    return null;
  } catch { return null; }
}

// --- Discord ------------------------------------------------------------------

async function postBookSet(webhookUrl: string, args: {
  book: string;
  cover: string | null;
  username: string;
  avatarUrl: string | null;
  previousBook: string | null;
  link: string | null;
}): Promise<void> {
  const embed: Record<string, unknown> = {
    title: args.book,
    description: args.previousBook
      ? `Changed from *${args.previousBook}*.`
      : `Added to the shelf.`,
    color: 0x6a8672, // sage — distinguishes book-set posts from winner posts
    footer: { text: "The Shelf · book updated" },
    timestamp: new Date().toISOString(),
  };
  if (args.link) embed.url = args.link;
  if (args.cover) embed.thumbnail = { url: args.cover };
  if (args.avatarUrl) embed.author = { name: args.username, icon_url: args.avatarUrl };
  const content = args.previousBook
    ? `📚 **${args.username}** updated their pick.`
    : `📚 **${args.username}** just added a book to the shelf.`;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed] }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Discord webhook non-2xx:", res.status, text);
    }
  } catch (err) {
    console.error("Discord webhook error:", err);
  }
}

// --- Server ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no auth token" }, 401);

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const url = Deno.env.get("SUPABASE_URL")!;

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) return json({ error: "invalid auth" }, 401);
  const userId = userData.user.id;

  let body: { book?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const book = String(body.book ?? "").trim();

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data: current } = await admin
    .from("shelf_users")
    .select("id, discord_username, avatar_url, book")
    .eq("id", userId)
    .maybeSingle();
  if (!current) return json({ error: "reader not found" }, 404);

  const prev = (current.book ?? "").trim();
  const { data: updated, error: updErr } = await admin
    .from("shelf_users")
    .update({ book: book || null, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .select()
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  // Post to Discord only when a book is set/changed. Clearing stays quiet.
  const bookChanged = book && book !== prev;
  if (bookChanged) {
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
    if (webhookUrl) {
      const cover = await fetchCover(book);
      await postBookSet(webhookUrl, {
        book,
        cover,
        username: current.discord_username || "Reader",
        avatarUrl: current.avatar_url ?? null,
        previousBook: prev || null,
        link: `${SITE_URL}#shelf=${userId}`,
      });
    }
  }

  return json({ ok: true, user: updated });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

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

// Fallback club for a request that does not name one (see clubId below).
// Matches the seeded row in supabase/schema.sql.
const DEFAULT_CLUB_ID = "8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8";

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

// Derived from a real createClient(...) call, not `ReturnType<typeof createClient>`
// -- see the note in admin-update: the latter resolves supabase-js's generics to
// never/unknown and rejects the actual client.
function createServiceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type ServiceClient = ReturnType<typeof createServiceClient>;

// The club's own Discord webhook, falling back to the project-wide env secret.
//
// Phase 6a: a club supplies its own webhook (or none, and gets no Discord posts).
// The env secret stays as the fallback so the seeded club keeps working without
// anyone re-entering anything, and so a club that wants the shared channel can
// simply not set one. club_secrets has no RLS policies -- only the service role
// can read this, which is the whole reason the table exists.
async function webhookFor(client: ServiceClient, clubId: string): Promise<string | undefined> {
  try {
    const { data } = await client
      .from("club_secrets").select("discord_webhook_url").eq("club_id", clubId).maybeSingle();
    const own = (data?.discord_webhook_url as string | null) || null;
    if (own) return own;
  } catch (err) {
    console.error("club webhook lookup failed:", err);
  }
  return Deno.env.get("DISCORD_WEBHOOK_URL") || undefined;
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

  let body: { book?: string; club_id?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const book = String(body.book ?? "").trim();

  // The caller names the club (Phase 4 slice 4b); the membership check below is
  // what makes that safe. Absent means the seeded club, so a frontend deployed
  // before this change keeps working.
  const clubId = String(body.club_id ?? DEFAULT_CLUB_ID);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId)) {
    return json({ error: "invalid club_id" }, 400);
  }

  const admin = createServiceClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // shelf_users is identity (display name, avatar) -- global, no club_id.
  const { data: current } = await admin
    .from("shelf_users")
    .select("id, discord_username, avatar_url, discord_id")
    .eq("id", userId)
    .maybeSingle();
  if (!current) return json({ error: "reader not found" }, 404);

  // The book lives on the membership row, so one person can hold a different book
  // in each of their clubs (Phase 3.5). Membership must already exist -- this is
  // an UPDATE, not the upsert it was: now that the caller names the club, an
  // upsert would let anyone insert themselves into any club and appear on its
  // shelf. Joining is Phase 4d's job (invite-gated); until then sign-in creates
  // the seeded club's membership via join_default_club().
  const { data: membership } = await admin
    .from("club_members")
    .select("book, role")
    .eq("club_id", clubId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return json({ error: "not a member of this club" }, 403);
  const prev = (membership.book ?? "").trim();

  const { data: updated, error: updErr } = await admin
    .from("club_members")
    .update({ book: book || null })
    .eq("club_id", clubId)
    .eq("user_id", userId)
    .select()
    .single();
  if (updErr) return json({ error: updErr.message }, 500);

  // Legacy mirror onto shelf_users.book, which nothing reads any more. Kept in
  // step only so the Phase 3.5 cutover stays reversible; it goes away in Phase
  // 6. Awaited (not fire-and-forget) so it actually runs before the isolate can
  // be torn down after the response is sent.
  try {
    const { error: mirrorErr } = await admin
      .from("shelf_users")
      .update({ book: book || null, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (mirrorErr) console.error("shelf_users book mirror failed:", mirrorErr.message);
  } catch (err) {
    console.error("shelf_users book mirror error:", err);
  }

  // Post to Discord only when a book is set/changed. Clearing stays quiet.
  const bookChanged = book && book !== prev;
  if (bookChanged) {
    const webhookUrl = await webhookFor(admin, clubId);
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

  // `user` is the identity row merged with this club's membership -- the exact
  // shape the client assembles in loadAll() and drops straight into its `users`
  // array, so the response contract is unchanged by the book's move to
  // club_members.
  return json({
    ok: true,
    user: {
      id: userId,
      discord_username: current.discord_username,
      avatar_url: current.avatar_url,
      discord_id: current.discord_id,
      book: book || null,
      role: (updated as { role?: string } | null)?.role ?? "member",
    },
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Supabase Edge Function: discord-interactions
//
// Receives Discord interaction webhooks (PING + slash commands). Currently
// implements one command:
//   /mybook [title]   set (or clear) your persistent book on shelf_users
//
// Deploy:
//   supabase functions deploy discord-interactions --no-verify-jwt
//   supabase secrets set DISCORD_PUBLIC_KEY='<from Discord app portal>'
//
// The function verifies every request against Discord's Ed25519 signature —
// required, or Discord refuses to save the Interactions Endpoint URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PUBLIC_KEY = Deno.env.get("DISCORD_PUBLIC_KEY") ?? "";

// Base URL of the live app, so Discord embeds can link back to the book's page.
const SITE_URL = "https://sh3lf.net/";

// The club /mybook targets. Unlike the other five functions, this one is NOT
// parameterized by slice 4b, and deliberately so: a Discord slash command has no
// URL and no session to carry a club_id, only a guild and a Discord user. Mapping
// a guild to a club needs `clubs` to know its Discord guild id, which is Phase 6
// (per-club settings, own webhook). Until then /mybook only ever works for the
// seeded club -- a reader who belongs to a second club must set that book in the
// web app. Matches the seeded row in supabase/schema.sql.
const DEFAULT_CLUB_ID = "8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8";

// Derived from an actual createClient(...) call, not `ReturnType<typeof
// createClient>` -- the latter resolves supabase-js's generic defaults to
// never/unknown, so setMemberBook would reject the real client and `.upsert()`
// would reject every object literal. Same fix as in admin-update.
function createServiceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type MyBookClient = ReturnType<typeof createServiceClient>;

// The book lives on the membership row as of Phase 3.5, so this write is the one
// that must succeed. Upsert rather than update: a reader who signed in but never
// joined has no row yet.
async function setMemberBook(client: MyBookClient, userId: string, book: string | null): Promise<boolean> {
  const { error } = await client
    .from("club_members")
    .upsert({ club_id: DEFAULT_CLUB_ID, user_id: userId, book }, { onConflict: "club_id,user_id" });
  if (error) {
    console.error("club_members book write failed:", error.message);
    return false;
  }
  // Legacy mirror onto shelf_users.book -- nothing reads it any more; kept in
  // step only so the cutover stays reversible (dropped in Phase 6).
  try {
    const { error: mirrorErr } = await client
      .from("shelf_users")
      .update({ book, updated_at: new Date().toISOString() })
      .eq("id", userId);
    if (mirrorErr) console.error("shelf_users book mirror failed:", mirrorErr.message);
  } catch (err) {
    console.error("shelf_users book mirror error:", err);
  }
  return true;
}

// The club's own Discord webhook, and nothing else. A club with none posts
// nothing, which is exactly what the Admin tab promises.
//
// Phase 8 removed a fallback to the project-wide DISCORD_WEBHOOK_URL env secret.
// This function is pinned to the seeded club (see DEFAULT_CLUB_ID below), so the
// leak was never reachable *here* -- but the copies drift if they aren't changed
// together, and the next reader of this file should not learn the old rule. See
// the fuller note on the copy in admin-update; the third is in set-book.
async function webhookFor(client: MyBookClient, clubId: string): Promise<string | undefined> {
  try {
    const { data } = await client
      .from("club_secrets").select("discord_webhook_url").eq("club_id", clubId).maybeSingle();
    return (data?.discord_webhook_url as string | null) || undefined;
  } catch (err) {
    console.error("club webhook lookup failed:", err);
    return undefined;
  }
}

// --- Open Library cover + Discord post ---------------------------------------

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
async function postBookSet(webhookUrl: string, args: {
  book: string; cover: string | null; username: string;
  avatarUrl: string | null; previousBook: string | null; link: string | null;
}): Promise<void> {
  const embed: Record<string, unknown> = {
    title: args.book,
    description: args.previousBook ? `Changed from *${args.previousBook}*.` : `Added to the shelf.`,
    color: 0x6a8672,
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
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, embeds: [embed] }),
    });
  } catch (err) { console.error("Discord webhook error:", err); }
}

// --- Ed25519 signature verification ------------------------------------------

// Return type is Uint8Array<ArrayBuffer>, not a bare Uint8Array: current TS libs
// type the latter as Uint8Array<ArrayBufferLike>, which WebCrypto's BufferSource
// rejects because it could be a SharedArrayBuffer. `new Uint8Array(n)` always
// allocates a real ArrayBuffer, so this is a type annotation only -- no runtime
// change to signature verification.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

let cachedKey: CryptoKey | null = null;
async function getPublicKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey;
  if (!PUBLIC_KEY) return null;
  try {
    cachedKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return cachedKey;
  } catch (err) {
    console.error("Failed to import Discord public key:", err);
    return null;
  }
}

async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return false;
  const key = await getPublicKey();
  if (!key) return false;
  try {
    const sigBytes = hexToBytes(signature);
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify("Ed25519", key, sigBytes, message);
  } catch (err) {
    console.error("Signature verify error:", err);
    return false;
  }
}

// --- Interaction handlers ----------------------------------------------------

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 };
const EPHEMERAL = 1 << 6;

function reply(content: string) {
  return json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  });
}

async function handleMyBook(interaction: any) {
  const discordUserId: string | undefined =
    interaction?.member?.user?.id ?? interaction?.user?.id;
  const discordUsername: string =
    interaction?.member?.user?.global_name
    ?? interaction?.member?.user?.username
    ?? interaction?.user?.global_name
    ?? interaction?.user?.username
    ?? "Reader";
  if (!discordUserId) return reply("Couldn't identify you. Sorry.");

  const options = (interaction?.data?.options ?? []) as Array<{ name: string; value: string }>;
  const titleOpt = options.find(o => o.name === "title");
  const bookTitle = String(titleOpt?.value ?? "").trim();

  const client = createServiceClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // shelf_users is the identity lookup (who owns this Discord id) -- global, no
  // club_id. The reader's book comes from their membership row below.
  const { data: user, error: lookupErr } = await client
    .from("shelf_users")
    .select("id, discord_username, avatar_url")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  if (lookupErr) {
    console.error("shelf_users lookup error:", lookupErr);
    return reply("Something went wrong looking you up. Try again.");
  }
  if (!user) {
    return reply(
      `Hey ${discordUsername} — you need to sign in on the web once first so The Shelf knows you: ${SITE_URL}`,
    );
  }

  const { data: membership } = await client
    .from("club_members")
    .select("book")
    .eq("club_id", DEFAULT_CLUB_ID)
    .eq("user_id", user.id)
    .maybeSingle();
  const prevBook = (membership?.book ?? "").trim();

  if (!bookTitle) {
    const cleared = await setMemberBook(client, user.id, null);
    if (!cleared) return reply("Couldn't clear your book. Try again.");
    return reply("📖 Cleared your book. You're off the shelf.");
  }

  const saved = await setMemberBook(client, user.id, bookTitle);
  if (!saved) return reply("Couldn't save your book. Try again.");

  // Post to the channel only when a book was actually set or changed.
  if (bookTitle !== prevBook) {
    const webhookUrl = await webhookFor(client, DEFAULT_CLUB_ID);
    if (webhookUrl) {
      const cover = await fetchCover(bookTitle);
      await postBookSet(webhookUrl, {
        book: bookTitle,
        cover,
        username: user.discord_username || discordUsername,
        avatarUrl: user.avatar_url ?? null,
        previousBook: prevBook || null,
        link: `${SITE_URL}#shelf=${user.id}`,
      });
    }
  }

  const verb = prevBook ? "Updated" : "Set";
  return reply(`📚 ${verb} your pick to **${bookTitle}**. You're on the shelf.`);
}

// --- Server ------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });

  const rawBody = await req.text();

  const ok = await verifySignature(req, rawBody);
  if (!ok) return new Response("invalid request signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400 }); }

  if (body.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }
  if (body.type === InteractionType.APPLICATION_COMMAND) {
    const name = body?.data?.name;
    if (name === "mybook") return await handleMyBook(body);
    return reply(`Unknown command: ${name}`);
  }
  return new Response("unhandled interaction type", { status: 400 });
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

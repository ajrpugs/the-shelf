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

// --- Ed25519 signature verification ------------------------------------------

function hexToBytes(hex: string): Uint8Array {
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

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: user, error: lookupErr } = await client
    .from("shelf_users")
    .select("id, discord_username, book")
    .eq("discord_id", discordUserId)
    .maybeSingle();
  if (lookupErr) {
    console.error("shelf_users lookup error:", lookupErr);
    return reply("Something went wrong looking you up. Try again.");
  }
  if (!user) {
    return reply(
      `Hey ${discordUsername} — you need to sign in on the web once first so The Shelf knows you: https://ajrpugs.github.io/the-shelf/`,
    );
  }

  if (!bookTitle) {
    const { error } = await client.from("shelf_users").update({ book: null }).eq("id", user.id);
    if (error) return reply("Couldn't clear your book. Try again.");
    return reply("📖 Cleared your book. You're off the shelf.");
  }

  const { error } = await client
    .from("shelf_users")
    .update({ book: bookTitle, updated_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return reply("Couldn't save your book. Try again.");

  const changed = (user.book ?? "").trim() && (user.book ?? "").trim() !== bookTitle;
  const verb = changed ? "Updated" : "Set";
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

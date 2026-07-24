// Supabase Edge Function: post-comment
//
// A signed-in reader posts (or deletes their own) comment on a book's
// discussion thread. Comments live in shelf_comments, keyed to a read by its
// history ts.
//
// Deploy:
//   supabase functions deploy post-comment --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

  let body: { book_ts?: string; body?: string; delete_id?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Delete: only the author's own comment.
  if (body.delete_id) {
    const { error: delErr } = await admin
      .from("shelf_comments")
      .delete()
      .eq("id", String(body.delete_id))
      .eq("user_id", userId);
    if (delErr) return json({ error: delErr.message }, 500);
    return json({ ok: true, deleted: String(body.delete_id) });
  }

  const bookTs = String(body.book_ts ?? "").trim();
  if (!bookTs) return json({ error: "book_ts required" }, 400);
  const text = String(body.body ?? "").trim().slice(0, 2000);
  if (!text) return json({ error: "comment is empty" }, 400);

  // The comment must target a real past read. History lives in its own
  // `reads` table, not shelf_state, since the Phase 0 cutover.
  const { data: match, error: readsErr } = await admin
    .from("reads")
    .select("ts")
    .eq("ts", bookTs)
    .maybeSingle();
  if (readsErr) return json({ error: readsErr.message }, 500);
  if (!match) return json({ error: "no such read" }, 404);

  const { data: saved, error: insErr } = await admin
    .from("shelf_comments")
    .insert({ book_ts: bookTs, user_id: userId, body: text })
    .select()
    .single();
  if (insErr) return json({ error: insErr.message }, 500);

  return json({ ok: true, comment: saved });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

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

// Fallback club for a request that does not name one (see clubId below). Every
// query is scoped by the resolved club -- a `book_ts` is only unique within one.
const DEFAULT_CLUB_ID = "8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8";

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

  let body: { book_ts?: string; club_id?: string; body?: string; delete_id?: string; parent_id?: string };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // The caller names the club (Phase 4 slice 4b); the membership check below is
  // what makes that safe. Absent means the seeded club, so an older deployed
  // frontend keeps working.
  const clubId = String(body.club_id ?? DEFAULT_CLUB_ID);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId)) {
    return json({ error: "invalid club_id" }, 400);
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Only a member of this club may post in it, or delete from it. A delete is
  // already narrowed to the caller's own row, but the club scoping keeps the
  // check uniform with everything else here.
  const { data: membership } = await admin
    .from("club_members").select("user_id").eq("club_id", clubId).eq("user_id", userId).maybeSingle();
  if (!membership) return json({ error: "not a member of this club" }, 403);

  // Delete: only the author's own comment.
  if (body.delete_id) {
    const { error: delErr } = await admin
      .from("shelf_comments")
      .delete()
      .eq("club_id", clubId)
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
    .eq("club_id", clubId)
    .eq("ts", bookTs)
    .maybeSingle();
  if (readsErr) return json({ error: readsErr.message }, 500);
  if (!match) return json({ error: "no such read" }, 404);

  // Threading is single-level: a reply's own parent must itself be a
  // top-level comment on the same book. Can't be a DB check constraint
  // (those can't reference other rows), so it's enforced here.
  let parentId: string | null = null;
  if (body.parent_id) {
    const { data: parent, error: parentErr } = await admin
      .from("shelf_comments")
      .select("id, book_ts, parent_id")
      .eq("club_id", clubId)
      .eq("id", String(body.parent_id))
      .maybeSingle();
    if (parentErr) return json({ error: parentErr.message }, 500);
    if (!parent) return json({ error: "no such comment to reply to" }, 404);
    if (parent.book_ts !== bookTs) return json({ error: "reply must be on the same book" }, 400);
    if (parent.parent_id) return json({ error: "can't reply to a reply" }, 400);
    parentId = parent.id;
  }

  const { data: saved, error: insErr } = await admin
    .from("shelf_comments")
    .insert({ club_id: clubId, book_ts: bookTs, user_id: userId, body: text, parent_id: parentId })
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

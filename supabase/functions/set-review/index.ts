// Supabase Edge Function: set-review
//
// Client-invoked endpoint that lets a signed-in reader submit (or clear) their
// own rubric review for one past read. A review is five category scores (1..20)
// from The Bibliomancer's Guild Review Rubric plus an optional short note. Rows
// live in shelf_reviews, keyed by (book_ts, user_id).
//
// Deploy:
//   supabase functions deploy set-review --no-verify-jwt
//
// (--no-verify-jwt because we verify the JWT ourselves to pull the user id out,
// same as set-book.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = ["plot", "characters", "pacing", "language", "themes"] as const;

// A category score must be an integer 1..20.
function coerceScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > 20) {
    throw new Error("each category score must be a whole number from 1 to 20");
  }
  return n;
}

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

  let body: {
    book_ts?: string;
    clear?: boolean;
    plot?: unknown; characters?: unknown; pacing?: unknown;
    language?: unknown; themes?: unknown; note?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const bookTs = String(body.book_ts ?? "").trim();
  if (!bookTs) return json({ error: "book_ts required" }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // The review must target a real past read. Pull the game state and confirm
  // the ts exists in history (and grab the book title for any future use).
  const { data: stateRow, error: stateErr } = await admin
    .from("shelf_state")
    .select("data")
    .eq("id", 1)
    .maybeSingle();
  if (stateErr) return json({ error: stateErr.message }, 500);
  type Read = { ts?: string; rating?: { total?: number } | null; ratingsOpen?: boolean };
  const history: Read[] = Array.isArray(stateRow?.data?.history) ? stateRow!.data.history : [];
  const entry = history.find(h => h?.ts === bookTs);
  if (!entry) return json({ error: "no such read" }, 404);

  // Clear = delete this reader's review. Allowed anytime (removes only own row).
  if (body.clear === true) {
    const { error: delErr } = await admin
      .from("shelf_reviews")
      .delete()
      .eq("book_ts", bookTs)
      .eq("user_id", userId);
    if (delErr) return json({ error: delErr.message }, 500);
    return json({ ok: true, cleared: true });
  }

  // Reviews are only accepted on the *current* read — the oldest pick that
  // hasn't been given a committed score yet — and only while the librarian has
  // opened ratings. This blocks retroactive scoring of past reads.
  const isRated = (h: Read) => !!(h?.rating && Number.isFinite(Number(h.rating.total)));
  const unrated = history.filter(h => !isRated(h));
  const current = unrated.length ? unrated[unrated.length - 1] : null;
  if (!current || current.ts !== bookTs) {
    return json({ error: "reviews are only open on the current read" }, 403);
  }
  if (current.ratingsOpen !== true) {
    return json({ error: "ratings aren't open for this read yet" }, 403);
  }

  let scores: Record<string, number>;
  try {
    scores = Object.fromEntries(CATEGORIES.map(c => [c, coerceScore((body as Record<string, unknown>)[c])]));
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  const { data: saved, error: upErr } = await admin
    .from("shelf_reviews")
    .upsert({
      book_ts: bookTs,
      user_id: userId,
      ...scores,
      note: note || null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (upErr) return json({ error: upErr.message }, 500);

  return json({ ok: true, review: saved });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Supabase Edge Function: set-review
//
// Client-invoked endpoint that lets a signed-in reader submit (or clear) their
// own rubric review for one past read. A review is five category scores (1..20)
// from The Bibliomancer's Guild Review Rubric plus an optional short note. Rows
// live in shelf_reviews, keyed by (book_ts, user_id). A reader can instead
// submit `dnf: true` to flag that they didn't finish the book -- a DNF row
// skips the rubric scores entirely (they're stored null) rather than scoring
// a book the reader didn't read to the end.
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
    club_id?: string;
    clear?: boolean;
    dnf?: unknown;
    plot?: unknown; characters?: unknown; pacing?: unknown;
    language?: unknown; themes?: unknown; note?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const bookTs = String(body.book_ts ?? "").trim();
  if (!bookTs) return json({ error: "book_ts required" }, 400);

  // The caller names the club (Phase 4 slice 4b); the membership check below is
  // what makes that safe. Required as of Phase 8 -- every query here is scoped by
  // the resolved club (a `book_ts` is only unique within one), so guessing at the
  // club is worse than refusing.
  const clubId = String(body.club_id ?? "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clubId)) {
    return json({ error: "club_id required" }, 400);
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // Only a member of this club may review its reads. Without this, anyone signed
  // in could review any club's books once they knew a club_id and a book_ts.
  const { data: membership } = await admin
    .from("club_members").select("user_id").eq("club_id", clubId).eq("user_id", userId).maybeSingle();
  if (!membership) return json({ error: "not a member of this club" }, 403);

  // The review must target a real past read. Pull all reads (history lives in
  // its own table, not shelf_state, since the Phase 0 cutover) and confirm the
  // ts exists.
  const { data: allReads, error: readsErr } = await admin
    .from("reads")
    .select("ts, rating, ratings_open")
    .eq("club_id", clubId)
    .order("ts", { ascending: false });
  if (readsErr) return json({ error: readsErr.message }, 500);
  type Read = { ts: string; rating?: { total?: number } | null; ratings_open?: boolean };
  const history: Read[] = allReads ?? [];
  const entry = history.find(h => h?.ts === bookTs);
  if (!entry) return json({ error: "no such read" }, 404);

  // Clear = delete this reader's review. Allowed anytime (removes only own row).
  if (body.clear === true) {
    const { error: delErr } = await admin
      .from("shelf_reviews")
      .delete()
      .eq("club_id", clubId)
      .eq("book_ts", bookTs)
      .eq("user_id", userId);
    if (delErr) return json({ error: delErr.message }, 500);
    return json({ ok: true, cleared: true });
  }

  // A suspended club is a moderation hold, not a delete -- see the migration
  // that added this column. Clearing your own review above stays allowed (a
  // reduction, not new activity); submitting a new one below does not.
  const { data: clubRow } = await admin
    .from("clubs").select("suspended_at").eq("id", clubId).maybeSingle();
  if (clubRow?.suspended_at) return json({ error: "This club has been suspended." }, 403);

  // Reviews are only accepted on the *current* read — the oldest pick that
  // hasn't been given a committed score yet — and only while the librarian has
  // opened ratings. This blocks retroactive scoring of past reads.
  const isRated = (h: Read) => !!(h?.rating && Number.isFinite(Number(h.rating.total)));
  const unrated = history.filter(h => !isRated(h));
  const current = unrated.length ? unrated[unrated.length - 1] : null;
  if (!current || current.ts !== bookTs) {
    return json({ error: "reviews are only open on the current read" }, 403);
  }
  if (current.ratings_open !== true) {
    return json({ error: "ratings aren't open for this read yet" }, 403);
  }

  const dnf = body.dnf === true;

  // A DNF review carries no rubric scores -- the reader didn't finish the
  // book, so there's nothing to score. A scored review still requires all
  // five categories, same as before.
  let scores: Record<string, number | null>;
  if (dnf) {
    scores = Object.fromEntries(CATEGORIES.map(c => [c, null]));
  } else {
    try {
      scores = Object.fromEntries(CATEGORIES.map(c => [c, coerceScore((body as Record<string, unknown>)[c])]));
    } catch (err) {
      return json({ error: (err as Error).message }, 400);
    }
  }

  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : null;

  const { data: saved, error: upErr } = await admin
    .from("shelf_reviews")
    .upsert({
      club_id: clubId,
      book_ts: bookTs,
      user_id: userId,
      ...scores,
      dnf,
      note: note || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "club_id,book_ts,user_id" })
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

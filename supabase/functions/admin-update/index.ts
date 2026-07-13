// Supabase Edge Function: admin-update
//
// Password-gated writes for shelf_state. Anyone can drop a book into
// shelf_submissions from the browser via RLS; only the librarian can spin
// the wheel, start a new round, or reset.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type HistoryItem = { round: number; winner: string; book: string; ts: string };
type State = {
  eliminated: string[];
  history: HistoryItem[];
  roundNumber: number;
};

const emptyState = (): State => ({ eliminated: [], history: [], roundNumber: 1 });
const norm = (s: string) => (s || "").trim().toLowerCase();

function normalizeState(raw: any): State {
  const r = raw ?? {};
  return {
    eliminated: Array.isArray(r.eliminated) ? r.eliminated : [],
    history: Array.isArray(r.history)
      ? r.history.map((h: any) => ({
          round: h.round ?? h.cycle ?? 1,
          winner: h.winner,
          book: h.book,
          ts: h.ts,
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
  let winner: { name: string; book: string } | null = null;
  let poolReset = false;

  try {
    switch (action) {
      case "draw": {
        const { data: subs, error: subErr } = await client
          .from("shelf_submissions").select("member_name, book");
        if (subErr) throw subErr;
        const submissions: Record<string, string> = {};
        (subs ?? []).forEach((r: { member_name: string; book: string }) => {
          submissions[r.member_name] = r.book;
        });
        const eliminatedNorm = new Set(state.eliminated.map(norm));
        const eligible = Object.keys(submissions).filter(n => !eliminatedNorm.has(norm(n)));
        if (eligible.length === 0) throw new Error("no eligible submissions");
        const chosen = eligible[Math.floor(Math.random() * eligible.length)];
        const book = submissions[chosen];
        state.history.unshift({
          round: state.roundNumber,
          winner: chosen,
          book,
          ts: new Date().toISOString(),
        });
        state.eliminated.push(chosen);
        winner = { name: chosen, book };
        // Clear the wheel — everyone submits again for the next round.
        await client.from("shelf_submissions").delete().neq("member_name", "");
        // Round auto-advances on each spin.
        state.roundNumber += 1;
        break;
      }
      case "reset_pool": {
        // Clear who's already been picked so anyone can win again.
        // Round number keeps ticking upward across pool resets.
        state.eliminated = [];
        await client.from("shelf_submissions").delete().neq("member_name", "");
        poolReset = true;
        break;
      }
      case "reset": {
        Object.assign(state, emptyState());
        await client.from("shelf_submissions").delete().neq("member_name", "");
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

  const { data: latestSubs } = await client
    .from("shelf_submissions").select("member_name, book");
  const submissions: Record<string, string> = {};
  (latestSubs ?? []).forEach((r: { member_name: string; book: string }) => {
    submissions[r.member_name] = r.book;
  });

  return json({ state, submissions, winner, poolReset });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// Supabase Edge Function: admin-update
//
// Password-gated writes for shelf_state. Anyone can submit their own book
// recommendation via the client, but all admin actions (add/remove members,
// draw a card, reset) go through here so the ADMIN_PASSWORD secret can guard
// them.
//
// Deploy:
//   supabase functions deploy admin-update --no-verify-jwt
//   supabase secrets set ADMIN_PASSWORD='your-password-here'
//
// The function trusts the service role to bypass RLS on shelf_state.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type State = {
  roster: string[];
  eliminated: string[];
  history: Array<{ cycle: number; winner: string; book: string; ts: string }>;
  cycleNumber: number;
};

const emptyState = (): State => ({ roster: [], eliminated: [], history: [], cycleNumber: 1 });

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
  const state: State = { ...emptyState(), ...((row?.data as State | undefined) ?? {}) };

  const action = body.action;
  const payload = body.payload ?? {};
  let winner: { name: string; book: string } | null = null;
  let cycleCompleted: number | null = null;

  try {
    switch (action) {
      case "add_member": {
        const name = String(payload.name ?? "").trim();
        if (!name) throw new Error("name required");
        if (state.roster.some(n => n.toLowerCase() === name.toLowerCase())) {
          throw new Error(`${name} is already on the shelf`);
        }
        state.roster.push(name);
        break;
      }
      case "remove_member": {
        const name = String(payload.name ?? "").trim();
        state.roster = state.roster.filter(n => n !== name);
        state.eliminated = state.eliminated.filter(n => n !== name);
        await client.from("shelf_submissions").delete().eq("member_name", name);
        break;
      }
      case "draw": {
        const { data: subs, error: subErr } = await client
          .from("shelf_submissions").select("member_name, book");
        if (subErr) throw subErr;
        const submissions: Record<string, string> = {};
        (subs ?? []).forEach((r: { member_name: string; book: string }) => {
          submissions[r.member_name] = r.book;
        });
        const eligible = Object.keys(submissions)
          .filter(n => state.roster.includes(n) && !state.eliminated.includes(n));
        if (eligible.length === 0) throw new Error("no eligible submissions");
        const chosen = eligible[Math.floor(Math.random() * eligible.length)];
        const book = submissions[chosen];
        state.history.unshift({
          cycle: state.cycleNumber,
          winner: chosen,
          book,
          ts: new Date().toISOString(),
        });
        state.eliminated.push(chosen);
        winner = { name: chosen, book };
        if (state.eliminated.length >= state.roster.length && state.roster.length > 0) {
          cycleCompleted = state.cycleNumber;
          state.eliminated = [];
          state.cycleNumber += 1;
        }
        await client.from("shelf_submissions").delete().neq("member_name", "");
        break;
      }
      case "reset": {
        const fresh = emptyState();
        Object.assign(state, fresh);
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

  return json({ state, submissions, winner, cycleCompleted });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

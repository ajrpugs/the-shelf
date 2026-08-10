// Supabase Edge Function: club-admin
//
// Phase 4 slices 4c-4e: the club lifecycle. Creating a club, issuing and
// revoking invites, joining with one, leaving, and deleting.
//
// Separate from admin-update on purpose. admin-update is gated on "you are a
// librarian of this club", which is the wrong question for half of these:
// create_club has no club yet, and join_with_invite is by definition performed by
// someone who isn't a member. Each action below states its own gate.
//
// Deploy:
//   supabase functions deploy club-admin --no-verify-jwt
//
// (--no-verify-jwt because we verify the JWT ourselves to pull the user id out,
// same as every other function here.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// See the note in admin-update: deriving the client type from a real call, not
// from ReturnType<typeof createClient>.
function createServiceClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type Client = ReturnType<typeof createServiceClient>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- Slug rules --------------------------------------------------------------
// 3-32 chars, lowercase alphanumerics and single inner hyphens. Mirrored by the
// clubs_slug_shape_chk constraint; this copy exists to give a person a reason
// rather than a 23514.
const SLUG_MIN = 3;
const SLUG_MAX = 32;

// Words a club may not claim. Two kinds: things that would collide with a route
// if the app ever moves off hash routing (/c/, /new, /join, /api...), and things
// a stranger shouldn't be able to impersonate (admin, support, official). Cheap
// to extend; impossible to reclaim once someone owns one, hence the caution.
const RESERVED_SLUGS = new Set([
  "admin", "administrator", "api", "app", "assets", "auth", "about", "blog", "c",
  "club", "clubs", "create", "css", "dashboard", "dev", "docs", "edit", "explore",
  "favicon", "feed", "help", "home", "img", "images", "invite", "invites", "join",
  "js", "legal", "login", "logout", "me", "new", "official", "privacy", "public",
  "root", "search", "settings", "shelf", "signin", "signup", "static", "status",
  "support", "system", "terms", "test", "the-shelf", "user", "users", "www",
]);

function validateSlug(raw: unknown): { slug: string } | { error: string } {
  const slug = String(raw ?? "").trim().toLowerCase();
  if (!slug) return { error: "Pick a short name for the club's link." };
  if (slug.length < SLUG_MIN) return { error: `That link is too short — at least ${SLUG_MIN} characters.` };
  if (slug.length > SLUG_MAX) return { error: `That link is too long — at most ${SLUG_MAX} characters.` };
  if (!/^[a-z0-9-]+$/.test(slug)) return { error: "Links can use lowercase letters, numbers and hyphens only." };
  if (slug.startsWith("-") || slug.endsWith("-")) return { error: "Links can't start or end with a hyphen." };
  if (slug.includes("--")) return { error: "Links can't contain two hyphens in a row." };
  if (RESERVED_SLUGS.has(slug)) return { error: `“${slug}” is reserved. Try something else.` };
  return { slug };
}

// --- Invite codes ------------------------------------------------------------
// Crockford-ish base32: no I/L/O/U, so a code read aloud or typed from a phone
// screen doesn't turn into a different valid code. 12 chars ~= 60 bits.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newInviteCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// Rate limit: how many clubs one person may create per rolling day. Open signup
// (§10 item 5) makes club creation a spam vector; this is the cheap version of
// §7's "club creation limits".
const CLUBS_PER_DAY = 3;

async function isLibrarian(client: Client, clubId: string, userId: string): Promise<boolean> {
  const { data } = await client
    .from("club_members").select("role").eq("club_id", clubId).eq("user_id", userId).maybeSingle();
  return data?.role === "librarian";
}

async function librarianCount(client: Client, clubId: string): Promise<number> {
  const { count } = await client
    .from("club_members").select("user_id", { count: "exact", head: true })
    .eq("club_id", clubId).eq("role", "librarian");
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no auth token" }, 401);

  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) return json({ error: "invalid auth" }, 401);
  const callerId = userData.user.id;

  const client = createServiceClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const action = String(body.action ?? "");

  // club_id is required by every action except create_club (no club yet),
  // join_with_invite (derives it from the code) and delete_account (spans every
  // club the caller is in).
  const clubId = String(body.club_id ?? "");
  const needsClub = !["create_club", "join_with_invite", "delete_account"].includes(action);
  if (needsClub && !UUID_RE.test(clubId)) return json({ error: "invalid club_id" }, 400);

  try {
    switch (action) {
      // --- 4c: create a club ------------------------------------------------
      // Gate: any signed-in reader, up to CLUBS_PER_DAY per rolling day.
      case "create_club": {
        const name = String(body.name ?? "").trim().slice(0, 80);
        if (!name) return json({ error: "Give the club a name." }, 400);
        const v = validateSlug(body.slug);
        if ("error" in v) return json({ error: v.error }, 400);
        const slug = v.slug;

        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: recent } = await client
          .from("clubs").select("id", { count: "exact", head: true })
          .eq("created_by", callerId).gte("created_at", since);
        if ((recent ?? 0) >= CLUBS_PER_DAY) {
          return json({ error: `You've created ${CLUBS_PER_DAY} clubs today. Try again tomorrow.` }, 429);
        }

        // The reader must have an identity row before they can be a member of
        // anything -- normally created on sign-in, but a brand-new account whose
        // first act is creating a club may not have one yet.
        const { data: identity } = await client
          .from("shelf_users").select("id").eq("id", callerId).maybeSingle();
        if (!identity) return json({ error: "Finish signing in first." }, 400);

        // Visibility defaults to private (§10 item 2) -- a new club is only
        // reachable by whoever holds its link or an invite.
        const visibility = body.visibility === "public" ? "public" : "private";

        const { data: created, error: clubErr } = await client
          .from("clubs")
          .insert({ slug, name, visibility, created_by: callerId })
          .select("id, slug, name, visibility")
          .single();
        if (clubErr) {
          // 23505 = unique violation on slug. Anything else is a real error.
          if (clubErr.code === "23505") return json({ error: `“${slug}” is already taken.` }, 409);
          throw clubErr;
        }

        // From here the club exists but isn't usable yet, so any failure below
        // has to take the club with it -- otherwise a half-built club squats its
        // slug forever. There's no cross-statement transaction over PostgREST,
        // so this unwinds by hand.
        const rollback = async (msg: string) => {
          await client.from("clubs").delete().eq("id", created.id);
          return json({ error: msg }, 500);
        };

        const { error: stateErr } = await client
          .from("shelf_state").insert({ club_id: created.id, data: { eliminated: [], roundNumber: 1 } });
        if (stateErr) return await rollback(stateErr.message);

        const { error: memberErr } = await client
          .from("club_members").insert({ club_id: created.id, user_id: callerId, role: "librarian" });
        if (memberErr) return await rollback(memberErr.message);

        // Its own calendar token, so the ICS feed is per-club from day one.
        const { error: secretErr } = await client
          .from("club_secrets").insert({ club_id: created.id });
        if (secretErr) return await rollback(secretErr.message);

        return json({ ok: true, club: created });
      }

      // --- 4d: invites ------------------------------------------------------
      // Gate: librarian of the club.
      case "create_invite": {
        if (!await isLibrarian(client, clubId, callerId)) return json({ error: "not a librarian" }, 403);
        const rawMax = body.max_uses;
        const maxUses = rawMax === null || rawMax === undefined || rawMax === ""
          ? null
          : Math.max(1, Math.min(500, Math.round(Number(rawMax))));
        if (maxUses !== null && !Number.isFinite(maxUses)) return json({ error: "max_uses must be a number" }, 400);
        const days = Math.round(Number(body.expires_in_days ?? 0));
        const expiresAt = Number.isFinite(days) && days > 0
          ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
          : null;

        const { data: invite, error } = await client
          .from("club_invites")
          .insert({ code: newInviteCode(), club_id: clubId, created_by: callerId, max_uses: maxUses, expires_at: expiresAt })
          .select("code, max_uses, uses, expires_at, revoked, created_at")
          .single();
        if (error) throw error;
        return json({ ok: true, invite });
      }

      case "revoke_invite": {
        if (!await isLibrarian(client, clubId, callerId)) return json({ error: "not a librarian" }, 403);
        const code = String(body.code ?? "").trim().toUpperCase();
        if (!code) return json({ error: "code required" }, 400);
        const { error } = await client
          .from("club_invites").update({ revoked: true }).eq("club_id", clubId).eq("code", code);
        if (error) throw error;
        return json({ ok: true });
      }

      // Gate: holding a live code. This is the only action a non-member may take.
      case "join_with_invite": {
        const code = String(body.code ?? "").trim().toUpperCase();
        if (!code) return json({ error: "Enter an invite code." }, 400);

        const { data: invite, error: invErr } = await client
          .from("club_invites")
          .select("code, club_id, uses, max_uses, expires_at, revoked")
          .eq("code", code).maybeSingle();
        if (invErr) throw invErr;
        // One message for every unusable-invite case below, so a stranger probing
        // codes learns only that this one won't work -- not whether it existed.
        const nope = () => json({ error: "That invite isn't valid any more." }, 404);
        if (!invite) return nope();
        const inviteClub = invite.club_id as string;

        const { data: existing } = await client
          .from("club_members").select("user_id")
          .eq("club_id", inviteClub).eq("user_id", callerId).maybeSingle();

        // Membership is checked BEFORE the invite's own validity: someone who is
        // already in the club should land in it when they reopen the link, even
        // once the code is spent or expired. Checking validity first made a
        // single-use invite tell its own successful user that it was invalid.
        if (existing) {
          const { data: already } = await client
            .from("clubs").select("id, slug, name, visibility").eq("id", inviteClub).single();
          return json({ ok: true, club: already, already: true });
        }

        if (
          invite.revoked
          || (invite.expires_at && new Date(invite.expires_at as string).getTime() < Date.now())
          || (invite.max_uses !== null && (invite.uses as number) >= (invite.max_uses as number))
        ) return nope();

        const { data: identity } = await client
          .from("shelf_users").select("id").eq("id", callerId).maybeSingle();
        if (!identity) return json({ error: "Finish signing in first." }, 400);

        const { error: joinErr } = await client
          .from("club_members").insert({ club_id: inviteClub, user_id: callerId, role: "member" });
        if (joinErr) throw joinErr;
        // Only a join that actually added someone spends a use.
        const { error: useErr } = await client
          .from("club_invites").update({ uses: (invite.uses as number) + 1 }).eq("code", code);
        if (useErr) console.error("invite use increment failed:", useErr.message);

        const { data: joined } = await client
          .from("clubs").select("id, slug, name, visibility").eq("id", inviteClub).single();
        return json({ ok: true, club: joined, already: false });
      }

      // --- 4e: lifecycle ----------------------------------------------------
      // Gate: membership. Leaving is always allowed EXCEPT for the last
      // librarian, who would otherwise orphan the club with no one able to
      // administer it -- they must promote someone or delete it.
      case "leave_club": {
        const { data: me } = await client
          .from("club_members").select("role").eq("club_id", clubId).eq("user_id", callerId).maybeSingle();
        if (!me) return json({ error: "You're not in this club." }, 403);
        if (me.role === "librarian" && await librarianCount(client, clubId) <= 1) {
          return json({
            error: "You're the only librarian. Make someone else a librarian first, or delete the club.",
          }, 409);
        }
        const { error } = await client
          .from("club_members").delete().eq("club_id", clubId).eq("user_id", callerId);
        if (error) throw error;
        // Legacy mirror: nothing reads shelf_users.book, but keep it in step.
        await client.from("shelf_users").update({ book: null }).eq("id", callerId);
        return json({ ok: true, left: clubId });
      }

      // Gate: librarian of the club, plus the club's own name typed back, since
      // this destroys every read, review and comment in it. The cascades that do
      // the work were added by 20260809160000 -- before that every club_id FK was
      // a plain reference and this delete would have failed with a 23503.
      // shelf_users rows survive: identity isn't owned by a club.
      case "delete_club": {
        if (!await isLibrarian(client, clubId, callerId)) return json({ error: "not a librarian" }, 403);
        const { data: target } = await client
          .from("clubs").select("id, slug, name").eq("id", clubId).maybeSingle();
        if (!target) return json({ error: "no such club" }, 404);
        if (String(body.confirm_name ?? "").trim() !== target.name) {
          return json({ error: "Type the club's name exactly to confirm." }, 400);
        }
        const { error } = await client.from("clubs").delete().eq("id", clubId);
        if (error) throw error;
        return json({ ok: true, deleted: target.slug });
      }

      // --- 6b: delete my account -------------------------------------------
      // Gate: you, deleting yourself, having typed the confirmation. There is no
      // "delete someone else" -- an admin removing a person from their club is
      // admin_remove_user in admin-update, which takes away a membership and
      // leaves the human's account alone.
      //
      // §7 has owed this since open signup was decided, and its Legal item
      // ("account deletion must genuinely delete") isn't satisfiable without it.
      case "delete_account": {
        if (String(body.confirm ?? "").trim().toUpperCase() !== "DELETE MY ACCOUNT") {
          return json({ error: 'Type "DELETE MY ACCOUNT" to confirm.' }, 400);
        }

        // The same guard leave_club applies, but across EVERY club they run.
        // Without it, deleting an account orphans clubs with no librarian and no
        // UI anywhere to appoint one.
        const { data: myRoles, error: rolesErr } = await client
          .from("club_members").select("club_id, role").eq("user_id", callerId);
        if (rolesErr) throw rolesErr;
        const soleLibrarianOf: string[] = [];
        for (const row of (myRoles ?? []) as Array<{ club_id: string; role: string }>) {
          if (row.role !== "librarian") continue;
          if (await librarianCount(client, row.club_id) <= 1) soleLibrarianOf.push(row.club_id);
        }
        if (soleLibrarianOf.length) {
          const { data: named } = await client
            .from("clubs").select("name").in("id", soleLibrarianOf);
          const names = (named ?? []).map((c: { name: string }) => c.name).join(", ");
          return json({
            error: `You're the only librarian of ${names}. Make someone else a librarian, or delete ${soleLibrarianOf.length === 1 ? "that club" : "those clubs"}, first.`,
            sole_librarian_of: soleLibrarianOf,
          }, 409);
        }

        // Deleting the auth user is the whole deletion: shelf_users, profiles,
        // club_members, shelf_reviews, shelf_comments, shelf_comment_reactions and
        // shelf_librarians all cascade from auth.users. What deliberately survives
        // is `reads` -- winner_id is ON DELETE SET NULL and winner_username is
        // plain text, so a club's ledger keeps the pick and the person disappears
        // from it. A club's history shouldn't grow holes because someone left the
        // product; the confirmation screen says so rather than leaving it to be
        // discovered. clubs.created_by is also SET NULL, so a club they founded
        // and handed over survives intact.
        const { error: delErr } = await client.auth.admin.deleteUser(callerId);
        if (delErr) return json({ error: delErr.message }, 500);
        return json({ ok: true, deleted: true });
      }

      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: (err as Error).message }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

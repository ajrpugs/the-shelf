// Supabase Edge Function: calendar-feed
//
// Serves one club's meeting schedule as a subscribable iCalendar (.ics) feed
// built from the `reads` table. Each read can carry a 50% meeting, a 100%
// meeting, and (Phase 12 §5.2) any number of additional named phases; this
// emits one VEVENT per scheduled meeting. Read-only and unauthenticated —
// calendar clients (Google/Apple/Outlook) can't send a Supabase apikey, let
// alone a JWT — so which club you get is decided by an unguessable per-club
// token instead: `?token=<club_secrets.calendar_token>`.
//
// Without that, the feed was a single global query over `reads` with no filter,
// which would have handed every subscriber every club's schedule (§9 of
// docs/multi-tenant-plan.md). A token-less request now falls back to the one
// seeded club rather than to "all clubs", so the members already subscribed to
// the original URL keep working; that fallback goes away in Phase 6 once
// everyone has re-subscribed with a token.
//
// Deploy:
//   supabase functions deploy calendar-feed --no-verify-jwt
//
// Subscribe URL:
//   https://<project-ref>.supabase.co/functions/v1/calendar-feed?token=<token>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE_URL = "https://sh3lf.net/";
const MEETING_MINUTES = 60; // each discussion is a 1-hour event

// Fallback club for token-less requests -- see the header comment.
const DEFAULT_CLUB_ID = "8fdb4e0f-ea2f-4a45-9d9a-059a3292b3f8";

type Meeting = { at?: string; upTo?: string };
// Phase 12 §5.2: any number of named phases beyond half/full. `key` is
// client-assigned once (index.html) and is exactly what UID is built from
// below -- it must never change once a phase exists, or every subscriber
// gets a duplicate rather than an update.
type ExtraMeeting = { key?: string; label?: string; at?: string };
type HistoryItem = {
  round?: number;
  book?: string;
  ts?: string;
  meetings?: { half?: Meeting; full?: Meeting; extra?: ExtraMeeting[] } | null;
};

// RFC 5545 basic-UTC timestamp: 20260805T230000Z
function icsStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    "Z"
  );
}

// Escape TEXT values per RFC 5545 (backslash, comma, semicolon, newline).
function icsText(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold long content lines to <=75 octets (simple char-based fold is fine here).
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

function buildIcs(history: HistoryItem[], clubName: string): string {
  const now = new Date();
  const dtstamp = icsStamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Shelf//Book Club//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(clubName)} — Book Club`,
    "X-WR-CALDESC:Discussion meetings for the current and past reads.",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  // `uidSuffix` is what makes an event the SAME event across feed refreshes --
  // for half/full it's the literal phase name, unchanged since before Phase
  // 12; for an extra phase it's that phase's client-assigned `key`. Changing
  // any of these later would duplicate the event for everyone already
  // subscribed, the same trap as a club-scoping the whole UID would be.
  const addEvent = (h: HistoryItem, uidSuffix: string, summarySuffix: string, desc: string, at: string) => {
    const start = new Date(at);
    if (isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + MEETING_MINUTES * 60 * 1000);
    const book = (h.book || "a read").trim();
    const summary = `📖 ${book} — ${summarySuffix}`;
    const fullDesc = `${desc} The Shelf: ${SITE_URL}#book=${h.round ?? ""}`;
    lines.push(
      "BEGIN:VEVENT",
      // Deliberately NOT club-scoped, even though `ts` is only unique per club
      // now: a UID change makes every calendar client treat the event as brand
      // new, duplicating it for everyone already subscribed. Two clubs can only
      // collide here by drawing in the same millisecond, and each feed is served
      // to its own subscribers anyway.
      `UID:shelf-${h.ts ?? h.round ?? ""}-${uidSuffix}@theshelf`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(fullDesc)}`,
      `URL:${SITE_URL}#book=${h.round ?? ""}`,
      "END:VEVENT",
    );
  };

  for (const h of history) {
    const mt = h.meetings;
    if (!mt) continue;
    if (mt.half?.at) {
      addEvent(h, "half", "50%", mt.half.upTo ? `Discuss up to ${mt.half.upTo}.` : "Halfway discussion.", mt.half.at);
    }
    if (mt.full?.at) {
      addEvent(h, "full", "100%", "Finish-the-book discussion.", mt.full.at);
    }
    for (const ex of mt.extra ?? []) {
      if (!ex?.key || !ex.at) continue;
      // Sanitized on read, not just trusted from storage: admin-update's
      // buildExtraMeetings already validates this shape at write time, but a
      // reader here shouldn't be the thing that turns a stray character into
      // a UID collision.
      const safeKey = String(ex.key).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "extra";
      const label = (ex.label || "Meeting").trim();
      addEvent(h, safeKey, label, `${label} discussion.`, ex.at);
    }
  }

  lines.push("END:VCALENDAR");
  // Fold every line last, so headers are covered too (not just event fields).
  return lines.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("GET only", { status: 405 });
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Resolve which club this feed is for. A token must match a real club (404 on
  // a bad one rather than quietly serving the default -- otherwise a typo'd or
  // revoked token would leak the seeded club's schedule).
  const token = new URL(req.url).searchParams.get("token")?.trim();
  let clubId = DEFAULT_CLUB_ID;
  if (token) {
    const { data: secret, error: secretErr } = await client
      .from("club_secrets")
      .select("club_id")
      .eq("calendar_token", token)
      .maybeSingle();
    if (secretErr) return new Response(`error: ${secretErr.message}`, { status: 500 });
    if (!secret) return new Response("unknown calendar token", { status: 404 });
    clubId = secret.club_id as string;
  }

  const { data: club } = await client
    .from("clubs").select("name").eq("id", clubId).maybeSingle();

  const { data: rows, error } = await client
    .from("reads")
    .select("round, book, ts, meetings")
    .eq("club_id", clubId);
  if (error) {
    return new Response(`error: ${error.message}`, { status: 500 });
  }

  const ics = buildIcs((rows ?? []) as HistoryItem[], (club?.name as string) || "The Shelf");

  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="the-shelf.ics"',
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

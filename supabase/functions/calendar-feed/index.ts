// Supabase Edge Function: calendar-feed
//
// Serves the book club's meeting schedule as a subscribable iCalendar (.ics)
// feed built from the `reads` table. Each read can carry a 50% and a 100% meeting;
// this emits one VEVENT per scheduled meeting. Public and read-only so anyone
// can subscribe by URL in Google/Apple/Outlook — no auth header required.
//
// Deploy:
//   supabase functions deploy calendar-feed --no-verify-jwt
//
// Subscribe URL:
//   https://<project-ref>.supabase.co/functions/v1/calendar-feed

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE_URL = "https://sh3lf.net/";
const MEETING_MINUTES = 60; // each discussion is a 1-hour event

type Meeting = { at?: string; upTo?: string };
type HistoryItem = {
  round?: number;
  book?: string;
  ts?: string;
  meetings?: { half?: Meeting; full?: Meeting } | null;
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

function buildIcs(history: HistoryItem[]): string {
  const now = new Date();
  const dtstamp = icsStamp(now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//The Shelf//Book Club//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:The Shelf — Book Club",
    "X-WR-CALDESC:50% and 100% discussion meetings for the current and past reads.",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  const addEvent = (h: HistoryItem, phase: "half" | "full", m: Meeting) => {
    if (!m.at) return;
    const start = new Date(m.at);
    if (isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + MEETING_MINUTES * 60 * 1000);
    const book = (h.book || "a read").trim();
    const pct = phase === "half" ? "50%" : "100%";
    const summary = `📖 ${book} — ${pct}`;
    let desc = phase === "half"
      ? (m.upTo ? `Discuss up to ${m.upTo}.` : "Halfway discussion.")
      : "Finish-the-book discussion.";
    desc += ` The Shelf: ${SITE_URL}#book=${h.round ?? ""}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:shelf-${h.ts ?? h.round ?? ""}-${phase}@theshelf`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(desc)}`,
      `URL:${SITE_URL}#book=${h.round ?? ""}`,
      "END:VEVENT",
    );
  };

  for (const h of history) {
    const mt = h.meetings;
    if (!mt) continue;
    if (mt.half) addEvent(h, "half", mt.half);
    if (mt.full) addEvent(h, "full", mt.full);
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

  const { data: rows, error } = await client
    .from("reads")
    .select("round, book, ts, meetings");
  if (error) {
    return new Response(`error: ${error.message}`, { status: 500 });
  }

  const ics = buildIcs((rows ?? []) as HistoryItem[]);

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

// Pure decision logic shared by admin-update's draw / undo / rating / meeting
// actions. No Supabase client, no Deno/Node built-ins — plain functions on
// plain data, so this file is both a valid Deno import at deploy time and
// directly runnable under Node for tests (see shelf-logic.test.mjs).
//
// Extracted verbatim from admin-update/index.ts's switch-case bodies — this
// is a behavior-preserving refactor, not a rewrite.

// draw: who's eligible right now, and who got picked.
export function pickEligible(readers, eliminated) {
  const eliminatedSet = new Set(eliminated);
  const eligible = (readers ?? []).filter(u => !eliminatedSet.has(u.id));
  if (eligible.length === 0) throw new Error("no eligible readers");
  const chosen = eligible[Math.floor(Math.random() * eligible.length)];
  return { eligible, chosen };
}

// draw: did this pick just empty the eligible pool (so the round should
// auto-advance)? Pass the eligible count *before* the pick was removed.
export function advanceIfEmpty(eligibleCountBeforePick) {
  return eligibleCountBeforePick - 1 === 0;
}

// draw (config.selection.mode === "rotation", Phase 9): deterministic
// replacement for pickEligible's random choice. `order` is every member id in
// stable join order (club_members.joined_at ascending); `eligibleIds`
// restricts it to who's actually pickable right now -- has a book set, and,
// when sit-out is on, hasn't already gone this round. `cursor` is the id
// rotation chose last (shelf_state.data.rotationCursor), or null before
// rotation has ever run in this club.
//
// Wraps around the *eligible* queue rather than restarting at the front of
// `order`, so a round that just turned over picks up from wherever the last
// round left off instead of always favoring whoever joined first. If the
// previous cursor is no longer eligible (book cleared, or the member left),
// indexOf returns -1 and the pick lands on the front of the queue, same as an
// unset cursor.
export function pickRotation(order, eligibleIds, cursor) {
  const eligibleSet = new Set(eligibleIds);
  const queue = order.filter(id => eligibleSet.has(id));
  if (queue.length === 0) throw new Error("no eligible readers");
  const at = cursor === null || cursor === undefined ? -1 : queue.indexOf(cursor);
  return queue[(at + 1) % queue.length];
}

// draw (config.selection.mode === "pick", Phase 9): the librarian names who's
// next. Validates against the real eligible pool rather than trusting the
// request -- same shape as pickEligible's return so the caller's bookkeeping
// (elimination, round-advance) doesn't need a third code path.
export function pickChosen(eligible, chosenId) {
  const chosen = eligible.find(u => u.id === chosenId);
  if (!chosen) throw new Error("that reader isn't eligible right now");
  return { eligible, chosen };
}

// undo_last_spin: roll roundNumber/eliminated back after popping `last` off
// the front of history. `historyAfterShift` is history with `last` already
// removed.
export function rollbackUndo(historyAfterShift, eliminated, roundNumber, last) {
  if (last.round < roundNumber) {
    // The undone pick had auto-advanced the round — roll back.
    return {
      roundNumber: last.round,
      eliminated: historyAfterShift
        .filter(h => h.round === last.round && h.winner_id)
        .map(h => h.winner_id),
    };
  }
  if (last.winner_id) {
    return { roundNumber, eliminated: eliminated.filter(id => id !== last.winner_id) };
  }
  return { roundNumber, eliminated };
}

// admin_set_rating: total must clamp to 0..100. Throws on non-numeric input,
// same as the inline version did.
export function clampRatingTotal(raw) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) throw new Error("total must be a number");
  return Math.max(0, Math.min(100, n));
}

// admin_set_rating: per-category breakdown clamps to 1..scale (Phase 10: a
// club's configured per-category max, default 20); bad values are dropped
// (undefined), not thrown.
export function clampCategoryScore(raw, scale = 20) {
  const c = Math.round(Number(raw));
  return Number.isFinite(c) ? Math.max(1, Math.min(scale, c)) : undefined;
}

// admin_set_meeting: build one meeting phase (half/full) from raw input.
// Empty/blank `at` clears that phase (returns undefined); an unparsable date
// throws.
export function buildMeeting(at, upTo) {
  const s = typeof at === "string" ? at.trim() : "";
  if (!s) return undefined;
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error("invalid meeting date");
  const m = { at: d.toISOString() };
  const u = typeof upTo === "string" ? upTo.trim() : "";
  if (u) m.upTo = u.slice(0, 200);
  return m;
}

// admin_set_meeting (Phase 12 §5.2, docs/configurability-plan.md): a club's
// discussion phases beyond the fixed 50%/100% pair. `key` is assigned once,
// client-side, when a phase is first added (index.html's
// data-me-add-extra handler) and never regenerated -- calendar-feed builds
// each VEVENT's UID from it, so a changed key would duplicate the event for
// every existing subscriber the same way changing half/full's UID would.
//
// Unlike buildMeeting, a bad row is DROPPED rather than thrown: `rawList` is
// the librarian's whole extra-phases list in one save, and one malformed or
// emptied-out row (e.g. a UI bug, or a row the reader cleared instead of
// removing) shouldn't fail every other phase in the same save. Capped at 10
// -- a sane ceiling, not a real limit anyone should hit.
export function buildExtraMeetings(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!/^[a-z0-9-]{1,40}$/i.test(key) || seen.has(key)) continue;
    const label = typeof raw?.label === "string" ? raw.label.trim().slice(0, 80) : "";
    if (!label) continue;
    const atRaw = typeof raw?.at === "string" ? raw.at.trim() : "";
    if (!atRaw) continue;
    const d = new Date(atRaw);
    if (isNaN(d.getTime())) continue;
    seen.add(key);
    out.push({ key, label, at: d.toISOString() });
    if (out.length >= 10) break;
  }
  return out;
}

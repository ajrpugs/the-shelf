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

// admin_set_rating: per-category breakdown clamps to 1..20; bad values are
// dropped (undefined), not thrown.
export function clampCategoryScore(raw) {
  const c = Math.round(Number(raw));
  return Number.isFinite(c) ? Math.max(1, Math.min(20, c)) : undefined;
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

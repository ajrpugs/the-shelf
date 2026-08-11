// Per-club configuration (Phase 9, docs/configurability-plan.md §1). Stored
// whole in clubs.config jsonb, read whole for one club at a time -- never
// queried by field, which is what makes a single jsonb column the right shape
// instead of a column per knob.
//
// The rule that makes this safe: every read of an absent key must fall back
// to today's behaviour, so a club row written before a feature existed can't
// misbehave. normalizeConfig(raw) is the one place that rule lives -- the
// client and every edge function that reads config go through it rather than
// reading clubs.config fields directly, so they can't disagree about what an
// absent key means.
//
// Plain .mjs so this is both a valid Deno import at deploy time and directly
// runnable under Node for tests (see club-config.test.mjs) -- same shape as
// shelf-logic.mjs.

// §2: how a club picks its next read. `wheel` is today's behaviour and the
// default for every club, including one whose config predates this key.
export const SELECTION_MODES = ["wheel", "rotation", "pick"];

export function normalizeConfig(raw) {
  const r = (raw && typeof raw === "object") ? raw : {};
  const s = (r.selection && typeof r.selection === "object") ? r.selection : {};
  return {
    selection: {
      mode: SELECTION_MODES.includes(s.mode) ? s.mode : "wheel",
      // Whether a pick sits out until the round turns over. Defaults true --
      // today's behaviour -- and only `false` turns it off; anything else
      // (missing, a stray string) stays on the safe/familiar side.
      sitOut: s.sitOut === false ? false : true,
    },
  };
}

// update_club's validation for the fields it accepts a patch for. Returns
// { selection } (a partial to merge onto the club's existing raw config) or
// { error }. Kept here, not duplicated in club-admin, so the accepted mode
// list can't drift from SELECTION_MODES.
export function validateSelectionPatch(body) {
  const patch = {};
  if (body.mode !== undefined) {
    const mode = String(body.mode ?? "");
    if (!SELECTION_MODES.includes(mode)) {
      return { error: `selection mode must be one of ${SELECTION_MODES.join(", ")}` };
    }
    patch.mode = mode;
  }
  if (body.sitOut !== undefined) {
    if (typeof body.sitOut !== "boolean") return { error: "sitOut must be a boolean" };
    patch.sitOut = body.sitOut;
  }
  return { selection: patch };
}

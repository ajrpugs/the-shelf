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

// §3: the rating rubric. shelf_reviews keeps its five typed columns
// (plot/characters/pacing/language/themes) physically -- these are slots a
// club turns on or off and labels, not a free-form category list. The long
// scoring-guidance prose per slot stays client-only (index.html's
// RUBRIC_ALL); the server only ever needs to know which slots are active,
// what they're called, and the per-category max.
export const RATING_SLOTS = ["plot", "characters", "pacing", "language", "themes"];

const RATING_SLOT_LABELS = {
  plot: "Plot",
  characters: "Characters",
  pacing: "Organization / Pacing",
  language: "Use of Language",
  themes: "Themes / Ideas",
};

const DEFAULT_RATING_CATEGORIES = RATING_SLOTS.map(slot => ({ slot, label: RATING_SLOT_LABELS[slot] }));

// A locked read snapshots the rubric it was scored under (admin-update's
// admin_set_rating), so a later rename/reorder of the club's live categories
// can't scramble what a past score means. Same normalizer as the live
// config's rating key -- a read locked before this snapshot existed has no
// `profile` field at all, and normalizing `undefined` here is exactly
// today's behaviour, which is the fallback callers should use for those rows.
export function normalizeRatingProfile(raw) {
  const r = (raw && typeof raw === "object") ? raw : {};
  const scale = Number.isInteger(r.scale) && r.scale >= 2 && r.scale <= 20 ? r.scale : 20;
  let categories = Array.isArray(r.categories) ? r.categories : null;
  if (categories) {
    const seen = new Set();
    categories = categories
      .filter(c => c && typeof c === "object" && RATING_SLOTS.includes(c.slot) && !seen.has(c.slot) && seen.add(c.slot))
      .slice(0, RATING_SLOTS.length)
      .map(c => ({
        slot: c.slot,
        label: (typeof c.label === "string" && c.label.trim()) ? c.label.trim().slice(0, 40) : RATING_SLOT_LABELS[c.slot],
      }));
  }
  // Zero valid entries (missing key, empty array, garbage) falls back to all
  // five under their canonical labels -- today's behaviour.
  if (!categories || !categories.length) categories = DEFAULT_RATING_CATEGORIES;
  const scoreLabel = (typeof r.scoreLabel === "string" && r.scoreLabel.trim())
    ? r.scoreLabel.trim().slice(0, 40)
    : "Club score";
  return { scale, categories, scoreLabel };
}

// §4.2: per-club Discord event toggles. All default true -- today's
// behaviour, posting on every one of these -- so a club whose config
// predates this key keeps announcing exactly what it already does.
export const NOTIFY_EVENTS = ["draw", "bookSet", "meeting", "rating", "mentionWinner"];

function normalizeNotify(raw) {
  const r = (raw && typeof raw === "object") ? raw : {};
  // Built as a literal, not a loop over NOTIFY_EVENTS, so `deno check` can
  // infer concrete keys on the result -- a dynamically-built object types as
  // `{}` and every caller reading e.g. .draw off it fails to typecheck. See
  // CLAUDE.md: deno check is the only thing that typechecks the edge
  // functions, and this is exactly the class of thing it catches.
  const on = (k) => r[k] === false ? false : true;
  return {
    draw: on("draw"),
    bookSet: on("bookSet"),
    meeting: on("meeting"),
    rating: on("rating"),
    mentionWinner: on("mentionWinner"),
  };
}

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
    rating: normalizeRatingProfile(r.rating),
    notify: normalizeNotify(r.notify),
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

// update_club's validation for a rating-profile patch. Same shape as
// validateSelectionPatch: returns { rating } (a partial to merge) or
// { error }. Slots are restricted to RATING_SLOTS -- the five physical
// shelf_reviews columns -- so a club can never name a category the schema
// doesn't have a place for.
export function validateRatingPatch(body) {
  const patch = {};
  if (body.scale !== undefined) {
    const n = Math.round(Number(body.scale));
    if (!Number.isInteger(n) || n < 2 || n > 20) return { error: "scale must be a whole number from 2 to 20" };
    patch.scale = n;
  }
  if (body.scoreLabel !== undefined) {
    const label = String(body.scoreLabel ?? "").trim();
    if (!label) return { error: "score label can't be empty" };
    if (label.length > 40) return { error: "score label is too long (40 characters max)" };
    patch.scoreLabel = label;
  }
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories) || !body.categories.length) {
      return { error: "pick at least one rating category" };
    }
    const seen = new Set();
    const categories = [];
    for (const c of body.categories) {
      const slot = c && c.slot;
      if (!RATING_SLOTS.includes(slot)) return { error: `unknown category "${slot}"` };
      if (seen.has(slot)) return { error: `"${slot}" is listed twice` };
      seen.add(slot);
      const label = String((c && c.label) ?? "").trim();
      if (!label) return { error: "every category needs a label" };
      if (label.length > 40) return { error: "category labels are limited to 40 characters" };
      categories.push({ slot, label });
    }
    patch.categories = categories;
  }
  return { rating: patch };
}

// update_club's validation for a notify patch. Same shape as the other two:
// returns { notify } (a partial to merge) or { error }.
export function validateNotifyPatch(body) {
  const patch = {};
  for (const key of NOTIFY_EVENTS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { error: `${key} must be a boolean` };
    patch[key] = body[key];
  }
  return { notify: patch };
}

// The normalization Phase 10 asks for: a category count / scale independent
// way to land on a /100 total. With the full 5-category, scale-20 default
// this is bit-identical to the old "sum five categories" formula (5*20=100),
// which is what keeps every existing Guild score meaning the same thing.
// `values` are already restricted to the active categories.
export function normalizeRatingTotal(values, scale) {
  if (!values.length || !scale) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round((sum / (values.length * scale)) * 100);
}

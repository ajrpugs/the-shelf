#!/usr/bin/env bash
# Take a verified backup of the linked Supabase project.
#
# Why it matters: `supabase backups list` reports pitr_enabled=false with an
# empty backup list on this project's plan, so THIS IS THE ONLY RESTORE POINT
# the book club has. Run it before any `supabase db push`, and on a schedule.
#
# Produces two independent backups into ~/the-shelf-backups/<timestamp>/, because
# each covers what the other can't:
#
#   pg_dump (schema.sql + data.sql + roles.sql) -- REQUIRES DOCKER, since
#     `supabase db dump` runs pg_dump in a container. Start it with
#     `colima start` (and `colima stop` when done). This is the one that
#     captures DDL, RLS policies, functions and grants, and crucially
#     auth.users/auth.identities -- so member ids survive a restore into a
#     fresh project. Skipped with a warning if Docker isn't running.
#
#   restore.sql -- a single query (therefore a single consistent transaction)
#     emitting one INSERT per public table, rebuilding rows from JSON via
#     jsonb_populate_recordset so a later column reorder can't corrupt it.
#     Needs no Docker, and it's the half that gets VERIFIED: row counts are
#     checked against live and a mismatch exits non-zero. public-schema data
#     only -- no DDL, no auth.
#
# Verifying the JSON snapshot also cross-checks the pg_dump: both are taken
# seconds apart, so matching counts mean neither was truncated.
#
# CONTAINS SECRETS AND MEMBER DATA: club_secrets (Discord webhook URL, calendar
# token), every member's name/book/reviews/comments, and in data.sql the auth
# tables including refresh tokens. Written outside the repo on purpose, chmod
# 600. Keep it off shared drives and out of git.
#
# Usage: scripts/backup.sh [output-root]     (default: ~/the-shelf-backups)

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_root="${1:-$HOME/the-shelf-backups}"
stamp="$(date +%Y%m%d-%H%M%S)"
dir="$out_root/$stamp"
sql_dir="$repo_root/supabase/backup-sql"

command -v supabase >/dev/null || { echo "supabase CLI not found" >&2; exit 1; }
command -v node >/dev/null     || { echo "node not found (brew install node)" >&2; exit 1; }

mkdir -p "$dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --linked resolves the project ref from supabase/.temp/, so run from the repo.
cd "$repo_root"

# pg_dump first: it's the richer artifact, and the one that needs Docker. A dead
# Docker must not stop the verified snapshot below from being taken.
if docker info >/dev/null 2>&1; then
  echo "pg_dump (schema, data, roles)..."
  # No flags = schema dump; there is no --schema-only (see `supabase db dump -h`).
  for part in ":schema.sql" "--data-only --use-copy:data.sql" "--role-only:roles.sql"; do
    flags="${part%%:*}"; file="${part##*:}"
    # shellcheck disable=SC2086
    if supabase db dump --linked $flags -f "$dir/$file" >/dev/null 2>&1; then
      echo "  ok   $file ($(wc -c < "$dir/$file" | tr -d ' ') bytes)"
    else
      echo "  FAIL $file" >&2; exit 1
    fi
  done
else
  echo "WARNING: Docker is not running — skipping pg_dump (no DDL, no auth.users)." >&2
  echo "         Start it with 'colima start' and re-run for a full backup." >&2
fi

echo "Snapshotting public data (verified)..."
supabase db query --linked -f "$sql_dir/snapshot.sql" 2>/dev/null | grep -v '^Initialising' > "$tmp/snapshot.json"
node -e '
  const fs = require("fs");
  const sql = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).rows[0].backup;
  fs.writeFileSync(process.argv[2], sql + "\n");
' "$tmp/snapshot.json" "$dir/restore.sql"

echo "Verifying row counts against live..."
supabase db query --linked -f "$sql_dir/counts.sql" 2>/dev/null | grep -v '^Initialising' > "$tmp/counts.json"
node - "$tmp/counts.json" "$dir/restore.sql" <<'NODE'
const fs = require("node:fs");
const parsed = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).rows[0].c;
const live = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
const sql = fs.readFileSync(process.argv[3], "utf8");
const re = /insert into public\.(\w+) select \* from jsonb_populate_recordset\(null::public\.\w+, (.*)\);$/gm;
const got = {}; const bad = [];
let m;
while ((m = re.exec(sql))) {
  let lit = m[2].trim();
  if (lit.startsWith("'") && lit.endsWith("'")) lit = lit.slice(1, -1).replaceAll("''", "'");
  try { got[m[1]] = JSON.parse(lit).length; } catch (e) { bad.push(`${m[1]}: ${e.message}`); }
}
let fail = 0;
for (const t of Object.keys(live)) {
  const ok = live[t] === got[t];
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${t.padEnd(24)} live=${String(live[t]).padStart(5)} backup=${String(got[t]).padStart(5)}`);
}
if (bad.length) { console.log("  unparsed: " + bad.join("; ")); fail += bad.length; }
if (fail) { console.error(`\nBACKUP NOT TRUSTWORTHY — ${fail} mismatch(es)`); process.exit(1); }
NODE

chmod 600 "$dir"/*.sql
echo
echo "Backup verified → $dir"
ls -1sh "$dir" | tail -n +2 | sed 's/^/  /'

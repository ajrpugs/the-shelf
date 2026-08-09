#!/usr/bin/env bash
# Apply pending migrations to the LINKED PRODUCTION database inside a transaction
# and roll back, proving they work against the real schema and the real data
# without committing anything.
#
# This complements a local `supabase db reset` rather than replacing it. The local
# DB proves a migration APPLIES; this proves it applies TO THE REAL DATA without
# changing anything -- real schema, real row counts, real constraint contents, and
# any backfill running over the actual rows. BEGIN/ROLLBACK means nothing is kept,
# including on failure, where Postgres aborts the transaction for us.
#
# Run both. A migration that's clean locally can still surprise you on production
# data (a backfill that overwrites, a constraint an outlier row violates).
#
# It is still a WRITE to production for the life of the transaction. It takes
# ordinary row locks while it runs. Don't run it mid-spin.
#
# Usage: scripts/rehearse-migrations.sh <migration.sql> [more.sql ...]
#
# A clean run prints the migrations' own output and nothing else; any error means
# the migration would have failed on a real push. Verify afterwards with
# scripts/../supabase/backup-sql/counts.sql that nothing changed.

set -euo pipefail

[ $# -gt 0 ] || { echo "usage: $0 <migration.sql> [more.sql ...]" >&2; exit 1; }
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
{
  echo "begin;"
  for f in "$@"; do
    [ -f "$f" ] || { echo "no such file: $f" >&2; exit 1; }
    echo "-- >>> $f"
    cat "$f"
  done
  echo "rollback;"
} > "$tmp/rehearsal.sql"

echo "Rehearsing $# migration(s) against the linked project (will roll back)..."
if supabase db query --linked -f "$tmp/rehearsal.sql" 2>&1 | grep -v '^Initialising'; then
  echo
  echo "OK — applied and rolled back cleanly. Nothing was committed."
else
  echo
  echo "FAILED — these migrations would not apply. Nothing was committed." >&2
  exit 1
fi

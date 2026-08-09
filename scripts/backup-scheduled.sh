#!/usr/bin/env bash
# launchd wrapper around scripts/backup.sh. Installed as a daily user LaunchAgent
# (net.sh3lf.backup) -- see the "Backups" section of CLAUDE.md for install/remove.
#
# launchd gives a job almost no environment, so everything it needs is set here:
# PATH (Homebrew isn't on the default one) and TMPDIR (Colima can't mount macOS's
# /var/folders default -- the same trap that breaks `functions deploy`).
#
# Best-effort Colima: if the VM isn't up, this starts it so the backup includes
# the pg_dump half (DDL, RLS policies, auth.users), then stops it again if it was
# the one that started it. If Colima can't start, backup.sh still produces the
# verified public-data snapshot -- a degraded backup beats a skipped one.
#
# Honest limits of a scheduled local backup: it only runs while this Mac is awake
# and logged in, and it depends on the Supabase CLI's stored credentials still
# being valid. It is not a substitute for Supabase Pro's PITR. Check the log.

set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TMPDIR="$HOME/tmp"
mkdir -p "$TMPDIR"

# Name the project outright rather than relying on `--linked` finding
# supabase/.temp/ -- the staged copy has no repo to find it in. Not a secret; the
# ref is already in CLAUDE.md and every function URL.
export SUPABASE_PROJECT_ID="yoobgxxyvcmsianfczam"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Staged layout keeps its own SQL beside it; in-repo it lives under supabase/.
[ -d "$here/backup-sql" ] && export SHELF_SQL_DIR="$here/backup-sql"
log="$HOME/the-shelf-backups/backup.log"
mkdir -p "$(dirname "$log")"

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log"; }

say "=== scheduled backup starting ==="

started_colima=0
if ! docker info >/dev/null 2>&1; then
  if command -v colima >/dev/null 2>&1; then
    say "starting colima for pg_dump..."
    if colima start >>"$log" 2>&1; then started_colima=1; else say "colima start failed; continuing without pg_dump"; fi
  else
    say "no colima installed; continuing without pg_dump"
  fi
fi

if "$here/backup.sh" >>"$log" 2>&1; then
  say "backup OK"
  rc=0
else
  rc=$?
  say "BACKUP FAILED (exit $rc) -- the club has no fresh restore point"
fi

if [ "$started_colima" -eq 1 ]; then
  say "stopping colima"
  colima stop >>"$log" 2>&1 || say "colima stop failed"
fi

say "=== scheduled backup finished (exit $rc) ==="
exit "$rc"

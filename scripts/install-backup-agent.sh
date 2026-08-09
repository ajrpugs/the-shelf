#!/usr/bin/env bash
# Install (or refresh) the daily backup LaunchAgent.
#
# Why this stages a COPY outside the repo instead of just pointing launchd at
# scripts/: this repo lives under ~/Documents, which macOS TCC protects. A
# launchd agent cannot read it at all -- the job dies with exit 126 and
# "Operation not permitted" before the script's first line runs. Granting Full
# Disk Access would fix it, but that's a manual System Settings step; staging a
# copy under ~/Library/Application Support needs no permission grant.
#
# The staged copy is a SNAPSHOT. Re-run this script after changing
# scripts/backup.sh or supabase/backup-sql/ -- otherwise the scheduled backup
# keeps using the old versions, and (worst case) silently stops capturing a table
# you added.
#
# Usage:  scripts/install-backup-agent.sh          install / refresh
#         scripts/install-backup-agent.sh --remove uninstall

set -euo pipefail

LABEL="net.sh3lf.backup"
STAGE="$HOME/Library/Application Support/the-shelf-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$STAGE"
  echo "Removed $LABEL, its plist, and the staged copy."
  echo "Existing backups in ~/the-shelf-backups were left alone."
  exit 0
fi

echo "Staging to: $STAGE"
mkdir -p "$STAGE/backup-sql"
cp "$repo_root/scripts/backup.sh"           "$STAGE/backup.sh"
cp "$repo_root/scripts/backup-scheduled.sh" "$STAGE/backup-scheduled.sh"
cp "$repo_root/supabase/backup-sql/"*.sql   "$STAGE/backup-sql/"
chmod +x "$STAGE/backup.sh" "$STAGE/backup-scheduled.sh"
echo "  staged: $(ls -1 "$STAGE" "$STAGE/backup-sql" | grep -c '\.\(sh\|sql\)$') files"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$STAGE/backup-scheduled.sh</string></array>
  <!-- StartCalendarInterval (not StartInterval): a missed run fires once when the
       Mac next wakes, instead of drifting by uptime. -->
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
  <key>WorkingDirectory</key><string>$STAGE</string>
  <key>StandardOutPath</key><string>$HOME/the-shelf-backups/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/the-shelf-backups/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null
mkdir -p "$HOME/the-shelf-backups"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL — daily at 13:00."
echo
echo "Verify now with:  launchctl kickstart -w gui/$(id -u)/$LABEL"
echo "                  tail -f ~/the-shelf-backups/backup.log"
echo "Remove with:      scripts/install-backup-agent.sh --remove"

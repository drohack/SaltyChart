#!/bin/bash
# SaltyChart auto-updater — reference copy of the Unraid User Script.
#
# Install on Unraid: Settings → User Scripts → Add New Script
# ("update_saltychart"), paste this file, set a custom cron of
#   */10 * * * *
#
# What it does every 10 minutes:
#   1. `docker compose pull` in the appdata compose dir.
#   2. If neither :latest image changed → exit silently (the common case).
#   3. If a new image arrived: back up the DB first (existing
#      backup_saltychart_db User Script), swap containers with
#      `docker compose up -d`, prune the now-untagged old images, and log.
#
# The SQLite DB lives in the external named volume `saltychart_db`, which
# pull/up -d never touch — the backup is belt-and-suspenders.

set -u

COMPOSE_DIR="/mnt/user/appdata/saltychart"
BACKUP_SCRIPT="/boot/config/plugins/user.scripts/scripts/backup_saltychart_db/script"
LOG_FILE="$COMPOSE_DIR/update.log"

IMAGES=(
  "ghcr.io/drohack/saltychart-backend:latest"
  "ghcr.io/drohack/saltychart-frontend:latest"
)

cd "$COMPOSE_DIR" || { echo "compose dir missing: $COMPOSE_DIR"; exit 1; }

image_ids() {
  for img in "${IMAGES[@]}"; do
    docker image inspect --format '{{.Id}}' "$img" 2>/dev/null || echo "missing"
  done
}

before=$(image_ids)

if ! docker compose pull -q; then
  echo "$(date '+%F %T') pull failed (registry unreachable?) — containers untouched" >> "$LOG_FILE"
  exit 1
fi

after=$(image_ids)

if [ "$before" = "$after" ]; then
  exit 0    # nothing new — stay quiet so the cron log doesn't fill up
fi

echo "$(date '+%F %T') new image(s) pulled — backing up DB before swap" >> "$LOG_FILE"

# /boot is mounted noexec on Unraid, so invoke via bash rather than directly
if [ -f "$BACKUP_SCRIPT" ]; then
  if ! bash "$BACKUP_SCRIPT" >> "$LOG_FILE" 2>&1; then
    echo "$(date '+%F %T') BACKUP FAILED — aborting update, containers untouched" >> "$LOG_FILE"
    exit 1
  fi
else
  echo "$(date '+%F %T') WARNING: backup script not found at $BACKUP_SCRIPT — continuing without backup" >> "$LOG_FILE"
fi

if docker compose up -d; then
  docker image prune -f > /dev/null
  echo "$(date '+%F %T') updated + old images pruned" >> "$LOG_FILE"
else
  echo "$(date '+%F %T') compose up FAILED — check container state" >> "$LOG_FILE"
  exit 1
fi

#!/bin/bash
# SaltyChart DB backup - reference copy of the Unraid User Script
# "backup_saltychart_db" (Settings -> User Scripts, scheduled monthly).
#
# Backs up the LIVE SQLite DB, which is bind-mounted at
# /mnt/user/appdata/saltychart/prisma (NOT the legacy `saltychart_db` docker
# volume - that volume went stale in April 2026 when the stack moved to a
# bind mount, and the old volume-based script silently backed up April data
# for months).
#
# Uses the SQLite online-backup API through the running backend container,
# so the snapshot is consistent even if the app writes mid-backup. Falls
# back to a raw file copy if the container is down (safe then - no writers).

BACKUP_DIR="/mnt/user/backup/saltychart"
DATA_DIR="/mnt/user/appdata/saltychart/prisma"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="${BACKUP_DIR}/saltychart_db_${TIMESTAMP}.tar.gz"
MAX_BACKUPS=3

mkdir -p "$BACKUP_DIR"

if docker exec saltychart-backend python3 -c "import sqlite3; s=sqlite3.connect('/app/prisma/data.db'); d=sqlite3.connect('/app/prisma/backup_snapshot.db'); s.backup(d); d.close(); s.close()" 2>/dev/null; then
  echo "[INFO] Consistent snapshot taken via SQLite online-backup API"
  tar czf "$BACKUP_FILE" -C "$DATA_DIR" backup_snapshot.db
  rm -f "$DATA_DIR/backup_snapshot.db"
else
  echo "[WARN] Backend container not running - raw copy of data.db (+wal/shm)"
  (cd "$DATA_DIR" && tar czf "$BACKUP_FILE" data.db $(ls data.db-wal data.db-shm 2>/dev/null))
fi

echo "[INFO] Backup written: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

echo "[INFO] Pruning old backups (keeping latest $MAX_BACKUPS)..."
ls -1t "${BACKUP_DIR}/saltychart_db_"*.tar.gz | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm -f

echo "[DONE] Backup complete."

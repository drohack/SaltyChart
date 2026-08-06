#!/bin/bash
# SaltyChart DB restore - reference copy of the Unraid User Script
# "restore_saltychart_db". Run from a terminal (it prompts for confirmation).
#
#   bash .../restore_saltychart_db/script                     # newest backup
#   bash .../restore_saltychart_db/script saltychart_db_2026-07-09_22-53-41.tar.gz
#
# Restores into the LIVE bind-mounted data dir
# (/mnt/user/appdata/saltychart/prisma), stopping the backend around the
# swap. Handles both backup formats: new ones contain backup_snapshot.db
# (online-backup API), legacy volume-based ones contain data.db.
# The pre-restore live DB is kept as data.db.pre-restore as an undo.

BACKUP_DIR="/mnt/user/backup/saltychart"
DATA_DIR="/mnt/user/appdata/saltychart/prisma"

BACKUP_FILE="$1"
if [[ -z "$BACKUP_FILE" ]]; then
  BACKUP_FILE=$(ls -1t "${BACKUP_DIR}/saltychart_db_"*.tar.gz 2>/dev/null | head -n 1)
  echo "[INFO] No filename passed. Restoring most recent backup: $BACKUP_FILE"
else
  BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILE}"
  echo "[INFO] Restoring user-specified backup: $BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[ERROR] Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "[WARN] This will overwrite the live DB at $DATA_DIR/data.db with $BACKUP_FILE"
read -p "Proceed? (y/n): " CONFIRM
if [[ "$CONFIRM" != "y" ]]; then
  echo "[ABORTED]"
  exit 0
fi

TMP_DIR=$(mktemp -d)
tar xzf "$BACKUP_FILE" -C "$TMP_DIR"

if [[ -f "$TMP_DIR/backup_snapshot.db" ]]; then
  RESTORED="$TMP_DIR/backup_snapshot.db"
elif [[ -f "$TMP_DIR/data.db" ]]; then
  RESTORED="$TMP_DIR/data.db"          # legacy volume-format backup
else
  echo "[ERROR] No database found inside $BACKUP_FILE"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo "[INFO] Stopping backend..."
docker stop saltychart-backend

mv -f "$DATA_DIR/data.db" "$DATA_DIR/data.db.pre-restore" 2>/dev/null
rm -f "$DATA_DIR/data.db-wal" "$DATA_DIR/data.db-shm"
cp "$RESTORED" "$DATA_DIR/data.db"
chmod 664 "$DATA_DIR/data.db"
rm -rf "$TMP_DIR"

echo "[INFO] Starting backend..."
docker start saltychart-backend

echo "[DONE] Restore complete. Previous live DB kept at $DATA_DIR/data.db.pre-restore"

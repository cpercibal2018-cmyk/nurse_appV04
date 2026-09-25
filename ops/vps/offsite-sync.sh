#!/bin/bash
# ops/vps/offsite-sync.sh — copies the encrypted backups off the VPS (decision
# D-57), every 15 minutes (nurseapp-offsite.timer). A single machine is a
# single point of loss: without this copy, losing the VPS loses the backups too.
#
# /etc/nurseapp/offsite.env (root-only):
#   RCLONE_REMOTE=ksa-backup:nurseapp-backups   an rclone remote + bucket, in the Kingdom (§1)
#   RCLONE_CONFIG=/etc/nurseapp/rclone.conf     its credentials (write-only if the provider allows)
#
# What is copied — all of it already encrypted on the VPS:
#   wal/, full/   the backup kit's GPG-encrypted WAL and nightly base backups
#   storage/      the document vault's objects (AES-256-GCM, D-53)
# The destination bucket MUST have versioning on and a lifecycle rule that
# deletes non-current versions after 31 days (README.md §5). Then this mirror
# is safe both ways: what the VPS prunes or erases (an erased identity scan,
# D-55) disappears off-site within the backup window the erasure record
# states, and someone who takes over the VPS cannot destroy the off-site copy
# for 31 days.

set -euo pipefail
# shellcheck disable=SC1091
source /etc/nurseapp/offsite.env
: "${RCLONE_REMOTE:?set RCLONE_REMOTE in /etc/nurseapp/offsite.env}"
export RCLONE_CONFIG="${RCLONE_CONFIG:-/etc/nurseapp/rclone.conf}"
STORE="${BACKUP_STORAGE_PATH:-/srv/backup}"
VAULT="${VAULT_PATH:-/srv/nurseapp/storage}"
LOG=/var/log/aigh-backup.log

rclone sync "$STORE/wal" "$RCLONE_REMOTE/wal" --transfers 4 --log-level NOTICE
rclone sync "$STORE/full" "$RCLONE_REMOTE/full" --transfers 2 --log-level NOTICE
rclone sync "$VAULT" "$RCLONE_REMOTE/storage" --transfers 4 --log-level NOTICE
echo "$(date -u +%FT%TZ) offsite-sync: copied to $RCLONE_REMOTE" >> "$LOG"

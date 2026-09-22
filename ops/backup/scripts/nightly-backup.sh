#!/bin/bash
# ops/backup/scripts/nightly-backup.sh
# Full base backup, packed, encrypted and verified.
#
# F-23 FIX 1: `pg_basebackup --format=tar` writes a DIRECTORY containing
#   base.tar.gz (and pg_wal.tar.gz) — there is no single ${BACKUP_FILE}.tar.gz.
#   The reviewed baseline encrypted a path that never existed.
# F-23 FIX 2: `--gzip` is not a pg_basebackup option; bare `--compress=6` is the
#   pre-15 form. PostgreSQL 15 uses `--compress=gzip:6`.
# F-23 FIX 3: encryption is asymmetric (public key). Decryptability is proven
#   from the restore host during the drill — the private key is not here.

set -euo pipefail

: "${BACKUP_STORAGE_PATH:?}"
: "${BACKUP_ENCRYPTION_KEY_PATH:?}"
: "${DB_HOST:?}"; : "${DB_PORT:?}"; : "${DB_BACKUP_USER:?}"

PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_STORAGE_PATH}/full"
BACKUP_FILE="${BACKUP_DIR}/basebackup_${TIMESTAMP}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
LOG_FILE="${BACKUP_LOG_FILE:-/dev/null}"
WAL_DIR="${BACKUP_STORAGE_PATH}/wal"
# Shared with restore-database.sh on purpose. The conflict is not I/O, it is step 7:
# a restore picks a base backup out of ${BACKUP_DIR} and then replays WAL for minutes,
# and a concurrent backup would prune that same archive underneath it.
LOCK_FILE="${GATE1_LOCK_FILE:-${BACKUP_STORAGE_PATH}/.gate1.lock}"

log() { printf '%s nightly-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

mkdir -p "${BACKUP_DIR}"

# 0. Mutual exclusion — G6 FIX. Two runs starting in the same UTC second compute the
# same BACKUP_FILE and collide on `tar -czf`; more commonly a slow backup overlaps the
# next cron tick, doubling I/O and widening the plaintext window (G1).
#
# Taken NON-BLOCKING and refused rather than queued: a nightly job that cannot start
# should report failure to whatever scheduled it, not silently run late and collide
# with the next tick. The lock is released by process exit — nothing to clean up.
#
# wal-archive.sh and wal-restore.sh deliberately never take this lock. PostgreSQL
# spawns them through archive_command / restore_command *while* this script holds it
# (and while restore-database.sh holds it), so a lock there would deadlock recovery.
#
# If flock(1) is missing this FAILS OPEN with a warning rather than refusing to back up.
# The kit already assumes GNU userland (stat -c%s, date -d, find -mtime), so a host
# without util-linux is out of spec either way — but "no backup exists" is a strictly
# worse DR outcome than "backup taken without mutual exclusion".
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock --nonblock 9; then
    log "ERROR: another backup-kit run holds ${LOCK_FILE} — this backup is SKIPPED"
    exit 1
  fi
else
  log "WARNING: flock(1) not found — running WITHOUT mutual exclusion (install util-linux)"
fi

# The lock serialises runs but does not make the timestamp unique: a run that finishes
# inside the same UTC second as the previous one computes the same BACKUP_FILE and would
# silently overwrite a backup that is already in the archive. Refuse instead — a
# same-second re-run is a scheduling mistake worth surfacing, not papering over.
if [ -e "${BACKUP_FILE}.tar.gz.gpg" ]; then
  log "ERROR: $(basename "${BACKUP_FILE}").tar.gz.gpg already exists — two runs in the same UTC second; refusing to overwrite it"
  exit 1
fi

log "starting backup ${TIMESTAMP}"

# Captured BEFORE pg_basebackup. The LSN current at this instant is at or before the
# backup's own START WAL LOCATION, so as a retention floor it errs towards keeping too
# much WAL rather than too little. Step 4 prefers the exact value from backup_label and
# falls back to this one; step 7 refuses to prune at all if neither is available.
PRE_BACKUP_LSN="$("${PGBIN}/psql" -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_BACKUP_USER}" \
  -tAc 'SELECT pg_current_wal_lsn()' 2>/dev/null || echo '')"

# 1. Base backup — PostgreSQL 15 syntax
"${PGBIN}/pg_basebackup" \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_BACKUP_USER}" \
  --pgdata="${BACKUP_FILE}" \
  --format=tar \
  --compress=gzip:6 \
  --checkpoint=fast \
  --write-recovery-conf \
  --no-password \
  >>"${LOG_FILE}" 2>&1 || { log "ERROR: pg_basebackup failed"; exit 1; }

# 2. Pack the backup directory into one archive, then encrypt it
tar -czf "${BACKUP_FILE}.tar.gz" -C "${BACKUP_DIR}" "$(basename "${BACKUP_FILE}")"
gpg --batch --yes --quiet \
    --recipient-file "${BACKUP_ENCRYPTION_KEY_PATH}" \
    --output "${BACKUP_FILE}.tar.gz.gpg" \
    --encrypt "${BACKUP_FILE}.tar.gz" || { log "ERROR: encryption failed"; exit 1; }

# 3. Verify the encrypted envelope is well formed
# Same pipefail trap as wal-archive.sh: capture the packets explicitly.
PKTS="$(gpg --batch --list-packets "${BACKUP_FILE}.tar.gz.gpg" 2>/dev/null || true)"
if ! printf '%s' "${PKTS}" | grep -qE '^(\:pubkey enc packet|\:encrypted data packet|\:public key encrypted data)'; then
  log "ERROR: backup envelope verification failed"
  exit 1
fi
log "envelope verification OK"

# 4. Metadata (no data content, per the backup security rules)
SIZE_BYTES="$(stat -c%s "${BACKUP_FILE}.tar.gz.gpg")"
CHECKSUM="$(sha256sum "${BACKUP_FILE}.tar.gz.gpg" | cut -d' ' -f1)"
WAL_POSITION="$("${PGBIN}/psql" -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_BACKUP_USER}" \
  -tAc 'SELECT pg_current_wal_lsn()' 2>/dev/null || echo 'unknown')"

# 4a. G3 FIX: record where WAL replay must start for THIS backup, while the plaintext
# still exists. After step 5 the only copy is an encrypted .gpg and this host holds no
# private key (F-23 FIX 3), so this is the last moment the value can ever be read —
# and without it there is no base-backup-aware WAL floor, only unbounded growth.
#
#   START WAL LOCATION: 0/2000028 (file 000000010000000000000002)
#
# The segment NAME is taken from the label verbatim rather than computed from the LSN:
# no wal_segment_size assumption and no arithmetic to get wrong.
WAL_START_SEGMENT="$(tar -xzOf "${BACKUP_FILE}/base.tar.gz" backup_label 2>/dev/null \
  | sed -n 's/^START WAL LOCATION: [0-9A-Fa-f]*\/[0-9A-Fa-f]* (file \([0-9A-Fa-f]\{24\}\)).*/\1/p' \
  | head -1 || true)"
WAL_FLOOR_SOURCE="backup_label"
if [ -z "${WAL_START_SEGMENT}" ] && [ -n "${PRE_BACKUP_LSN}" ]; then
  # Conservative fallback, never an aggressive one: this LSN precedes the backup's own
  # start, so the derived segment is at or before the true floor.
  WAL_START_SEGMENT="$("${PGBIN}/psql" -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_BACKUP_USER}" \
    -tAc "SELECT pg_walfile_name('${PRE_BACKUP_LSN}')" 2>/dev/null | tr -d '[:space:]' || true)"
  WAL_FLOOR_SOURCE="pg_walfile_name(pre-backup lsn)"
fi
# Whatever the source, only a well-formed segment name may become the floor. A
# malformed value would be written into the sidecar and then silently ignored by step 7,
# which is worse than recording "unknown": it reads like a floor that is not one.
if [ -n "${WAL_START_SEGMENT}" ] && ! [[ "${WAL_START_SEGMENT}" =~ ^[0-9A-F]{24}$ ]]; then
  log "WARNING: derived WAL start segment '${WAL_START_SEGMENT}' is not a 24-hex name — discarding it"
  WAL_START_SEGMENT=""
fi
if [ -n "${WAL_START_SEGMENT}" ]; then
  WAL_START_SEGMENT_JSON="\"${WAL_START_SEGMENT}\""
  log "WAL floor for this backup: ${WAL_START_SEGMENT} (from ${WAL_FLOOR_SOURCE})"
else
  WAL_START_SEGMENT_JSON="null"
  WAL_FLOOR_SOURCE="unavailable"
  # Not fatal — the backup itself is fine — but step 7 will refuse to prune on the
  # strength of it. Guessing a floor is how a DR kit deletes the WAL it needs.
  log "WARNING: could not determine this backup's WAL start segment; step 7 will skip WAL pruning until a backup records one"
fi

cat > "${BACKUP_FILE}.meta.json" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "type": "full_base_backup",
  "pg_version": "$("${PGBIN}/pg_basebackup" --version | awk '{print $3}')",
  "size_bytes": ${SIZE_BYTES},
  "checksum_sha256": "${CHECKSUM}",
  "wal_position": "${WAL_POSITION}",
  "wal_start_segment": ${WAL_START_SEGMENT_JSON},
  "wal_floor_source": "${WAL_FLOOR_SOURCE}",
  "encrypted": true
}
EOF

# 4b. G2 FIX: read the checksum back off the object we just wrote — and do it BEFORE
# step 5 deletes the plaintext.
#
# A checksum nobody reads protects nothing. The restore path now verifies it, but a
# restore is the worst possible moment to FIRST discover that the backup volume has
# been truncating or silently corrupting writes. Verifying here costs one re-read and
# catches that while the plaintext still exists and can simply be re-encrypted.
# Verifying after the cleanup instead would mean reporting "your only backup is
# corrupt" at the exact moment nothing can be done about it.
READBACK_SHA="$(sha256sum "${BACKUP_FILE}.tar.gz.gpg" | cut -d' ' -f1)"
if [ "${READBACK_SHA}" != "${CHECKSUM}" ]; then
  log "ERROR: read-back verification FAILED for $(basename "${BACKUP_FILE}").tar.gz.gpg"
  log "       hashed at write time: ${CHECKSUM}"
  log "       re-read from storage:  ${READBACK_SHA}"
  log "       the backup volume is corrupting or truncating writes"
  log "       plaintext RETAINED at ${BACKUP_FILE}.tar.gz — re-encrypt it to healthy storage"
  exit 1
fi
log "read-back verification OK"

# 5. Clean up unencrypted artifacts
rm -rf "${BACKUP_FILE}" "${BACKUP_FILE}.tar.gz"

# 6. Retention — with a floor guard (G6 FIX).
# `find … -mtime +30 -delete` over both the archive and its sidecar could delete the
# LAST restorable backup: if the job had been broken for longer than RETENTION_DAYS,
# every surviving file is older than the threshold and all of them go. The newest
# backup is therefore never pruned. A sidecar is removed only together with the archive
# it describes, because an archive without its sidecar cannot be verified on restore
# (G2) and must not be left behind.
#
# Step 7 depends on this ordering — its WAL floor is the oldest backup that survives
# HERE, so retention must run first.
shopt -s nullglob
SURVIVORS=("${BACKUP_DIR}"/basebackup_*.tar.gz.gpg)
shopt -u nullglob
PRUNED=0; ORPHANS=0
if [ ${#SURVIVORS[@]} -gt 0 ]; then
  # Names embed a UTC YYYYmmdd_HHMMSS timestamp, so lexical order is chronological.
  mapfile -t SURVIVORS < <(printf '%s\n' "${SURVIVORS[@]}" | sort)
  NEWEST="${SURVIVORS[$(( ${#SURVIVORS[@]} - 1 ))]}"
  for f in "${SURVIVORS[@]}"; do
    if [ "${f}" = "${NEWEST}" ]; then continue; fi        # the floor guard
    if [ -n "$(find "${f}" -maxdepth 0 -mtime +"${RETENTION_DAYS}" -print 2>/dev/null)" ]; then
      rm -f -- "${f}" "${f%.tar.gz.gpg}.meta.json"
      PRUNED=$((PRUNED + 1))
    fi
  done
  # Orphaned sidecars whose archive is already gone (e.g. deleted by an earlier run of
  # the unguarded `find`, or by hand).
  shopt -s nullglob
  for m in "${BACKUP_DIR}"/basebackup_*.meta.json; do
    if [ ! -e "${m%.meta.json}.tar.gz.gpg" ]; then rm -f -- "${m}"; ORPHANS=$((ORPHANS + 1)); fi
  done
  SURVIVORS=("${BACKUP_DIR}"/basebackup_*.tar.gz.gpg)
  shopt -u nullglob
  if [ ${#SURVIVORS[@]} -eq 0 ]; then
    log "ERROR: retention left no restorable backup in ${BACKUP_DIR}"
    exit 1
  fi
  mapfile -t SURVIVORS < <(printf '%s\n' "${SURVIVORS[@]}" | sort)
  # Kept separate from PRUNED: "pruned 3" should mean three backups went, not two
  # backups and an unrelated sidecar.
  ORPHAN_NOTE=""
  if [ "${ORPHANS}" -gt 0 ]; then ORPHAN_NOTE=", swept ${ORPHANS} orphaned sidecar(s)"; fi
  log "retention: pruned ${PRUNED}, kept ${#SURVIVORS[@]}${ORPHAN_NOTE} (newest always retained; threshold ${RETENTION_DAYS}d)"
else
  log "WARNING: no base backups in ${BACKUP_DIR} after step 5 — retention skipped"
fi

# 7. WAL retention — base-backup-aware (G3 FIX).
# Nothing pruned ${BACKUP_STORAGE_PATH}/wal before this step: with archive_timeout=300
# that is up to 288 timeout-forced 16 MB segments a day (~4.6 GB/day) before counting
# write volume, with no ceiling. The failure mode is the nasty one — when the archive
# volume fills, archive_command starts failing, PostgreSQL then retains WAL in pg_wal on
# the primary, THAT fills in turn, and the primary stops accepting writes. A DR kit whose
# normal operation can eventually stop production.
#
# The floor is deliberately neither a date nor an mtime. WAL mtime is when it was
# ARCHIVED, which is after the segment was written, so an mtime sweep keyed on the
# oldest backup's own mtime deletes segments that backup needs. The correct floor is the
# oldest retained backup's WAL START segment: everything before it is unreachable by any
# restore this kit can still perform, everything from it forward is required by one.
if [ "${WAL_RETENTION_ENABLED:-1}" != "1" ]; then
  log "WAL pruning disabled (WAL_RETENTION_ENABLED=${WAL_RETENTION_ENABLED:-1})"
elif [ ! -d "${WAL_DIR}" ]; then
  log "no WAL archive at ${WAL_DIR} — nothing to prune"
elif [ ${#SURVIVORS[@]} -eq 0 ]; then
  log "WARNING: no retained base backup to derive a WAL floor from — pruning SKIPPED"
else
  OLDEST_META="${SURVIVORS[0]%.tar.gz.gpg}.meta.json"
  FLOOR=""
  if [ -f "${OLDEST_META}" ]; then
    FLOOR="$(sed -n 's/.*"wal_start_segment": *"\([0-9A-F]\{24\}\)".*/\1/p' "${OLDEST_META}" | head -1)"
  fi
  if [ -z "${FLOOR}" ]; then
    # A backup written before this fix, or one whose backup_label could not be read.
    # Fail safe: keep everything rather than guess where replay has to start.
    log "WARNING: $(basename "${OLDEST_META}") records no usable wal_start_segment — WAL pruning SKIPPED (fail-safe)"
  else
    FLOOR_TLI="${FLOOR:0:8}"
    REMOVED=0; KEPT=0; OTHER_TLI=0; NOT_SEGMENT=0; UNREMOVABLE=0
    DRY="${WAL_PRUNE_DRY_RUN:-0}"
    while IFS= read -r -d '' entry; do
      name="$(basename -- "${entry}")"
      stem="${name%.gpg}"
      # Candidates are well-formed WAL segment names, with or without the `.gpg` suffix
      # wal-archive.sh adds. The bare form is included deliberately: a PLAINTEXT segment
      # sitting in the archive is both stale and a PDPL exposure, so it is exactly what
      # should be removed, not preserved.
      # *.history (timeline switches) and *.backup (backup history) are never touched,
      # and neither is an in-flight *.gpg.tmp.$$ — PostgreSQL archives continuously and
      # holds no lock here, so pruning must be safe to run alongside it.
      if ! [[ "${stem}" =~ ^[0-9A-F]{24}$ ]]; then NOT_SEGMENT=$((NOT_SEGMENT + 1)); continue; fi
      # Only within the floor's own timeline. Lexical order across timelines does not
      # track replay order, so other timelines are left alone rather than reasoned about.
      if [ "${stem:0:8}" != "${FLOOR_TLI}" ]; then OTHER_TLI=$((OTHER_TLI + 1)); continue; fi
      if [[ "${stem}" < "${FLOOR}" ]]; then
        if [ "${DRY}" = "1" ]; then
          log "dry-run: would remove ${name}"
          REMOVED=$((REMOVED + 1))
        elif rm -f -- "${entry}"; then
          REMOVED=$((REMOVED + 1))
        else
          # Count it, log it, and CARRY ON. Aborting here would throw away a backup that
          # already succeeded and is already verified — and rebuild.sh:84 takes its base
          # path from `tail -1` of this script's stdout, so an abort before the final echo
          # hands the caller error text instead of a filename. An unprunable segment means
          # the archive is still growing, which is loud-log material, not a failed backup.
          UNREMOVABLE=$((UNREMOVABLE + 1))
          log "ERROR: could not remove ${name} from the WAL archive — permissions, immutable bit, or NFS root_squash?"
        fi
      else
        KEPT=$((KEPT + 1))
      fi
    done < <(find "${WAL_DIR}" -maxdepth 1 -type f -print0 | sort -z)
    DRY_NOTE=""
    if [ "${DRY}" = "1" ]; then DRY_NOTE=" [DRY RUN — nothing deleted]"; fi
    STUCK_NOTE=""
    if [ "${UNREMOVABLE}" -gt 0 ]; then
      STUCK_NOTE=" — ${UNREMOVABLE} COULD NOT BE REMOVED, the archive is still growing"
    fi
    log "WAL retention: floor ${FLOOR} from $(basename "${OLDEST_META}") — removed ${REMOVED}, kept ${KEPT}, other timeline ${OTHER_TLI}, non-segment ${NOT_SEGMENT}${STUCK_NOTE}${DRY_NOTE}"
  fi
fi

log "backup complete: $(basename "${BACKUP_FILE}").tar.gz.gpg (${SIZE_BYTES} bytes, sha256 ${CHECKSUM:0:12}…)"
echo "${BACKUP_FILE}.tar.gz.gpg"

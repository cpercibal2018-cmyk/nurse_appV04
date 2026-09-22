#!/bin/bash
# ops/backup/scripts/restore-database.sh "<TARGET_TIME>"
# Point-in-time recovery from the encrypted backup set.
#
# Usage:  TARGET_TIME="2026-09-18 09:30:00+00" ./restore-database.sh "$TARGET_TIME"
# Restores into RESTORE_PARENT/PGDATA on RESTORE_PORT, leaving the source
# cluster untouched so the drill can compare before/after.
#
# F-23 FIX 3: decryption uses a dedicated keyring holding the PRIVATE key
#   (restore host only). A passphrase file cannot decrypt a public-key
#   encrypted message — the reviewed baseline mixed the two.
# F-23 FIX 4: restore_command is routed through wal-restore.sh, which returns
#   non-zero without creating %p when a segment is missing.

set -euo pipefail

# Absolute path to this script's own directory — see the same note in
# setup-cluster.sh. The value derived here is written into postgresql.auto.conf
# below and read back by the postmaster during WAL replay, from a working
# directory nobody controls, so it must depend neither on ${PWD} nor on the
# executable bit surviving a clone.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_TIME="${1:?usage: restore-database.sh '<YYYY-MM-DD HH:MM:SS+00>'}"
: "${BACKUP_STORAGE_PATH:?}"
: "${BACKUP_GPG_HOME:?}"
: "${RESTORE_PARENT:?}"
: "${RESTORE_PORT:?}"

PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
BACKUP_DIR="${BACKUP_STORAGE_PATH}/full"
WAL_DIR="${BACKUP_STORAGE_PATH}/wal"
RESTORE_DIR="${RESTORE_PARENT}/pgdata"
SOCK_DIR="${RESTORE_PARENT}/sock"
LOG_FILE="${BACKUP_LOG_FILE:-/dev/null}"

# G1 FIX: UNPACK_DIR holds the DECRYPTED base.tar.gz and pg_wal.tar.gz — a gzipped
# plaintext copy of the entire database, i.e. all employee PII. It is purely an
# intermediate: everything needed is extracted out of it into RESTORE_DIR before
# recovery starts, and it is never read again.
#
# Declared here, above every exit path, and removed on ANY exit — success, failure or
# signal — so no run can leave it behind. Previously it was deleted only at the START
# of the NEXT run, so a successful drill left plaintext of the whole production
# database on the restore host indefinitely, which is exactly what §8.3's
# encryption-at-rest posture exists to prevent.
UNPACK_DIR="${RESTORE_PARENT}/unpack"
trap 'rm -rf "${UNPACK_DIR}"' EXIT

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

# 0. Mutual exclusion — G6/G3 FIX, on the SAME lock file as nightly-backup.sh.
# Step 1 picks a base backup out of ${BACKUP_DIR} and recovery then replays WAL for
# minutes. A backup running concurrently would apply its own retention and prune that
# very archive — including the WAL this restore is about to need — from underneath it.
# Refused rather than queued: a restore is an operator action and should be told
# immediately that the kit is busy, not block for the length of a backup.
#
# wal-restore.sh deliberately never takes this lock. PostgreSQL spawns it through
# restore_command DURING recovery, i.e. while this script is holding the lock and
# waiting for recovery to finish, so a lock there would deadlock the restore.
# Fails OPEN if flock(1) is missing, for the same reason as nightly-backup.sh but more
# strongly: during an actual DR event, refusing to restore because a locking utility is
# absent would be the worst possible outcome. Warn, then proceed.
LOCK_FILE="${GATE1_LOCK_FILE:-${BACKUP_STORAGE_PATH}/.gate1.lock}"
mkdir -p "${BACKUP_STORAGE_PATH}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock --nonblock 9; then
    log "ERROR: another backup-kit run holds ${LOCK_FILE} — refusing to restore concurrently"
    # Disarm the UNPACK_DIR trap BEFORE exiting. It was installed above for *this* run's
    # decrypted working files, but this run never created any — the lock holder is using
    # that very directory right now, mid-extraction. Without this, a refused run deletes
    # the in-flight restore's base.tar.gz / pg_wal.tar.gz out from under it, which is
    # precisely the interference the lock exists to prevent. A refused run must be a
    # no-op: this is the only exit path taken while another run owns that directory.
    trap - EXIT
    exit 1
  fi
else
  log "WARNING: flock(1) not found — restoring WITHOUT mutual exclusion (install util-linux)"
fi

# 1. Locate the newest base backup taken BEFORE the target time
BACKUP_FILE=""
TARGET_EPOCH="$(date -u -d "${TARGET_TIME}" +%s)"
# G6 FIX: `for f in $(ls -1 …)` word-split on any storage path containing spaces, which
# turns one backup into several bogus candidates. Glob into an array instead.
shopt -s nullglob
CANDIDATES=("${BACKUP_DIR}"/basebackup_*.gpg)
shopt -u nullglob
if [ ${#CANDIDATES[@]} -gt 0 ]; then
  mapfile -t CANDIDATES < <(printf '%s\n' "${CANDIDATES[@]}" | sort)
  for f in "${CANDIDATES[@]}"; do
    ts="$(basename "$f" | sed 's/^basebackup_//; s/\.tar\.gz\.gpg$//')"
    # backup names are UTC: YYYYmmdd_HHMMSS
    epoch="$(date -u -d "${ts:0:8} ${ts:9:2}:${ts:11:2}:${ts:13:2}" +%s)"
    if [ "${epoch}" -le "${TARGET_EPOCH}" ]; then BACKUP_FILE="$f"; fi
  done
fi

if [ -z "${BACKUP_FILE}" ]; then
  log "ERROR: no base backup before ${TARGET_TIME}"
  exit 1
fi
log "using base backup $(basename "${BACKUP_FILE}") for target ${TARGET_TIME}"

# 1b. G2 FIX: verify the recorded SHA-256 BEFORE anything destructive happens.
#
# nightly-backup.sh computes the checksum of the .gpg object and writes it as
# "checksum_sha256" into basebackup_*.meta.json for exactly this purpose — and
# nothing ever read it back. Across the five restore-side scripts there were zero
# references to sha256, checksum or meta.json outside the writer.
#
# The old ordering was worse than merely unverified: step 2 deleted the previous
# restore tree BEFORE attempting the decrypt, so a truncated or corrupted object in
# storage surfaced as a mid-restore pipe failure with the prior good state already
# gone. Verifying here means a bad backup costs nothing but this attempt, and every
# earlier state is still intact when the error is reported.
#
# Parsed with sed rather than jq: a restore host recovering from a bad day is the
# worst possible place to discover a missing dependency.
META_FILE="${BACKUP_FILE%.tar.gz.gpg}.meta.json"
if [ ! -f "${META_FILE}" ]; then
  # Fail closed. A backup with no metadata has no provenance to check against, and on
  # the one path whose entire purpose is recovering from a disaster, "cannot verify"
  # must not silently mean "assume fine". The override exists for the real emergency
  # where the metadata is itself what was lost; it is logged loudly and should never
  # be scripted into a drill.
  if [ "${ALLOW_UNVERIFIED_BACKUP:-0}" = "1" ]; then
    log "WARNING: no metadata at $(basename "${META_FILE}") — restoring UNVERIFIED (ALLOW_UNVERIFIED_BACKUP=1)"
  else
    log "ERROR: no metadata for $(basename "${BACKUP_FILE}") — cannot verify integrity"
    log "       expected: ${META_FILE}"
    log "       nothing has been deleted; set ALLOW_UNVERIFIED_BACKUP=1 only if the metadata itself is what was lost"
    exit 1
  fi
else
  EXPECTED_SHA="$(sed -n 's/.*"checksum_sha256"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]\{64\}\)".*/\1/p' "${META_FILE}" | head -1)"
  EXPECTED_SIZE="$(sed -n 's/.*"size_bytes"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "${META_FILE}" | head -1)"
  if [ -z "${EXPECTED_SHA}" ]; then
    log "ERROR: $(basename "${META_FILE}") contains no parseable checksum_sha256"
    exit 1
  fi
  ACTUAL_SIZE="$(stat -c%s "${BACKUP_FILE}")"
  ACTUAL_SHA="$(sha256sum "${BACKUP_FILE}" | cut -d' ' -f1)"
  # Size first: it is the cheaper check and gives the more useful diagnosis, since a
  # truncated object is the common failure and "expected N, got M" says so outright.
  if [ -n "${EXPECTED_SIZE}" ] && [ "${ACTUAL_SIZE}" != "${EXPECTED_SIZE}" ]; then
    log "ERROR: size mismatch for $(basename "${BACKUP_FILE}") — metadata says ${EXPECTED_SIZE} bytes, object is ${ACTUAL_SIZE}"
    log "       truncated or replaced; nothing has been deleted"
    exit 1
  fi
  if [ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]; then
    log "ERROR: checksum mismatch for $(basename "${BACKUP_FILE}")"
    log "       metadata: ${EXPECTED_SHA}"
    log "       actual:   ${ACTUAL_SHA}"
    log "       the object in storage is corrupt or was modified; nothing has been deleted"
    exit 1
  fi
  log "integrity verified: sha256 ${ACTUAL_SHA:0:12}…, ${ACTUAL_SIZE} bytes"
fi

# 2. Unpack: outer archive, then base.tar.gz + pg_wal.tar.gz into PGDATA
# Stop any instance left over from a previous run BEFORE touching its data
# directory. Deleting a live data directory under a running postmaster makes it
# die messily ("data directory lock file is invalid") and can leave the port
# bound, which then breaks this restore for reasons that look unrelated.
if [ -f "${RESTORE_DIR}/postmaster.pid" ]; then
  "${PGBIN}/pg_ctl" -D "${RESTORE_DIR}" stop -m immediate -w >/dev/null 2>&1 || true
fi

rm -rf "${RESTORE_DIR}" "${SOCK_DIR}"
mkdir -p "${RESTORE_DIR}" "${SOCK_DIR}"

# UNPACK_DIR is declared at the top of the script so the EXIT trap above can always
# see it; only the per-run reset belongs here.
rm -rf "${UNPACK_DIR}"; mkdir -p "${UNPACK_DIR}"

log "decrypting and unpacking"
gpg --batch --quiet --homedir "${BACKUP_GPG_HOME}" --decrypt "${BACKUP_FILE}" \
  | tar -xzf - -C "${UNPACK_DIR}"

INNER="${UNPACK_DIR}/$(basename "${BACKUP_FILE}" .tar.gz.gpg)"
[ -d "${INNER}" ] || { log "ERROR: unexpected backup layout in ${INNER}"; exit 1; }

tar -xzf "${INNER}/base.tar.gz" -C "${RESTORE_DIR}"
mkdir -p "${RESTORE_DIR}/pg_wal"
[ -f "${INNER}/pg_wal.tar.gz" ] && tar -xzf "${INNER}/pg_wal.tar.gz" -C "${RESTORE_DIR}/pg_wal"
chmod 700 "${RESTORE_DIR}"

# 3. Recovery configuration
# restore_command is executed by the postmaster through /bin/sh, with PGDATA as its
# working directory — not the kit root. Hence the absolute ${SCRIPTS_DIR}, and the
# `bash` prefix: the kit's scripts are committed without the executable bit, so a
# bare path would fail every replay attempt with "Permission denied".
touch "${RESTORE_DIR}/recovery.signal"
cat >> "${RESTORE_DIR}/postgresql.auto.conf" <<EOF
# Point-in-time recovery (drill)
restore_command = 'bash "${SCRIPTS_DIR}/wal-restore.sh" "${WAL_DIR}" "${BACKUP_GPG_HOME}" %f %p'
recovery_target_time = '${TARGET_TIME}'
recovery_target_action = 'promote'
EOF

# 4. Start on a separate port and wait for promotion
#
# -c archive_mode=off: the drill target must NEVER write into the archive it is
#   recovering from. On promotion it would otherwise try to archive its new
#   timeline history file straight back into the production WAL archive.
log "starting recovery instance on port ${RESTORE_PORT}"
"${PGBIN}/pg_ctl" -D "${RESTORE_DIR}" -l "${RESTORE_PARENT}/recovery.log" \
  -o "-p ${RESTORE_PORT} -c unix_socket_directories=${SOCK_DIR} -c hot_standby=off -c archive_mode=off" \
  start -w -t 120 >/dev/null

for _ in $(seq 1 120); do
  STATE="$("${PGBIN}/psql" -U postgres -h "${SOCK_DIR}" -p "${RESTORE_PORT}" -d postgres -tAc \
    'SELECT pg_is_in_recovery()' 2>/dev/null || echo 't')"
  # -U postgres is REQUIRED. Without it psql assumes the OS user, the connection
  # fails, the `|| echo 't'` fallback reports "still in recovery", and the drill
  # burns its full timeout and then reports a false "did not reach target".
  [ "${STATE}" = "f" ] && break
  sleep 2
done

if [ "${STATE}" != "f" ]; then
  log "ERROR: recovery did not reach the target time"
  tail -30 "${RESTORE_PARENT}/recovery.log" >&2 || true
  exit 1
fi

log "recovery complete — database promoted"
echo "${RESTORE_DIR}"

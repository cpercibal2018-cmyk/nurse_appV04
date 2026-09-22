#!/bin/bash
# ops/backup/scripts/rebuild.sh [--clean]
#
# Cold-start rebuild of the whole Gate 1 sandbox in one command: keyrings,
# cluster + schema + synthetic data, encrypted base backup, and the timed
# provable-PITR drill ending in gate1-evidence.md.
#
# With --clean it first stops any running sandbox clusters and deletes their
# data directories, the restore directory and the backup set. Everything it
# deletes is regenerable, which is what makes this kit safe to prune: the
# cluster data directories are ~300 MB of preallocated 16 MB WAL segments and
# do not need to be carried between sessions.
#
# NOTE: setup-cluster.sh bakes an absolute path to wal-archive.sh into
# postgresql.conf, derived from that script's own location (BASH_SOURCE) rather
# than from the caller's working directory, so the archive_command stays correct
# no matter where the cluster is set up from. This script still cd's to the kit
# root because it invokes its siblings as `bash scripts/...`. The kit must still
# not be moved after a cluster is built without rebuilding: the path baked into
# postgresql.conf points at where the kit was at setup time.

set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${KIT_DIR}"

ROOT="${ROOT:-/home/user/gate1-drill}"
RESTORE_PARENT="${RESTORE_PARENT:-/home/user/gate1-restore}"
SOURCE_PORT="${SOURCE_PORT:-5515}"
RESTORE_PORT="${RESTORE_PORT:-5516}"
DB_NAME="${DB_NAME:-nurseapp}"

export PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
export ROOT RESTORE_PARENT SOURCE_PORT RESTORE_PORT DB_NAME

export BACKUP_STORAGE_PATH="${BACKUP_STORAGE_PATH:-${ROOT}/backup}"
export BACKUP_ENCRYPTION_KEY_PATH="${BACKUP_ENCRYPTION_KEY_PATH:-${ROOT}/backup.pub}"
export BACKUP_LOG_FILE="${BACKUP_LOG_FILE:-${ROOT}/backup.log}"
export GNUPGHOME="${GNUPGHOME:-${ROOT}/gpg-backup}"
export BACKUP_GPG_HOME="${BACKUP_GPG_HOME:-${ROOT}/gpg-restore}"
export EVIDENCE_FILE="${EVIDENCE_FILE:-${ROOT}/gate1-evidence.md}"
export RTO_MINUTES="${RTO_MINUTES:-240}"

export DB_HOST="${DB_HOST:-${ROOT}/sock}"
export DB_PORT="${DB_PORT:-${SOURCE_PORT}}"
export DB_BACKUP_USER="${DB_BACKUP_USER:-postgres}"
export SOURCE_SOCK="${ROOT}/sock"

export PGPORT="${SOURCE_PORT}"

# ── Optional clean slate ────────────────────────────────────────────────────
if [ "${1:-}" = "--clean" ]; then
  echo "── clean slate ──"
  for d in "${ROOT}/pgdata" "${RESTORE_PARENT}/pgdata"; do
    if [ -f "${d}/PG_VERSION" ]; then
      "${PGBIN}/pg_ctl" -D "${d}" stop -m fast -w >/dev/null 2>&1 || true
      echo "  stopped cluster at ${d}"
    fi
  done
  # The lock file lives inside ${BACKUP_STORAGE_PATH}, which this block deletes — and
  # deleting a lock file does NOT release it. The holder keeps the inode while the next
  # run locks a brand-new file, so mutual exclusion silently disappears with both runs
  # proceeding. ${RESTORE_PARENT} is wiped here too, i.e. the decrypted working files of
  # any restore in flight. So the wipe takes the lock itself, and refuses if it is held.
  #
  # Scoped, and released before the sub-scripts below run: nightly-backup.sh and
  # restore-database.sh (via pitr-proof.sh) each take the same lock, so a lock still held
  # here would make them refuse and this script would deadlock on its own children.
  CLEAN_LOCK="${GATE1_LOCK_FILE:-${BACKUP_STORAGE_PATH}/.gate1.lock}"
  mkdir -p "$(dirname "${CLEAN_LOCK}")"
  wipe_regenerable_state() {
    # The lock file itself must SURVIVE this wipe. Unlinking a lock you are holding does not
    # release it — it moves the hole *inside* the critical section: this process keeps the old
    # inode, while any run starting from here on opens a FRESH file at that path and acquires
    # it immediately. A nightly-backup.sh cron tick landing mid-wipe would therefore sail past
    # the lock and start writing and pruning the backup set while this wipe is still deleting
    # it. So delete the CONTENTS of the backup tree, sparing the lock, instead of the tree.
    # The directory stays behind (setup-cluster.sh recreates full/ and wal/ under it), and a
    # custom GATE1_LOCK_FILE living elsewhere simply matches nothing here and is never at risk.
    if [ -d "${ROOT}/backup" ]; then
      # The sparing match has to be LITERAL. `-path` and `-name` compare GLOB patterns, so a
      # ${ROOT} containing [ ] * or ? makes the pattern miss the real lock file and delete it —
      # reopening this hole from inside the critical section (same family as the `for f in
      # $(ls -1 …)` bug that broke on a storage path containing a space). `-samefile` compares
      # inodes instead. It also errors out and deletes NOTHING when its argument is missing, and
      # in the fail-open branch below the lock file was never created — only the flock subshell's
      # `8>` redirection creates it — so guard on existence rather than let find fail the run.
      if [ -e "${CLEAN_LOCK}" ]; then
        find "${ROOT}/backup" -mindepth 1 -maxdepth 1 ! -samefile "${CLEAN_LOCK}" -exec rm -rf {} +
      else
        find "${ROOT}/backup" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      fi
    fi
    rm -rf "${ROOT}/pgdata" "${ROOT}/sock" \
           "${ROOT}/gpg-backup" "${ROOT}/gpg-restore" "${ROOT}/backup.pub" \
           "${ROOT}/backup.log" "${ROOT}/postgres.log" "${ROOT}/gate1-evidence.md" \
           "${RESTORE_PARENT}"
  }
  if command -v flock >/dev/null 2>&1; then
    (
      flock --nonblock 8 || {
        echo "ERROR: another backup-kit run holds ${CLEAN_LOCK} — refusing --clean, which would delete that run's backups and working files" >&2
        exit 1; }
      wipe_regenerable_state
    ) 8>"${CLEAN_LOCK}"
  else
    echo "WARNING: flock(1) not found — --clean proceeds WITHOUT mutual exclusion" >&2
    wipe_regenerable_state
  fi
  echo "  removed regenerable state (cluster data, backups, keyrings)"
else
  # Even without --clean, a stale restore instance would hold the socket dir.
  if [ -f "${RESTORE_PARENT}/pgdata/PG_VERSION" ]; then
    "${PGBIN}/pg_ctl" -D "${RESTORE_PARENT}/pgdata" stop -m fast -w >/dev/null 2>&1 || true
  fi
fi

mkdir -p "${ROOT}" "${RESTORE_PARENT}"

# ── 1. Keyrings ─────────────────────────────────────────────────────────────
echo "── 1/4 keyrings (public on backup host, private on restore host) ──"
bash scripts/setup-gpg.sh "${ROOT}" | sed 's/^/  /'

# ── 2. Cluster, schema, synthetic data ──────────────────────────────────────
echo "── 2/4 cluster + schema + synthetic workforce ──"
PGPORT="${SOURCE_PORT}" bash scripts/setup-cluster.sh "${ROOT}" | sed 's/^/  /'

# ── 3. Base backup ──────────────────────────────────────────────────────────
echo "── 3/4 encrypted base backup ──"
BASE="$(bash scripts/nightly-backup.sh 2>&1 | tail -1)"
echo "  ${BASE}"

# ── 4. Provable PITR drill ──────────────────────────────────────────────────
echo "── 4/4 provable PITR drill ──"
bash scripts/pitr-proof.sh

echo
echo "── rebuild complete ──"
echo "evidence: ${EVIDENCE_FILE}"
echo
echo "To free the ~300 MB of regenerable cluster data while keeping the result:"
echo "  ${PGBIN}/pg_ctl -D ${ROOT}/pgdata stop -m fast"
echo "  ${PGBIN}/pg_ctl -D ${RESTORE_PARENT}/pgdata stop -m fast"
echo "  rm -rf ${ROOT}/pgdata ${ROOT}/sock ${RESTORE_PARENT}"
echo "Rebuild at any time with: bash scripts/rebuild.sh --clean"

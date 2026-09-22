#!/bin/bash
# ops/backup/scripts/wal-archive.sh
# Archives WAL segments to encrypted backup storage.
# Called by PostgreSQL archive_command with %p (source path) and %f (filename).
#
# F-23 FIX 1: PostgreSQL retries archive_command until it succeeds, so this
# script must never leave a partial file behind. It encrypts to a temporary
# path and moves it into place only after the envelope check passes.
#
# F-23 FIX 4: the envelope check verifies the output is a real public-key
# encrypted message, not just a non-empty file.

set -euo pipefail

SOURCE_PATH="$1"
WAL_FILENAME="$2"
BACKUP_DIR="${BACKUP_STORAGE_PATH:?BACKUP_STORAGE_PATH is required}/wal"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_PATH:?BACKUP_ENCRYPTION_KEY_PATH is required}"
LOG_FILE="${BACKUP_LOG_FILE:-/dev/null}"

log() { printf '%s wal-archive: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

mkdir -p "${BACKUP_DIR}"

TARGET="${BACKUP_DIR}/${WAL_FILENAME}.gpg"
TMP="${TARGET}.tmp.$$"
trap 'rm -f "${TMP}"' EXIT

# Encrypt to a temporary file
if ! gpg --batch --yes --quiet \
        --recipient-file "${ENCRYPTION_KEY_FILE}" \
        --output "${TMP}" \
        --encrypt "${SOURCE_PATH}" 2>>"${LOG_FILE}"; then
  log "ERROR: encryption failed for ${WAL_FILENAME}"
  exit 1
fi

# Envelope check: non-empty and a public-key encrypted message
if [ ! -s "${TMP}" ]; then
  log "ERROR: empty output for ${WAL_FILENAME}"
  exit 1
fi
# NOTE: `gpg --list-packets` tries to decrypt and exits non-zero when the
# private key is absent — which is the normal case on a backup host. Under
# `set -o pipefail` that status would fail this check even when the envelope is
# valid, so the output is captured explicitly and the exit status ignored.
PKTS="$(gpg --batch --list-packets "${TMP}" 2>/dev/null || true)"
if ! printf '%s' "${PKTS}" | grep -qE '^(\:pubkey enc packet|\:encrypted data packet|\:public key encrypted data)'; then
  log "ERROR: ${WAL_FILENAME} is not an encrypted file"
  exit 1
fi

mv -f "${TMP}" "${TARGET}"
trap - EXIT

log "archived ${WAL_FILENAME} ($(stat -c%s "${TARGET}") bytes)"
exit 0

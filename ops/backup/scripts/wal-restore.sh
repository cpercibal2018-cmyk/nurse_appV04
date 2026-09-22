#!/bin/bash
# ops/backup/scripts/wal-restore.sh <wal_dir> <gpg_home> <wal_filename> <destination>
# Called by PostgreSQL's restore_command during point-in-time recovery.
#
# F-23 FIX 4: restore_command must exit non-zero WITHOUT creating %p when a
# segment is not yet archived. The previous form (`gpg --decrypt ... > %p`)
# left a zero-length file at the destination, which PostgreSQL treats as a
# valid WAL segment and then aborts recovery with a confusing error.

set -euo pipefail

WAL_DIR="$1"
GPG_HOME="$2"
WAL_FILENAME="$3"
DEST="$4"

SRC="${WAL_DIR}/${WAL_FILENAME}.gpg"

# Not archived yet — PostgreSQL will retry after a delay.
[ -f "${SRC}" ] || exit 1

TMP="${DEST}.tmp.$$"

if gpg --batch --quiet --homedir "${GPG_HOME}" \
       --decrypt --output "${TMP}" "${SRC}" 2>/dev/null && [ -s "${TMP}" ]; then
  mv -f "${TMP}" "${DEST}"
  exit 0
fi

rm -f "${TMP}"
exit 1

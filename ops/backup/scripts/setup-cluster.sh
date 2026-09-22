#!/bin/bash
# ops/backup/scripts/setup-cluster.sh <sandbox_root>
# Creates and starts a PostgreSQL 15 cluster with WAL archiving enabled,
# loads the synthetic schema and data, and takes a first base backup.
#
# Everything runs as the invoking user in a private directory — no system
# service, no root, nothing outside <sandbox_root>.

set -euo pipefail

# Absolute path to this script's own directory. `${PWD}` cannot be used for the
# archive_command written below: that string lands in postgresql.conf and is read
# back by the postmaster — possibly long after setup-cluster.sh finished, and from
# a working directory nobody controls. failure-drill.sh and rebuild.sh already
# derive KIT_DIR the same way.
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROOT="${1:?usage: setup-cluster.sh <sandbox_root>}"
PGBIN="${PGBIN:-/usr/lib/postgresql/15/bin}"
PGDATA="${ROOT}/pgdata"
SOCK="${ROOT}/sock"
PORT="${PGPORT:-5515}"
DB_NAME="${DB_NAME:-nurseapp}"
LOG="${ROOT}/postgres.log"

mkdir -p "${PGDATA}" "${SOCK}" "${ROOT}/backup/full" "${ROOT}/backup/wal"

if [ ! -f "${PGDATA}/PG_VERSION" ]; then
  echo "initdb…"
  "${PGBIN}/initdb" -D "${PGDATA}" -U postgres --auth=trust --encoding=UTF8 >/dev/null
fi

CONF="${PGDATA}/postgresql.conf"
BEGIN_MARK="# ── Gate 1 sandbox overrides ──"
END_MARK="# ── end Gate 1 sandbox overrides ──"

# Replace rather than append, so re-running this script never accumulates
# duplicate settings. A block with no end marker (older revision) is treated as
# extending to EOF.
awk -v b="${BEGIN_MARK}" -v e="${END_MARK}" '
  index($0,b)==1 {skip=1; next}
  index($0,e)==1 {skip=0; next}
  skip!=1 {print}
' "${CONF}" > "${CONF}.tmp" && mv "${CONF}.tmp" "${CONF}"

cat >> "${CONF}" <<EOF

${BEGIN_MARK}
port = ${PORT}
unix_socket_directories = '${SOCK}'
listen_addresses = ''
wal_level = replica
archive_mode = on
archive_timeout = 300
# The archive command is deliberately SELF-SUFFICIENT. Every path it needs is
# baked into the command line instead of being inherited from the environment
# of whoever started postgres. A postmaster restarted from a shell that lacks
# GNUPGHOME or BACKUP_ENCRYPTION_KEY_PATH -- after a crash, a reboot into a
# maintenance shell, or a service unit missing an EnvironmentFile -- would
# otherwise fail EVERY archive attempt while still reporting itself healthy as
# a database. The RPO guarantee would quietly become unbounded and nobody would
# notice until the day a restore was actually needed.
#
# Two further consequences of the same rule:
#   * the script path is ${SCRIPTS_DIR}, not ${PWD} — an absolute path derived
#     from this file's own location, so it is still correct when the postmaster
#     reads it back from any directory;
#   * it is invoked as `bash "…"`, not executed directly. PostgreSQL runs
#     archive_command through /bin/sh, which needs the executable bit; the kit's
#     scripts are committed 100644, so a fresh clone would otherwise fail EVERY
#     archive attempt with "Permission denied" while postgres still reported
#     itself healthy. Going through bash is immune to the bit being lost in a
#     clone, a zip, or a copy to a filesystem that does not carry modes.
archive_command = 'BACKUP_STORAGE_PATH=${ROOT}/backup BACKUP_ENCRYPTION_KEY_PATH=${ROOT}/backup.pub GNUPGHOME=${ROOT}/gpg-backup BACKUP_LOG_FILE=${ROOT}/backup.log bash "${SCRIPTS_DIR}/wal-archive.sh" %p %f'
max_wal_senders = 3
wal_keep_size = 64MB
fsync = on
log_min_messages = warning
${END_MARK}
EOF

echo "starting cluster on port ${PORT}…"
# Idempotent: stop a cluster left running by an earlier attempt.
if "${PGBIN}/pg_ctl" -D "${PGDATA}" status >/dev/null 2>&1; then
  "${PGBIN}/pg_ctl" -D "${PGDATA}" stop -m fast -w -t 60 >/dev/null
fi
"${PGBIN}/pg_ctl" -D "${PGDATA}" -l "${LOG}" start -w -t 60 >/dev/null

PSQL=("${PGBIN}/psql" -h "${SOCK}" -p "${PORT}" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null
"${PSQL[@]}" -d postgres -c "CREATE DATABASE ${DB_NAME};" >/dev/null

echo "loading schema…"
"${PSQL[@]}" -d "${DB_NAME}" -q -f sql/10_audit_chain.sql
"${PSQL[@]}" -d "${DB_NAME}" -q -f sql/20_org_structure.sql
"${PSQL[@]}" -d "${DB_NAME}" -q -f sql/30_synthetic_workforce.sql
"${PSQL[@]}" -d "${DB_NAME}" -q -f sql/40_tx_probe.sql

echo "cluster ready: ${PGDATA} (port ${PORT}, database ${DB_NAME})"

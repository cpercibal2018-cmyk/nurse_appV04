#!/bin/sh
# Runs once, inside the e2e database container, when the data directory is
# created (docker-entrypoint-initdb.d). Same order as a fresh installation
# (ops/db/README.md): roles, passwords, grants on the empty database. The
# migrate and grants services then finish the sequence.
set -eu
PSQL="psql -X -q -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB"
$PSQL -f /ops-db/01_roles.sql
for role in nurseapp_migration nurseapp_runtime nurseapp_backup nurseapp_audit_reader; do
  $PSQL -v role="$role" -v pw="$E2E_DB_PASSWORD" <<'SQL'
ALTER ROLE :"role" PASSWORD :'pw';
SQL
done
$PSQL -f /ops-db/02_grants.sql

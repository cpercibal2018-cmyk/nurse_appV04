#!/bin/bash
# ops/gcp/db-release.sh <database>
#
# Runs ON THE DATABASE VM after every migration (ops/db/README.md "After every
# migration"), called by .github/workflows/deploy.yml over IAP SSH: re-applies
# the role grants, then verify.sql — every check must PASS or the release stops
# before the new app version starts. Connects as the local postgres superuser
# over the Unix socket (peer authentication; no password anywhere).

set -euo pipefail
DB="${1:?usage: $0 <database>}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "invalid database name" >&2; exit 2; }
OPS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../db" && pwd)"
PSQL=(sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

"${PSQL[@]}" -f "$OPS/02_grants.sql"
"${PSQL[@]}" -f "$OPS/verify.sql"

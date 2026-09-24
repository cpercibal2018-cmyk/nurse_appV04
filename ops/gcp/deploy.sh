#!/bin/bash
# ops/gcp/deploy.sh <pull|migrate|up|rollback|status> [tag]
#
# Runs ON THE APP VM (decision D-49), called by .github/workflows/deploy.yml
# over IAP SSH, or by an operator. Release order (the workflow does this):
#   deploy.sh pull <tag>      images from Artifact Registry
#   deploy.sh migrate <tag>   prisma migrate deploy as nurseapp_migration
#   (on the DB VM)            ops/gcp/db-release.sh — 02_grants.sql + verify.sql
#   deploy.sh up <tag>        start the release, wait until healthy, record it
# Migrations are forward-only: `rollback` restarts the previous images and is
# safe only while the schema change is backward compatible.
#
# Files on the VM (ops/gcp/README.md §5):
#   /etc/nurseapp/app.env      API + worker settings (DATABASE_URL = nurseapp_runtime)
#   /etc/nurseapp/migrate.env  MIGRATION_DATABASE_URL only — never given to the running app
#   /etc/nurseapp/deploy.env   REGISTRY=me-central2-docker.pkg.dev/<project>/nurseapp, LB_PROXY_SUBNET=<proxy-only subnet>
#   /srv/nurseapp/             storage/ (uploads), clamav/ (signatures), RELEASE, PREVIOUS_RELEASE

set -euo pipefail

CMD="${1:-}"; TAG="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${NURSEAPP_CONF:-/etc/nurseapp}"
STATE="${NURSEAPP_STATE:-/srv/nurseapp}"
# shellcheck disable=SC1091
[[ -f "$CONF/deploy.env" ]] && source "$CONF/deploy.env"
: "${REGISTRY:?REGISTRY is not set (see $CONF/deploy.env)}"
export REGISTRY LB_PROXY_SUBNET NURSEAPP_CONF="$CONF" NURSEAPP_STATE="$STATE"
compose() { TAG="$1" docker compose -f "$HERE/docker-compose.yml" "${@:2}"; }
need_tag() { [[ "$TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { echo "usage: $0 $CMD <tag>" >&2; exit 2; }; }

health() {
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8080/api/v1/health >/dev/null; then echo "healthy"; return 0; fi
    sleep 2
  done
  echo "NOT HEALTHY after 60 s — see: docker compose -f $HERE/docker-compose.yml ps / logs" >&2
  return 1
}

case "$CMD" in
  pull)
    need_tag
    for image in api migrate web; do docker pull -q "$REGISTRY/$image:$TAG"; done
    ;;
  migrate)
    need_tag
    [[ -f "$CONF/migrate.env" ]] || { echo "$CONF/migrate.env is missing" >&2; exit 1; }
    docker run --rm --env-file "$CONF/migrate.env" --network host "$REGISTRY/migrate:$TAG"
    ;;
  up)
    need_tag
    mkdir -p "$STATE/storage" "$STATE/clamav"
    chown 1000:1000 "$STATE/storage"   # the node user in the api image
    compose "$TAG" up -d --remove-orphans
    health
    current="$(cat "$STATE/RELEASE" 2>/dev/null || true)"
    if [[ "$current" != "$TAG" ]]; then
      [[ -n "$current" ]] && echo "$current" > "$STATE/PREVIOUS_RELEASE"
      echo "$TAG" > "$STATE/RELEASE"
    fi
    echo "release $TAG is live"
    ;;
  rollback)
    prev="$(cat "$STATE/PREVIOUS_RELEASE" 2>/dev/null || true)"
    [[ -n "$prev" ]] || { echo "no previous release recorded" >&2; exit 1; }
    echo "rolling back to $prev (the database schema is NOT rolled back)"
    compose "$prev" up -d --remove-orphans
    health
    cp "$STATE/RELEASE" "$STATE/PREVIOUS_RELEASE"
    echo "$prev" > "$STATE/RELEASE"
    ;;
  status)
    echo "release: $(cat "$STATE/RELEASE" 2>/dev/null || echo none)   previous: $(cat "$STATE/PREVIOUS_RELEASE" 2>/dev/null || echo none)"
    compose "$(cat "$STATE/RELEASE" 2>/dev/null || echo none)" ps
    ;;
  *)
    echo "usage: $0 <pull|migrate|up|rollback|status> [tag]" >&2; exit 2 ;;
esac

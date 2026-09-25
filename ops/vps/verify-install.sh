#!/bin/bash
# ops/vps/verify-install.sh — checks a finished installation against
# README.md §2–§8, read-only, and prints PASS / WARN / FAIL per item:
#
#   sudo /opt/nurseapp/vps/verify-install.sh            everything
#   sudo /opt/nurseapp/vps/verify-install.sh --only ssh,firewall
#
# Run it after the installation, before go-live, and after any change to the
# server. Exit 1 on any FAIL; WARNs are things to finish or to accept knowingly.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib-checks.sh
source "$HERE/lib-checks.sh"
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }

SECTIONS=(
  "§2 server:os ssh firewall updates db_listen deploy_account"
  "§3 database and settings:settings roles"
  "§5 backups:backup_setup wal backup offsite"
  "§6 release and HTTPS:dns https cert containers site"
  "§7 first administrators:admins"
  "§8 running it:monitoring disk reboot"
)
ONLY=""
[[ "${1:-}" == --only ]] && ONLY=",${2:-},"

RESULTS=(); failed=0
for section in "${SECTIONS[@]}"; do
  title="${section%%:*}"; read -r -a names <<< "${section#*:}"
  if [[ -n "$ONLY" ]]; then
    keep=(); for n in "${names[@]}"; do [[ "$ONLY" == *",$n,"* ]] && keep+=("$n"); done
    (( ${#keep[@]} )) || continue; names=("${keep[@]}")
  fi
  echo "$title"
  run_checks "${names[@]}" || failed=1
done

fails=0; warns=0
for r in "${RESULTS[@]}"; do case "$(cut -d'|' -f2 <<< "$r")" in 1) fails=$((fails+1)) ;; 2) warns=$((warns+1)) ;; esac; done
echo
if (( failed )); then echo "NOT READY: $fails failed, $warns warnings"; else echo "READY: 0 failed, $warns warnings"; fi
exit $failed

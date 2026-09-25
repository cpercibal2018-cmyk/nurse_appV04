#!/bin/bash
# ops/vps/monitor.sh — is production healthy? (decision D-57, go-live readiness)
#
#   monitor.sh                  print the checks (PASS / WARN / FAIL); exit 1 on any FAIL
#   monitor.sh --notify         the same, and alert on changes — run every 5 minutes by
#                               nurseapp-monitor.timer (setup-host.sh)
#   monitor.sh --only a,b       only those checks
#
# Checks: site (HTTPS health through Caddy), containers (live colour, Caddy,
# ClamAV), database, wal (archiving current), backup (base backup < 26 h),
# offsite (copy ≤ 20 min), disk, cert (renewal working), reboot.
#
# Alerts go by e-mail and/or webhook, set in /etc/nurseapp/monitor.env (0600):
#   ALERT_EMAILS=it-oncall@hospital.sa,dba@hospital.sa
#   ALERT_WEBHOOK_URL=https://…            optional: Teams / Slack incoming webhook (JSON {"text": …})
#   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM   the relay; default: the app's own (app.env)
#   ALERT_SMTP_STARTTLS=1                   0 only for a relay without TLS on a private network
# An alert is sent when a check starts failing (and every 6 hours while it
# still fails), when it turns WARN, and when it recovers. Every run also
# logs one line to the journal (journalctl -u nurseapp-monitor).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS_DIR="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib-checks.sh
source "$HERE/lib-checks.sh"

NOTIFY=0; ONLY=""
while (( $# )); do
  case "$1" in
    --notify) NOTIFY=1 ;;
    --only) ONLY="$2"; shift ;;
    *) echo "usage: $0 [--notify] [--only check,check]" >&2; exit 2 ;;
  esac
  shift
done
CHECKS=(site containers database wal backup offsite disk cert reboot)
[[ -n "$ONLY" ]] && IFS=, read -r -a CHECKS <<< "$ONLY"

RESULTS=()
run_checks "${CHECKS[@]}"; status=$?

(( NOTIFY )) || exit $status

MON="$CONF/monitor.env"
cfg() { local v; v="$(setting "$MON" "$1")"; [[ -n "$v" ]] || v="$(setting "$CONF/app.env" "$1")"; echo "$v"; }
send_alert() {   # send_alert <subject> <body>
  local subject="$1" body="$2" to from envelope host port url mail rcpt=()
  to="$(setting "$MON" ALERT_EMAILS)"; host="$(cfg SMTP_HOST)"
  if [[ -n "$to" && -n "$host" ]]; then
    port="$(cfg SMTP_PORT)"; port="${port:-587}"; from="$(cfg SMTP_FROM)"; from="${from:-nurseapp-monitor@$SITE_HOST}"
    if [[ "$(cfg SMTP_SECURE)" == true ]]; then url="smtps://$host:$port"; else url="smtp://$host:$port"; fi
    envelope="${from##*<}"; envelope="${envelope%>}"   # "Name <addr>" → addr
    mail=(curl -sS --noproxy '*' --max-time 30 --url "$url" --mail-from "$envelope")
    [[ "$(setting "$MON" ALERT_SMTP_STARTTLS)" != 0 && "$url" == smtp://* ]] && mail+=(--ssl-reqd)
    [[ -n "$(cfg SMTP_USER)" ]] && mail+=(--user "$(cfg SMTP_USER):$(cfg SMTP_PASS)")
    IFS=, read -r -a rcpt <<< "$to"
    for r in "${rcpt[@]}"; do mail+=(--mail-rcpt "$(echo "$r" | xargs)"); done
    printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
      "$from" "$to" "$subject" "$(date -R)" "$body" | "${mail[@]}" --upload-file - \
      || echo "monitor: e-mail alert could not be sent" >&2
  fi
  url="$(setting "$MON" ALERT_WEBHOOK_URL)"
  if [[ -n "$url" ]]; then
    jq -n --arg t "$subject"$'\n'"$body" '{text: $t}' | curl -sS --max-time 15 -H 'Content-Type: application/json' -d @- "$url" >/dev/null \
      || echo "monitor: webhook alert could not be sent" >&2
  fi
  [[ -z "$to" && -z "$url" ]] && echo "monitor: no alert recipients configured ($MON) — $subject" >&2
  return 0
}

mkdir -p "$STATE/monitor"
now=$(date +%s)
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name rc detail <<< "$r"
  file="$STATE/monitor/$name"
  { read -r prev_rc last_alert < "$file"; } 2>/dev/null || { prev_rc=0; last_alert=0; }   # first run: nothing known yet
  send=""
  if [[ "$rc" != "$prev_rc" ]]; then
    case $rc in
      0) send="RECOVERED" ;;
      2) send="WARNING" ;;
      *) send="FAILING" ;;
    esac
  elif [[ "$rc" == 1 ]] && (( now - last_alert >= 6 * 3600 )); then
    send="STILL FAILING"
  fi
  if [[ -n "$send" ]]; then
    send_alert "[nurseapp $SITE_HOST] $send: $name" "$send: $name — $detail

Checked at $(date -u '+%F %T') UTC on $(hostname). All checks: sudo /opt/nurseapp/vps/monitor.sh
Runbook: /opt/nurseapp/vps/README.md §8"
    last_alert=$now
  fi
  echo "$rc $last_alert" > "$file"
done
exit $status

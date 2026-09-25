#!/bin/bash
# ops/vps/lib-checks.sh — the checks shared by monitor.sh (every 5 minutes)
# and verify-install.sh (once, after installation). Sourced, not run.
#
# Each check_<name> prints one line of detail and returns 0 = PASS,
# 1 = FAIL, 2 = WARN. Nothing here changes the system.

CONF="${NURSEAPP_CONF:-/etc/nurseapp}"
STATE="${NURSEAPP_STATE:-/srv/nurseapp}"
BACKUP_STORE="${BACKUP_STORAGE_PATH:-/srv/backup}"
# shellcheck disable=SC1091
[[ -f "$CONF/deploy.env" ]] && source "$CONF/deploy.env"
DB_NAME="${DB_NAME:-nurseapp_v04}"
read -r -a PSQL <<< "${DB_SUPERUSER_PSQL:-sudo -u postgres psql}"
sql() { "${PSQL[@]}" -X -A -t -q -d "$DB_NAME" -c "$1" 2>/dev/null; }

# One value from a settings file, without executing it (values may hold $, quotes, spaces).
setting() { local v; v="$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2-)"; v="${v%\"}"; echo "${v#\"}"; }

https_get() {   # https_get <path> [curl args…] — the public entrance, from the VPS itself
  local path="$1"; shift
  local c=(curl -sS --noproxy '*' --max-time 10 --resolve "$SITE_HOST:443:127.0.0.1" "$@")
  [[ "${CURL_INSECURE:-}" == 1 ]] && c+=(-k)
  "${c[@]}" "https://$SITE_HOST$path"
}

# ── Running system ────────────────────────────────────────────────────────────

check_site() {
  local body
  body="$(https_get /api/v1/health 2>&1)" || { echo "https://$SITE_HOST does not answer: ${body:0:120}"; return 1; }
  [[ "$body" == *'"database":"up"'* ]] || { echo "the site answers but reports: ${body:0:120}"; return 1; }
  echo "https://$SITE_HOST answers; database up"
}

check_containers() {
  local live color bad=() s
  live="$(cat "$STATE/ACTIVE" 2>/dev/null || true)"; color="${live%% *}"
  [[ -n "$color" ]] || { echo "no release is live (deploy.sh release)"; return 1; }
  for s in api web; do
    [[ "$(docker ps --filter "label=com.docker.compose.project=nurseapp-$color" --filter "label=com.docker.compose.service=$s" --filter health=healthy -q | wc -l)" -ge 1 ]] || bad+=("$s")
  done
  for p in "nurseapp-$color:worker" "nurseapp-edge:caddy" "nurseapp-edge:clamav"; do
    [[ "$(docker ps --filter "label=com.docker.compose.project=${p%%:*}" --filter "label=com.docker.compose.service=${p##*:}" -q | wc -l)" -ge 1 ]] || bad+=("${p##*:}")
  done
  (( ${#bad[@]} == 0 )) || { echo "live colour $color: not running or not healthy: ${bad[*]}"; return 1; }
  echo "live: $live — api, web healthy; worker, caddy, clamav running"
}

check_database() {
  [[ "$(sql 'SELECT 1')" == 1 ]] || { echo "PostgreSQL does not answer"; return 1; }
  echo "PostgreSQL answers"
}

check_wal() {
  local mode row age failed
  mode="$(sql 'SHOW archive_mode')"
  [[ "$mode" == on ]] || { echo "WAL archiving is off (setup-backup.sh) — point-in-time recovery is not possible"; return 1; }
  row="$(sql "SELECT coalesce(extract(epoch FROM now() - last_archived_time)::int, -1), (failed_count > 0 AND last_failed_time > coalesce(last_archived_time, 'epoch'))::int FROM pg_stat_archiver")"
  age="${row%%|*}"; failed="${row##*|}"
  [[ "$failed" == 1 ]] && { echo "the last WAL archive attempt failed — see /var/log/aigh-backup.log"; return 1; }
  [[ "$age" == -1 ]] && { echo "no WAL segment archived yet"; return 2; }
  (( age <= ${WAL_MAX_AGE_MINUTES:-30} * 60 )) || { echo "last WAL segment archived $((age / 60)) min ago"; return 1; }
  echo "last WAL segment archived $((age / 60)) min ago"
}

check_backup() {
  local newest age
  newest="$(find "$BACKUP_STORE/full" -maxdepth 1 -name 'basebackup_*.tar.gz.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
  [[ -n "$newest" ]] || { echo "no base backup in $BACKUP_STORE/full (sudo systemctl start aigh-backup.service)"; return 1; }
  age=$(( ($(date +%s) - $(stat -c %Y "$newest")) / 3600 ))
  (( age < 26 )) || { echo "newest base backup is ${age} h old ($(basename "$newest"))"; return 1; }
  echo "newest base backup ${age} h old"
}

check_offsite() {
  [[ -f "$CONF/offsite.env" ]] || { echo "off-site copy not configured — losing the VPS would lose the backups (README.md §5)"; return 2; }
  local last age
  last="$(grep 'offsite-sync: copied' /var/log/aigh-backup.log 2>/dev/null | tail -n1 | cut -d' ' -f1)"
  [[ -n "$last" ]] || { echo "the off-site copy has never completed"; return 1; }
  age=$(( ($(date +%s) - $(date -d "$last" +%s)) / 60 ))
  (( age <= 20 )) || { echo "last off-site copy ${age} min ago (it runs every 5)"; return 1; }
  echo "last off-site copy ${age} min ago"
}

check_disk() {
  local worst=0 detail="" m use
  for m in / /srv; do
    [[ -d "$m" ]] || continue
    use="$(df --output=pcent "$m" | tail -n1 | tr -dc 0-9)"
    detail+="$m ${use}%  "
    (( use > worst )) && worst=$use
  done
  (( worst >= 90 )) && { echo "disk nearly full: $detail"; return 1; }
  (( worst >= 80 )) && { echo "disk filling: $detail"; return 2; }
  echo "$detail"
}

check_cert() {
  local end days
  end="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$SITE_HOST" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [[ -n "$end" ]] || { echo "no certificate served for $SITE_HOST"; return 1; }
  days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
  (( days >= ${CERT_FAIL_DAYS:-7} )) || { echo "certificate expires in $days days — Caddy is not renewing it (docker logs nurseapp-edge-caddy-1)"; return 1; }
  (( days >= ${CERT_WARN_DAYS:-14} )) || { echo "certificate expires in $days days"; return 2; }
  echo "certificate valid for $days days"
}

check_reboot() {
  [[ -f /var/run/reboot-required ]] && { echo "security updates wait for a reboot"; return 2; }
  echo "no reboot pending"
}

# ── Installation (verify-install.sh) ─────────────────────────────────────────

check_os() {
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || { echo "$PRETTY_NAME — the kit is written for Ubuntu 24.04"; return 2; }
  echo "$PRETTY_NAME"
}

check_ssh() {
  local t; t="$(sshd -T 2>/dev/null)" || { echo "cannot read the SSH server settings"; return 1; }
  grep -qx 'passwordauthentication no' <<< "$t" || { echo "SSH accepts passwords"; return 1; }
  grep -qx 'permitrootlogin no' <<< "$t" || { echo "SSH allows root sign-in"; return 1; }
  systemctl is-active -q fail2ban || { echo "fail2ban is not running"; return 1; }
  echo "keys only, no root sign-in, fail2ban running"
}

check_firewall() {
  local s ports
  s="$(ufw status 2>/dev/null)" || { echo "ufw not available"; return 1; }
  grep -q 'Status: active' <<< "$s" || { echo "the firewall is off"; return 1; }
  ports="$(grep -E 'ALLOW' <<< "$s" | awk '{print $1}' | sed 's#/.*##' | sort -u | tr '\n' ' ')"
  for p in $ports; do
    [[ "$p" =~ ^(22|80|443|OpenSSH|5432)$ ]] || { echo "unexpected open port: $p (open: $ports)"; return 1; }
  done
  grep -E '5432' <<< "$s" | grep -vq '172.30.0.0/24' && { echo "PostgreSQL is open to more than the containers"; return 1; }
  echo "active; open: $ports"
}

check_updates() {
  systemctl is-enabled -q unattended-upgrades 2>/dev/null || { echo "unattended security updates are off"; return 1; }
  echo "unattended security updates on"
}

check_db_listen() {
  local addrs a
  addrs="$(ss -Hltn 'sport = :5432' | awk '{print $4}' | sed 's#:5432$##; s#^\[##; s#\]$##' | sort -u)"
  [[ -n "$addrs" ]] || { echo "PostgreSQL is not listening"; return 1; }
  for a in $addrs; do
    [[ "$a" =~ ^(127\.0\.0\.1|::1|172\.17\.0\.1)$ ]] || { echo "PostgreSQL listens on $a — it must be localhost and 172.17.0.1 only"; return 1; }
  done
  echo "PostgreSQL listens on $(echo "$addrs" | tr '\n' ' ')"
}

check_settings() {
  local f k region allowed missing=()
  for f in app.env migrate.env deploy.env; do
    [[ -f "$CONF/$f" ]] || { echo "$CONF/$f is missing (db-init.sh)"; return 1; }
    [[ "$(stat -c '%a %U' "$CONF/$f")" == '600 root' ]] || { echo "$CONF/$f must be 0600 root"; return 1; }
  done
  for k in DATABASE_URL JWT_SECRET MFA_ENCRYPTION_KEY DOCUMENT_ENCRYPTION_KEY PDPL_FIELD_ENCRYPTION_KEY PDPL_BLIND_INDEX_PEPPER CORS_ORIGIN DATA_RESIDENCY_REGION; do
    [[ -n "$(setting "$CONF/app.env" "$k")" ]] || missing+=("$k")
  done
  (( ${#missing[@]} == 0 )) || { echo "app.env lacks: ${missing[*]}"; return 1; }
  region="$(setting "$CONF/app.env" DATA_RESIDENCY_REGION)"; allowed="$(setting "$CONF/app.env" PDPL_ALLOWED_REGIONS)"
  [[ "$region" =~ ^(local|dev|sandbox)$ ]] && { echo "DATA_RESIDENCY_REGION=$region is a development marker"; return 1; }
  [[ ",$allowed," == *",$region,"* ]] || { echo "DATA_RESIDENCY_REGION is not in PDPL_ALLOWED_REGIONS"; return 1; }
  [[ -z "$(setting "$CONF/app.env" SMTP_HOST)" ]] && { echo "complete; region $region — e-mail is off (SMTP_HOST empty)"; return 2; }
  echo "complete; region $region"
}

check_roles() {
  local out
  out="$("${PSQL[@]}" -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" < "${OPS_DIR:-/opt/nurseapp}/db/verify.sql" 2>&1)" \
    || { echo "verify.sql: $(grep -m1 FAIL <<< "$out")"; return 1; }
  echo "verify.sql: all checks passed"
}

check_backup_setup() {
  [[ "$(sql 'SHOW archive_mode')" == on ]] || { echo "WAL archiving is off — run setup-backup.sh"; return 1; }
  systemctl is-enabled -q aigh-backup.timer 2>/dev/null || { echo "the nightly backup timer is not enabled"; return 1; }
  if sudo -u postgres gpg --homedir /var/lib/postgresql/.gnupg-backup --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'; then
    echo "a PRIVATE backup key is on the VPS — remove it; only the public key belongs here"; return 1
  fi
  echo "WAL archiving on, nightly timer enabled, public key only"
}

check_deploy_account() {
  local ak=/home/deploy/.ssh/authorized_keys
  [[ -f "$ak" ]] || { echo "no deploy key installed (setup-host.sh)"; return 1; }
  grep -v '^#' "$ak" | grep -qv '^restrict,command="sudo /usr/local/sbin/nurseapp-release' && { echo "a deploy key without the one-command restriction"; return 1; }
  visudo -cf /etc/sudoers.d/nurseapp-deploy >/dev/null 2>&1 || { echo "the deploy sudoers rule is missing or invalid"; return 1; }
  echo "deploy key limited to nurseapp-release"
}

check_dns() {
  local resolved mine
  resolved="$(getent ahostsv4 "$SITE_HOST" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  [[ -n "$resolved" ]] || { echo "$SITE_HOST does not resolve — add the DNS A record"; return 1; }
  mine="$(hostname -I 2>/dev/null)"
  for ip in $resolved; do [[ " $mine " == *" $ip "* ]] && { echo "$SITE_HOST → $ip (this server)"; return 0; }; done
  echo "$SITE_HOST → $resolved, not one of this server's addresses ($mine) — fine only behind a provider NAT"; return 2
}

check_https() {
  local code hdrs
  code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$SITE_HOST:80:127.0.0.1" "http://$SITE_HOST/")"
  [[ "$code" =~ ^30[178]$ ]] || { echo "http:// does not redirect to https:// (got $code)"; return 1; }
  hdrs="$(https_get / -D - -o /dev/null 2>/dev/null)"
  grep -qi '^strict-transport-security' <<< "$hdrs" || { echo "no HSTS header"; return 1; }
  grep -qi '^content-security-policy' <<< "$hdrs" || { echo "no Content-Security-Policy header"; return 1; }
  echo "HTTP → HTTPS, HSTS and CSP present"
}

check_admins() {
  local n; n="$(sql 'SELECT count(*) FROM users')"
  [[ -n "$n" ]] || { echo "cannot count accounts"; return 1; }
  (( n > 0 )) || { echo "no accounts yet — run: sudo /opt/nurseapp/vps/deploy.sh bootstrap"; return 2; }
  echo "$n account(s)"
}

check_monitoring() {
  systemctl is-enabled -q nurseapp-monitor.timer 2>/dev/null || { echo "the 5-minute monitor timer is not enabled"; return 1; }
  [[ -f "$CONF/monitor.env" ]] || { echo "no alert recipients (/etc/nurseapp/monitor.env) — failures are only logged"; return 2; }
  echo "monitor every 5 minutes; alerts to $(setting "$CONF/monitor.env" ALERT_EMAILS)$(setting "$CONF/monitor.env" ALERT_WEBHOOK_URL | sed 's#^\(.\{1,\}\)$# + webhook#')"
}

# Runs the named checks, prints a table, and returns 1 if any FAILed.
run_checks() {
  local name detail rc failed=0
  for name in "$@"; do
    detail="$("check_$name" 2>&1)"; rc=$?
    case $rc in
      0) printf '  PASS  %-15s %s\n' "$name" "$detail" ;;
      2) printf '  WARN  %-15s %s\n' "$name" "$detail" ;;
      *) printf '  FAIL  %-15s %s\n' "$name" "$detail"; failed=1 ;;
    esac
    RESULTS+=("$name|$rc|$detail")
  done
  return $failed
}

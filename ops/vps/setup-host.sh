#!/bin/bash
# ops/vps/setup-host.sh — prepares a fresh Ubuntu 24.04 VPS (decision D-57).
# Run ONCE as root from a copy of the repository's ops/ folder, after you can
# sign in with an SSH key as your own sudo user (README.md §2):
#
#   sudo ADMIN_USER=<you> DEPLOY_PUBKEY='ssh-ed25519 AAAA… github-deploy' \
#        [ADMIN_SSH_CIDR=<office egress>/32] ./setup-host.sh
#
# Idempotent: safe to run again after changing a setting. It
#   1. updates the OS and turns on unattended security updates;
#   2. SSH: keys only, no root login, only ADMIN_USER and deploy; fail2ban;
#   3. firewall (ufw): SSH (optionally from ADMIN_SSH_CIDR only), 80, 443; nothing else;
#   4. installs Docker Engine + Compose (log rotation, live-restore);
#   5. installs PostgreSQL 15 (PGDG), reachable only from localhost and the
#      containers' network — never from the internet;
#   6. creates the `deploy` account used by GitHub Actions: its key can run
#      one thing, nurseapp-release, and nothing else (no shell);
#   7. creates /etc/nurseapp, /srv/nurseapp and the containers' network.
# It does not create the database or any secret: that is db-init.sh.

set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
: "${ADMIN_USER:?ADMIN_USER is your own sudo account (it keeps SSH access)}"
: "${DEPLOY_PUBKEY:?DEPLOY_PUBKEY is the public half of the GitHub Actions deploy key}"
ADMIN_SSH_CIDR="${ADMIN_SSH_CIDR:-}"
OPS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG=15
NET_SUBNET=172.30.0.0/24

id "$ADMIN_USER" >/dev/null 2>&1 || { echo "user $ADMIN_USER does not exist" >&2; exit 1; }
[[ -s "$(getent passwd "$ADMIN_USER" | cut -d: -f6)/.ssh/authorized_keys" ]] \
  || { echo "$ADMIN_USER has no SSH key yet — add one first, or this script would lock you out" >&2; exit 1; }
# shellcheck disable=SC1091
. /etc/os-release
[[ "$ID" == ubuntu ]] || echo "WARNING: written for Ubuntu 24.04; this is $PRETTY_NAME" >&2

step() { echo; echo "== $*"; }
export DEBIAN_FRONTEND=noninteractive

step "1. OS updates, unattended security updates, time zone"
apt-get update -q
apt-get -y -q upgrade
apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades rsync jq openssl
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone UTC   # logs and cron in UTC; the backup timer names Asia/Riyadh itself

step "2. SSH: keys only, no root, two accounts; fail2ban"
cat > /etc/ssh/sshd_config.d/10-nurseapp.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
AllowTcpForwarding local
AllowUsers $ADMIN_USER deploy
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd
systemctl enable --now fail2ban

step "3. Firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$ADMIN_SSH_CIDR" ]]; then ufw allow from "$ADMIN_SSH_CIDR" to any port 22 proto tcp; else ufw allow OpenSSH; fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp   # HTTP/3
# The containers reach PostgreSQL on the Docker host address; nothing else may.
ufw allow from "$NET_SUBNET" to 172.17.0.1 port 5432 proto tcp
ufw --force enable
# Note: ports published by Docker bypass ufw. Only Caddy publishes any (80, 443).

step "4. Docker Engine"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "bip": "172.17.0.1/16"
}
EOF
systemctl enable docker
systemctl restart docker

step "5. PostgreSQL $PG (PGDG), local and containers only"
if [[ ! -d /usr/lib/postgresql/$PG ]]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /usr/share/keyrings/pgdg.gpg
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q
  apt-get install -y -q "postgresql-$PG" "postgresql-client-$PG"
fi
CONFD="/etc/postgresql/$PG/main/conf.d"
mkdir -p "$CONFD"
cat > "$CONFD/10-nurseapp.conf" <<'EOF'
# ops/vps/setup-host.sh — the containers reach the database on the Docker host address only.
listen_addresses = 'localhost,172.17.0.1'
password_encryption = scram-sha-256
# WAL archiving (archive_mode, archive_command) is added by the backup kit: README.md §5.
EOF
HBA="/etc/postgresql/$PG/main/pg_hba.conf"
grep -q 'nurseapp containers' "$HBA" || cat >> "$HBA" <<EOF
# nurseapp containers (ops/vps): the application database only, password (SCRAM) required
host    nurseapp_v04    nurseapp_runtime,nurseapp_migration    $NET_SUBNET    scram-sha-256
EOF
# The listen address exists once Docker is up: start PostgreSQL after it.
mkdir -p "/etc/systemd/system/postgresql@$PG-main.service.d"
cat > "/etc/systemd/system/postgresql@$PG-main.service.d/after-docker.conf" <<'EOF'
[Unit]
After=docker.service
Wants=docker.service
EOF
systemctl daemon-reload
systemctl enable "postgresql@$PG-main"
systemctl restart "postgresql@$PG-main"

step "6. The deploy account (GitHub Actions): one command, no shell"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
passwd -l deploy >/dev/null
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# restrict: no port forwarding, agent, X11 or terminal. The key runs nurseapp-release with the
# words the workflow sent (a commit id, or rollback / status) — never a shell.
# shellcheck disable=SC2016  # $SSH_ORIGINAL_COMMAND is expanded by sshd's shell at sign-in, not here
printf 'restrict,command="sudo /usr/local/sbin/nurseapp-release $SSH_ORIGINAL_COMMAND" %s\n' "$DEPLOY_PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
install -m 0755 -o root -g root "$OPS/vps/nurseapp-release" /usr/local/sbin/nurseapp-release
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/nurseapp-release' > /etc/sudoers.d/nurseapp-deploy
chmod 440 /etc/sudoers.d/nurseapp-deploy
visudo -cf /etc/sudoers.d/nurseapp-deploy

step "7. Folders and the containers' network"
install -d -m 700 /etc/nurseapp
install -d -m 755 /srv/nurseapp /opt/nurseapp
rsync -a --delete "$OPS/" /opt/nurseapp/   # vps/, db/, backup/ — replaced by every release
docker network inspect nurseapp >/dev/null 2>&1 \
  || docker network create --subnet "$NET_SUBNET" --ip-range 172.30.0.128/25 nurseapp

echo
echo "Done. Next: sudo /opt/nurseapp/vps/db-init.sh   (README.md §3)"

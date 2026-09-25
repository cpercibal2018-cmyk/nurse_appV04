#!/bin/bash
# ops/vps/setup-backup.sh — turns on the backup kit (ops/backup) on the VPS
# (decision D-57). Run as root after db-init.sh (README.md §5):
#
#   sudo BACKUP_PUBKEY=/root/backup.pub /opt/nurseapp/vps/setup-backup.sh
#
# BACKUP_PUBKEY is the PUBLIC half of the hospital's backup key (generated on
# a machine that is not the VPS; the private half never comes here — so a
# stolen VPS cannot read its own backups). It
#   1. imports the public key for the postgres user;
#   2. turns on WAL archiving through ops/backup/scripts/wal-archive.sh
#      (continuous: every change is encrypted into /srv/backup/wal);
#   3. installs the nightly base backup (01:00 Riyadh, aigh-backup.timer);
#   4. installs the off-site copy (offsite-sync.sh, every 5 minutes) — it
#      stays inactive until /etc/nurseapp/offsite.env names the destination.
# Restores and the restore drill: ops/backup/README.md.

set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
: "${BACKUP_PUBKEY:?BACKUP_PUBKEY is the path of the backup PUBLIC key (.asc / .pub)}"
PG=15
KIT=/opt/nurseapp/backup/scripts
STORE=/srv/backup
GNUPG=/var/lib/postgresql/.gnupg-backup
PUB=/etc/nurseapp/backup.pub
LOG=/var/log/aigh-backup.log

gpg --show-keys --with-colons "$BACKUP_PUBKEY" | grep -q '^pub' || { echo "$BACKUP_PUBKEY is not a public key" >&2; exit 1; }
if gpg --show-keys --with-colons "$BACKUP_PUBKEY" | grep -q '^sec'; then echo "$BACKUP_PUBKEY holds a PRIVATE key — it must not be on the VPS" >&2; exit 1; fi

echo "== 1. public key for the postgres user"
install -m 644 "$BACKUP_PUBKEY" "$PUB"
install -d -m 700 -o postgres -g postgres "$GNUPG" "$STORE"
install -d -m 700 -o postgres -g postgres "$STORE/full" "$STORE/wal"
touch "$LOG" && chown postgres:postgres "$LOG" && chmod 640 "$LOG"
sudo -u postgres gpg --batch --quiet --homedir "$GNUPG" --import "$PUB"

echo "== 2. WAL archiving"
cat > "/etc/postgresql/$PG/main/conf.d/20-archive.conf" <<CONF
# ops/vps/setup-backup.sh — continuous, encrypted WAL archive (ops/backup)
wal_level = replica
archive_mode = on
archive_timeout = 300   # D-58: at most 5 minutes of changes may be lost (B-22)
archive_command = 'BACKUP_STORAGE_PATH=$STORE BACKUP_ENCRYPTION_KEY_PATH=$PUB GNUPGHOME=$GNUPG BACKUP_LOG_FILE=$LOG bash "$KIT/wal-archive.sh" %p %f'
max_wal_senders = 3
CONF
systemctl restart "postgresql@$PG-main"
sudo -u postgres psql -X -q -c "SELECT pg_switch_wal()" >/dev/null
sleep 3
sudo -u postgres psql -X -At -c "SELECT CASE WHEN failed_count > 0 AND last_failed_time > coalesce(last_archived_time, 'epoch') THEN 'FAILING' ELSE 'ok' END FROM pg_stat_archiver" \
  | grep -q ok || { echo "WAL archiving is failing — see $LOG and the PostgreSQL log" >&2; exit 1; }

echo "== 3. nightly base backup (01:00 Asia/Riyadh)"
cat > /etc/default/aigh-backup <<ENV
PGBIN=/usr/lib/postgresql/$PG/bin
BACKUP_STORAGE_PATH=$STORE
BACKUP_ENCRYPTION_KEY_PATH=$PUB
GNUPGHOME=$GNUPG
BACKUP_LOG_FILE=$LOG
DB_HOST=127.0.0.1
DB_PORT=5432
DB_BACKUP_USER=nurseapp_backup
BACKUP_RETENTION_DAYS=30
ENV
sed "s#/opt/nurse_appV04/ops/backup/scripts#$KIT#" /opt/nurseapp/backup/systemd/aigh-backup.service > /etc/systemd/system/aigh-backup.service
install -m 644 /opt/nurseapp/backup/systemd/aigh-backup.timer /etc/systemd/system/aigh-backup.timer

echo "== 4. off-site copy (every 5 minutes, once /etc/nurseapp/offsite.env exists)"
command -v rclone >/dev/null || apt-get install -y -q rclone
cat > /etc/systemd/system/nurseapp-offsite.service <<UNIT
[Unit]
Description=Copy the encrypted backups off the VPS (ops/vps/offsite-sync.sh)
ConditionPathExists=/etc/nurseapp/offsite.env
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/nurseapp/vps/offsite-sync.sh
UNIT
cat > /etc/systemd/system/nurseapp-offsite.timer <<UNIT
[Unit]
Description=Off-site backup copy every 5 minutes (D-58: at most 5 minutes lost, even if the VPS is)
[Timer]
OnCalendar=*:0/5
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now aigh-backup.timer nurseapp-offsite.timer

echo
echo "Done. Take the first base backup now:  sudo systemctl start aigh-backup.service && tail $LOG"
echo "Then configure the off-site destination (README.md §5) and run the restore drill (ops/backup/README.md)."

#!/usr/bin/env bash
# Creates the backup encryption key pair and installs the nightly backup job.
# Run once as root on the VPS after setup-vps.sh. Usage: install-backups.sh [app-dir]
#
# The age PUBLIC key goes into .env (BACKUP_AGE_RECIPIENT) and is all the server needs to encrypt.
# The age PRIVATE key is printed ONCE: copy it into a password manager off the server, then it is
# deleted here. Without it no backup can be read, including by whoever takes over the server.
set -euo pipefail

APP_DIR="${1:-/opt/cs-virtual-lab}"
cd "$APP_DIR"

if grep -q '^BACKUP_AGE_RECIPIENT=age1' .env; then
  echo "BACKUP_AGE_RECIPIENT is already set in .env; keeping the existing key."
else
  KEYFILE=$(mktemp)
  age-keygen -o "$KEYFILE" 2>/dev/null
  PUB=$(grep -o 'age1[0-9a-z]*' "$KEYFILE" | head -1)
  sed -i "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=$PUB|" .env
  echo
  echo "============ BACKUP PRIVATE KEY: COPY THIS NOW, IT WILL NOT BE SHOWN AGAIN ============"
  grep 'AGE-SECRET-KEY' "$KEYFILE"
  echo "========================================================================================"
  echo "Public key written to .env as BACKUP_AGE_RECIPIENT=$PUB"
  shred -u "$KEYFILE"
fi

chmod +x "$APP_DIR"/scripts/ops/*.sh
cat >/etc/cron.d/cs-virtual-lab-backup <<EOF
# Nightly encrypted backup at 02:15 UTC; log in /var/log/cslab-backup.log
15 2 * * * root $APP_DIR/scripts/ops/backup.sh $APP_DIR >> /var/log/cslab-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/cs-virtual-lab-backup
touch /var/log/cslab-backup.log
cat >/etc/logrotate.d/cs-virtual-lab-backup <<'EOF'
/var/log/cslab-backup.log { monthly rotate 6 compress missingok notifempty }
EOF
echo "Nightly backup installed (02:15 UTC). Run it once now with: $APP_DIR/scripts/ops/backup.sh"

#!/usr/bin/env bash
# Nightly encrypted backup of the Postgres database, kept locally and copied off-site.
#   pg_dump -> gzip -> age (public-key encryption) -> /var/backups/cs-virtual-lab/<timestamp>.sql.gz.age
#   then rsync to BACKUP_SSH_TARGET (user@host:/path) when set.
# Only the holder of the age private key (kept OFF the server) can read a backup.
# Reads .env from the application directory. Usage: backup.sh [app-dir]
set -euo pipefail

APP_DIR="${1:-/opt/cs-virtual-lab}"
BACKUP_DIR=/var/backups/cs-virtual-lab
cd "$APP_DIR"
set -a; . ./.env; set +a

: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is not set in .env; run scripts/ops/install-backups.sh}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/cslab-$STAMP.sql.gz.age"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Dump through the running container; no database port is ever exposed on the host.
docker compose exec -T db pg_dump -U cslab --no-owner --no-privileges cslab \
  | gzip -9 \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT"
chmod 600 "$OUT"
SIZE=$(stat -c %s "$OUT")
echo "$(date -u +%FT%TZ) backup written $OUT ($SIZE bytes)"

# Also keep the two files that cannot be regenerated: .env (secrets, RESEARCH_SALT) and the Caddy certificates.
tar -C "$APP_DIR" -czf - .env Caddyfile 2>/dev/null | age -r "$BACKUP_AGE_RECIPIENT" -o "$BACKUP_DIR/config-$STAMP.tar.gz.age"
chmod 600 "$BACKUP_DIR/config-$STAMP.tar.gz.age"

# Prune local copies.
find "$BACKUP_DIR" -type f -name '*.age' -mtime "+$KEEP_DAYS" -delete

# Off-site copy and prune. BACKUP_SSH_TARGET looks like backup@other-host:/srv/cslab-backups
if [ -n "${BACKUP_SSH_TARGET:-}" ]; then
  REMOTE_HOST="${BACKUP_SSH_TARGET%%:*}"
  REMOTE_PATH="${BACKUP_SSH_TARGET#*:}"
  ssh -o BatchMode=yes "$REMOTE_HOST" "mkdir -p '$REMOTE_PATH'"
  rsync -a --no-perms --chmod=F600 "$BACKUP_DIR"/ "$BACKUP_SSH_TARGET"/
  ssh -o BatchMode=yes "$REMOTE_HOST" "find '$REMOTE_PATH' -type f -name '*.age' -mtime +$KEEP_DAYS -delete"
  echo "$(date -u +%FT%TZ) off-site copy done to $BACKUP_SSH_TARGET"
else
  echo "$(date -u +%FT%TZ) WARNING: BACKUP_SSH_TARGET is empty; backups exist only on this server"
fi

#!/usr/bin/env bash
# Update the running app to the latest commit on the deployed branch.
# Takes a backup first, rebuilds the image, restarts only the app (migrations run on start),
# and removes dangling images. Usage: update.sh [app-dir]
set -euo pipefail

APP_DIR="${1:-/opt/cs-virtual-lab}"
cd "$APP_DIR"

if grep -q '^BACKUP_AGE_RECIPIENT=age1' .env; then
  scripts/ops/backup.sh "$APP_DIR"
else
  echo "WARNING: backups are not configured; updating without one."
fi

BEFORE=$(git rev-parse --short HEAD)
git pull --ff-only
AFTER=$(git rev-parse --short HEAD)
echo "Updating $BEFORE -> $AFTER"

docker compose build app
docker compose up -d app
docker image prune -f >/dev/null

sleep 5
if curl -fsS http://127.0.0.1:8787/api/health >/dev/null 2>&1 || docker compose exec -T app wget -qO- http://127.0.0.1:8787/api/health >/dev/null; then
  echo "App is healthy at $AFTER."
else
  echo "Health check failed; recent app logs:"
  docker compose logs --tail=50 app
  exit 1
fi

#!/usr/bin/env bash
# Restore a backup made by backup.sh.
#   Test restore (default): loads into a scratch database "cslab_restore_test" and reports table counts.
#   Real restore (--replace): stops the app, replaces the live database, starts the app.
# Usage: restore.sh <backup.sql.gz.age> <age-identity-file> [--replace] [app-dir]
# The age identity file is the private key you kept off the server (copy it over for the restore,
# then delete it again).
set -euo pipefail

FILE="${1:?backup file (.sql.gz.age)}"
IDENTITY="${2:?age identity file}"
MODE="${3:---test}"
APP_DIR="${4:-/opt/cs-virtual-lab}"
cd "$APP_DIR"
set -a; . ./.env; set +a

decrypt() { age -d -i "$IDENTITY" "$FILE" | gunzip; }

if [ "$MODE" = "--replace" ]; then
  echo "Replacing the live database from $FILE"
  docker compose stop app
  docker compose exec -T db psql -U cslab -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists cslab_old;" -c "alter database cslab rename to cslab_old;" -c "create database cslab owner cslab;"
  decrypt | docker compose exec -T db psql -U cslab -d cslab -v ON_ERROR_STOP=1 -q
  docker compose start app
  echo "Done. The previous database is kept as cslab_old until you drop it:"
  echo "  docker compose exec db psql -U cslab -d postgres -c 'drop database cslab_old;'"
else
  echo "Test restore of $FILE into cslab_restore_test"
  docker compose exec -T db psql -U cslab -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists cslab_restore_test;" -c "create database cslab_restore_test owner cslab;"
  decrypt | docker compose exec -T db psql -U cslab -d cslab_restore_test -v ON_ERROR_STOP=1 -q
  docker compose exec -T db psql -U cslab -d cslab_restore_test -At -c "
    select 'users: ' || count(*) from users
    union all select 'lab_results: ' || count(*) from lab_results
    union all select 'learning_events: ' || count(*) from analytics.learning_events
    union all select 'migrations: ' || string_agg(name, ', ' order by name) from schema_migrations;"
  docker compose exec -T db psql -U cslab -d postgres -c "drop database cslab_restore_test;" >/dev/null
  echo "Test restore succeeded; scratch database dropped."
fi

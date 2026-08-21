#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

POSTGRES_ENV=/etc/financeapp/postgres.env
DEPLOY_CONFIG=/etc/financeapp/deploy.conf
BACKUP_DIR=/var/backups/financeapp/daily
LOCK=/run/lock/financeapp-update.lock

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -r "$POSTGRES_ENV" && -r "$DEPLOY_CONFIG" ]] || { echo "FinanceApp database configuration is missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$POSTGRES_ENV"
# shellcheck disable=SC1090
source "$DEPLOY_CONFIG"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE

PG_DUMP_BIN="${PG_BIN_DIR}/pg_dump"
PG_RESTORE_BIN="${PG_BIN_DIR}/pg_restore"
PSQL_BIN="${PG_BIN_DIR}/psql"
for binary in "$PG_DUMP_BIN" "$PG_RESTORE_BIN" "$PSQL_BIN"; do
  [[ -x "$binary" ]] || { echo "Missing PostgreSQL ${POSTGRES_MAJOR} binary: ${binary}" >&2; exit 1; }
done

exec 9>"$LOCK"
flock 9

SERVER_VERSION_NUM="$("$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc 'show server_version_num')"
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
DUMP_MAJOR="$("$PG_DUMP_BIN" --version | awk '{split($3, version, "."); print version[1]}')"
[[ "$SERVER_MAJOR" == "$POSTGRES_MAJOR" && "$DUMP_MAJOR" == "$POSTGRES_MAJOR" ]] || {
  echo "PostgreSQL backup version mismatch: configured=${POSTGRES_MAJOR}, server=${SERVER_MAJOR}, pg_dump=${DUMP_MAJOR}" >&2
  exit 1
}

install -d -o root -g root -m 0700 "$BACKUP_DIR"
BACKUP="${BACKUP_DIR}/daily-$(date -u +%Y%m%dT%H%M%SZ).dump"
"$PG_DUMP_BIN" --format=custom --no-owner --file="$BACKUP"
"$PG_RESTORE_BIN" --list "$BACKUP" >/dev/null
chmod 0600 "$BACKUP"
chown root:root "$BACKUP"

mapfile -t backups < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -name 'daily-*.dump' -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
for index in "${!backups[@]}"; do
  if (( index >= ${KEEP_BACKUPS:-7} )); then
    rm -f -- "${backups[$index]}"
  fi
done

echo "FinanceApp backup created: ${BACKUP}"

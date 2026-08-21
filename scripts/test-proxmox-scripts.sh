#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LXC="$ROOT/ops/proxmox/financeapp-lxc.sh"
INSTALL="$ROOT/ops/proxmox/install.sh"
UPDATE="$ROOT/ops/proxmox/update.sh"
BACKUP="$ROOT/ops/proxmox/backup.sh"
TAILSCALE="$ROOT/ops/proxmox/configure-tailscale.sh"
SCRIPTS=("$LXC" "$INSTALL" "$UPDATE" "$BACKUP" "$TAILSCALE")

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" reason="$3"
  grep -Fq -- "$text" "$file" || fail "$reason"
}

reject_text() {
  local file="$1" text="$2" reason="$3"
  grep -Fq -- "$text" "$file" && fail "$reason"
  return 0
}

require_order() {
  local file="$1" first="$2" second="$3" reason="$4" first_line second_line
  first_line="$(grep -nF -- "$first" "$file" | tail -n 1 | cut -d: -f1)"
  second_line="$(grep -nF -- "$second" "$file" | head -n 1 | cut -d: -f1)"
  [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]] || fail "$reason"
}

for script in "${SCRIPTS[@]}"; do
  bash -n "$script"
done

REPORT_FUNCTION="$(awk '/^report_failure\(\)/ {capture=1} capture {print} capture && $0 == "}" {exit}' "$LXC")"
set +e
FAILURE_OUTPUT="$(bash -c "${REPORT_FUNCTION}
APP=FinanceApp
CTID=
trap report_failure ERR
false
echo SHOULD_NOT_CONTINUE" 2>&1)"
FAILURE_STATUS=$?
set -e
[[ "$FAILURE_STATUS" -ne 0 ]] || fail "the wrapper failure trap must preserve a non-zero exit status"
[[ "$FAILURE_OUTPUT" != *SHOULD_NOT_CONTINUE* ]] || fail "the wrapper continued after an installation error"

VERSION_FUNCTION="$(awk '/^verify_postgres_versions\(\)/ {capture=1} capture {print} capture && $0 == "}" {exit}' "$UPDATE")"
VERSION_TEST_DIR="$(mktemp -d)"
trap 'rm -rf -- "$VERSION_TEST_DIR"' EXIT
cat >"$VERSION_TEST_DIR/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_SERVER_VERSION_NUM:?}"
EOF
cat >"$VERSION_TEST_DIR/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf 'pg_dump (PostgreSQL) %s\n' "${FAKE_DUMP_VERSION:?}"
EOF
chmod +x "$VERSION_TEST_DIR/psql" "$VERSION_TEST_DIR/pg_dump"
bash -c "${VERSION_FUNCTION}
POSTGRES_MAJOR=17
PSQL_BIN='$VERSION_TEST_DIR/psql'
PG_DUMP_BIN='$VERSION_TEST_DIR/pg_dump'
FAKE_SERVER_VERSION_NUM=170011 FAKE_DUMP_VERSION=17.11 verify_postgres_versions"
if bash -c "${VERSION_FUNCTION}
POSTGRES_MAJOR=17
PSQL_BIN='$VERSION_TEST_DIR/psql'
PG_DUMP_BIN='$VERSION_TEST_DIR/pg_dump'
FAKE_SERVER_VERSION_NUM=180004 FAKE_DUMP_VERSION=17.11 verify_postgres_versions" >/dev/null 2>&1; then
  fail "the updater accepted pg_dump 17 for a PostgreSQL 18 server"
fi

# Literal source-code invariants intentionally use single-quoted shell strings.
# shellcheck disable=SC2016
require_text "$LXC" 'REUSE_SAVED_CONFIG="${REUSE_SAVED_CONFIG:-yes}"' "resume must reuse saved configuration by default"
require_text "$LXC" 'TUN_CONFIG_CHANGED=no' "resume must reconcile the TUN mapping"
require_text "$LXC" 'Saved installation uses' "resume must reject repository or branch mismatches"
require_text "$LXC" 'Recovering the interrupted installation from /etc/financeapp' "resume must recover after the historical false-success bug"
# shellcheck disable=SC2016
require_text "$LXC" 'POSTGRES_DB="${POSTGRES_DB:-financeapp}"' "local database name must have a safe default"
reject_text "$LXC" 'PostgreSQL host or DNS name' "the LXC installer must not prompt for an external PostgreSQL host"
reject_text "$LXC" 'DB_HOST=' "the LXC installer must not persist an external PostgreSQL host"
# shellcheck disable=SC2016
require_text "$LXC" 'exit "$status"' "the failure trap must terminate with the original status"
# shellcheck disable=SC2016
require_order "$LXC" 'install-complete-v2 ||' 'ok "${APP} installed' "success must require the completion marker"
require_text "$INSTALL" 'chmod -R a+rX' "Node must be traversable by the financeapp user"
require_text "$INSTALL" '/usr/local/bin/npm --version' "installation must validate npm as financeapp"
require_text "$INSTALL" 'MIN_MEMORY_MB=1800' "installation must fail early on insufficient memory"
require_text "$INSTALL" 'MIN_FREE_DISK_MB=2048' "deployment must persist a disk-space floor"
require_text "$INSTALL" 'postgresql-17 postgresql-client-17' "server and client must use PostgreSQL major 17"
require_text "$INSTALL" 'listen_addresses 127.0.0.1' "PostgreSQL must listen only on loopback"
require_text "$INSTALL" 'password_encryption scram-sha-256' "PostgreSQL must use SCRAM passwords"
require_text "$INSTALL" 'PGSSLMODE=%q\n' "local database environment must be explicit"
require_text "$UPDATE" 'systemctl is-active --quiet postgresql redis-server nginx financeapp-api financeapp-worker' "health check must validate all services"
require_text "$UPDATE" 'redis-cli ping' "health check must validate Redis"
require_text "$UPDATE" 'verify_postgres_versions' "updates must reject incompatible pg_dump versions"
require_order "$UPDATE" 'verify_postgres_versions' 'systemctl stop financeapp-worker' "PostgreSQL versions must be checked before stopping services"
require_text "$UPDATE" 'pg_database_size(current_database())' "disk preflight must include backup size"
require_text "$UPDATE" 'KEEP_BACKUPS:-7' "database dumps need bounded retention"
require_text "$UPDATE" '-rebuild-' "--force must build an isolated release"
require_text "$UPDATE" 'Discarding an incomplete or mismatched release directory' "resume must repair corrupt partial releases"
# shellcheck disable=SC2016
require_order "$UPDATE" 'health_check' 'install -m 0755 "$RELEASE/ops/proxmox/update.sh"' "administrative scripts must only change after health succeeds"
# shellcheck disable=SC2016
require_text "$TAILSCALE" 'curl -fsS "${ORIGIN}/api/v1/health"' "Tailscale configuration must verify the public tailnet origin"
require_text "$INSTALL" 'listen 127.0.0.1:80;' "Nginx must remain private to the LXC"
# shellcheck disable=SC2016
require_text "$BACKUP" 'PG_DUMP_BIN="${PG_BIN_DIR}/pg_dump"' "backups must use the versioned pg_dump binary"
# shellcheck disable=SC2016
require_text "$BACKUP" 'index >= ${KEEP_BACKUPS:-7}' "daily backups need bounded retention"
# shellcheck disable=SC2016
require_text "$BACKUP" 'chmod 0600 "$BACKUP"' "database backups must be readable only by root"
# shellcheck disable=SC2016
require_text "$BACKUP" 'chown root:root "$BACKUP"' "database backups must not belong to the application user"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${SCRIPTS[@]}" "$ROOT/scripts/test-proxmox-scripts.sh"
else
  echo "[WARN] shellcheck is unavailable; CI must run it."
fi

echo "[OK] Proxmox deployment scripts passed syntax and invariant checks."

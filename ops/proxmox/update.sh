#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

DEPLOY_CONFIG=/etc/financeapp/deploy.conf
APP_ENV=/etc/financeapp/financeapp.env
POSTGRES_ENV=/etc/financeapp/postgres.env
SOURCE=/opt/financeapp/source
RELEASES=/opt/financeapp/releases
CURRENT=/opt/financeapp/current
PREVIOUS=/opt/financeapp/previous
BACKUPS=/var/backups/financeapp
LOCK=/run/lock/financeapp-update.lock
INITIAL=no
FORCE=no
ROLLBACK=no
REF=""

usage() {
  cat <<'EOF'
Usage: financeapp-update [--check] [--force] [--rollback] [git-ref]

Without a ref, deploys the newest commit from the configured branch.
--check     Show installed and available commits without changing anything.
--force     Rebuild even when the commit is already installed.
--rollback  Switch services to the previously deployed application release.
EOF
}

CHECK=no
while [[ $# -gt 0 ]]; do
  case "$1" in
    --initial) INITIAL=yes ;;
    --check) CHECK=yes ;;
    --force) FORCE=yes ;;
    --rollback) ROLLBACK=yes ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage; exit 2 ;;
    *) [[ -z "$REF" ]] || { echo "Only one git ref is accepted" >&2; exit 2; }; REF="$1" ;;
  esac
  shift
done

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -r "$DEPLOY_CONFIG" && -r "$APP_ENV" && -r "$POSTGRES_ENV" ]] || { echo "FinanceApp configuration is missing" >&2; exit 1; }
# shellcheck disable=SC1090
source "$DEPLOY_CONFIG"
# shellcheck disable=SC1090
source "$APP_ENV"
# shellcheck disable=SC1090
source "$POSTGRES_ENV"
PGSSLMODE="${PGSSLMODE:-disable}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
export PGSSLMODE
PG_DUMP_BIN="${PG_BIN_DIR}/pg_dump"
PG_RESTORE_BIN="${PG_BIN_DIR}/pg_restore"
PSQL_BIN="${PG_BIN_DIR}/psql"
POSTGRES_CLUSTER_SERVICE="postgresql@${POSTGRES_MAJOR}-main.service"
exec 9>"$LOCK"
flock -n 9 || { echo "Another FinanceApp update is running" >&2; exit 1; }

for required_command in curl df flock git jq redis-cli runuser systemctl; do
  command -v "$required_command" >/dev/null || { echo "Missing required command: ${required_command}" >&2; exit 1; }
done
for postgres_binary in "$PG_DUMP_BIN" "$PG_RESTORE_BIN" "$PSQL_BIN"; do
  [[ -x "$postgres_binary" ]] || { echo "Missing PostgreSQL ${POSTGRES_MAJOR} binary: ${postgres_binary}" >&2; exit 1; }
done

verify_postgres_versions() {
  local server_version_num server_major dump_major
  server_version_num="$("$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc 'show server_version_num')"
  server_major=$((server_version_num / 10000))
  dump_major="$("$PG_DUMP_BIN" --version | awk '{split($3, version, "."); print version[1]}')"
  [[ "$server_major" == "$POSTGRES_MAJOR" && "$dump_major" == "$POSTGRES_MAJOR" ]] || {
    echo "PostgreSQL backup version mismatch: configured=${POSTGRES_MAJOR}, server=${server_major}, pg_dump=${dump_major}" >&2
    return 1
  }
}

health_check() {
  "$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc 'select 1' >/dev/null
  [[ "$(redis-cli ping 2>/dev/null)" == "PONG" ]]
  for _ in {1..30}; do
    if systemctl is-active --quiet "$POSTGRES_CLUSTER_SERVICE" redis-server nginx financeapp-api financeapp-worker &&
      curl -fsS http://127.0.0.1/api/v1/health | jq -e '.status == "ok"' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_stack() {
  systemctl restart financeapp-api financeapp-worker nginx
}

git_as_financeapp() {
  runuser -u financeapp -- git -C "$SOURCE" "$@"
}

run_release_migrations() {
  (
    cd "$RELEASE/server"
    runuser -u financeapp -- env "DATABASE_URL=${DATABASE_URL}" "PYTHONPATH=${RELEASE}/server" \
      "$RELEASE/server/.venv/bin/python" -m alembic -c alembic.ini upgrade head
  )
}

release_commit() {
  local release_path="$1"
  [[ -d "$release_path/.git" || -f "$release_path/.git" ]] || return 1
  runuser -u financeapp -- git -C "$release_path" rev-parse --verify HEAD 2>/dev/null
}

prune_old_releases() {
  local protected_target="${1:-}" candidate kept=0
  local current_path previous_path
  current_path="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  previous_path="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  mapfile -t candidates < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" == "$current_path" || "$candidate" == "$previous_path" || "$candidate" == "$protected_target" ]]; then
      continue
    fi
    kept=$((kept + 1))
    if (( kept > ${KEEP_RELEASES:-3} )); then
      git_as_financeapp worktree remove --force "$candidate" 2>/dev/null || rm -rf -- "$candidate"
    fi
  done
  git_as_financeapp worktree prune
}

if [[ "$ROLLBACK" == "yes" ]]; then
  [[ -L "$PREVIOUS" && -d "$(readlink -f "$PREVIOUS")" ]] || { echo "No previous release is available" >&2; exit 1; }
  old_current="$(readlink -f "$CURRENT")"
  rollback_target="$(readlink -f "$PREVIOUS")"
  ln -sfn "$rollback_target" "${CURRENT}.new"
  mv -Tf "${CURRENT}.new" "$CURRENT"
  ln -sfn "$old_current" "$PREVIOUS"
  restart_stack
  health_check || { echo "Rollback release did not become healthy" >&2; exit 1; }
  echo "Rolled back application to $(basename "$rollback_target"). Database migrations were not downgraded."
  exit 0
fi

git_as_financeapp remote set-url origin "$FINANCEAPP_REPO_URL"
git_as_financeapp fetch --prune --tags origin
if [[ -z "$REF" ]]; then
  REF="origin/${FINANCEAPP_BRANCH}"
fi
TARGET_COMMIT="$(git_as_financeapp rev-parse --verify "${REF}^{commit}")"
CURRENT_COMMIT=""
CURRENT_RELEASE=""
if [[ -L "$CURRENT" ]]; then
  CURRENT_RELEASE="$(readlink -f "$CURRENT")"
  CURRENT_COMMIT="$(release_commit "$CURRENT_RELEASE" || true)"
fi

if [[ "$CHECK" == "yes" ]]; then
  echo "Installed: ${CURRENT_COMMIT:-none}"
  echo "Available: ${TARGET_COMMIT} (${REF})"
  [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]] && echo "Status: current" || echo "Status: update available"
  exit 0
fi
if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
  [[ "$FORCE" == "yes" ]] || { echo "FinanceApp is already current at ${TARGET_COMMIT}."; exit 0; }
  echo "Forcing validation and rebuild of the active release ${TARGET_COMMIT}."
fi

RELEASE="${RELEASES}/${TARGET_COMMIT}"
if [[ "$FORCE" == "yes" ]]; then
  RELEASE="${RELEASES}/${TARGET_COMMIT}-rebuild-$(date -u +%Y%m%dT%H%M%SZ)"
fi
prune_old_releases "$RELEASE"
if [[ -d "$RELEASE" && "$(release_commit "$RELEASE" || true)" != "$TARGET_COMMIT" ]]; then
  echo "Discarding an incomplete or mismatched release directory at ${RELEASE}"
  git_as_financeapp worktree remove --force "$RELEASE" 2>/dev/null || rm -rf -- "$RELEASE"
  git_as_financeapp worktree prune
fi
if [[ ! -d "$RELEASE" ]]; then
  echo "Preparing release ${TARGET_COMMIT}"
  git_as_financeapp worktree add --detach "$RELEASE" "$TARGET_COMMIT"
fi

verify_postgres_versions
DATABASE_BYTES="$("$PSQL_BIN" -v ON_ERROR_STOP=1 -Atc 'select pg_database_size(current_database())')"
FREE_DISK_MB="$(df -Pm "$RELEASES" | awk 'NR == 2 {print $4}')"
REQUIRED_DISK_MB=$(( ${MIN_FREE_DISK_MB:-2048} + DATABASE_BYTES / 1024 / 1024 ))
(( FREE_DISK_MB >= REQUIRED_DISK_MB )) || {
  echo "Insufficient free disk: ${FREE_DISK_MB} MiB available; ${REQUIRED_DISK_MB} MiB required for build plus database backup." >&2
  exit 1
}

PYTHON_READY="${RELEASE}/.financeapp-python-ready-v1"
if [[ -x "$RELEASE/server/.venv/bin/python" ]] &&
  runuser -u financeapp -- "$RELEASE/server/.venv/bin/python" -c 'import app, fastapi, sqlalchemy' >/dev/null 2>&1; then
  runuser -u financeapp -- touch "$PYTHON_READY"
else
  rm -f "$PYTHON_READY"
fi
if [[ -f "$PYTHON_READY" ]]; then
  echo "Using cached Python dependencies for ${TARGET_COMMIT}"
else
  echo "Installing Python dependencies"
  PIP_CACHE=/opt/financeapp/shared/pip-cache
  install -d -o financeapp -g financeapp -m 0750 "$PIP_CACHE"
  rm -rf -- "$RELEASE/server/.venv"
  runuser -u financeapp -- python3 -m venv "$RELEASE/server/.venv"
  runuser -u financeapp -- env PIP_CACHE_DIR="$PIP_CACHE" \
    "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check --upgrade pip
  if [[ "${INSTALL_AI:-no}" == "yes" ]]; then
    runuser -u financeapp -- env PIP_CACHE_DIR="$PIP_CACHE" \
      "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check "${RELEASE}/server[ai]"
  else
    runuser -u financeapp -- env PIP_CACHE_DIR="$PIP_CACHE" \
      "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check "$RELEASE/server"
  fi
  runuser -u financeapp -- "$RELEASE/server/.venv/bin/python" -c 'import app, fastapi, sqlalchemy'
  runuser -u financeapp -- touch "$PYTHON_READY"
fi

NPM_PATH=/usr/local/bin/npm
BUILD_PATH=/usr/local/bin:/usr/bin:/bin
[[ -x "$NPM_PATH" ]] || { echo "npm is missing at ${NPM_PATH}" >&2; exit 1; }
runuser -u financeapp -- env HOME=/opt/financeapp/shared PATH="$BUILD_PATH" "$NPM_PATH" --version >/dev/null || {
  echo "npm exists but is not executable by the financeapp user. Check permissions under /usr/local/lib/nodejs." >&2
  exit 1
}
WEB_DEPS_READY="${RELEASE}/.financeapp-web-deps-ready-v1"
PWA_READY="${RELEASE}/.financeapp-pwa-ready-v1"
if [[ -f "$RELEASE/web/node_modules/.package-lock.json" ]] &&
  runuser -u financeapp -- env HOME=/opt/financeapp/shared PATH="$BUILD_PATH" \
    "$NPM_PATH" --prefix "$RELEASE/web" ls --depth=0 >/dev/null 2>&1; then
  runuser -u financeapp -- touch "$WEB_DEPS_READY"
else
  rm -f "$WEB_DEPS_READY" "$PWA_READY"
fi
if [[ ! -f "$WEB_DEPS_READY" ]]; then
  echo "Installing PWA dependencies"
  runuser -u financeapp -- env HOME=/opt/financeapp/shared PATH="$BUILD_PATH" \
    "$NPM_PATH" --prefix "$RELEASE/web" ci --no-audit --no-fund
  runuser -u financeapp -- touch "$WEB_DEPS_READY"
else
  echo "Using cached PWA dependencies for ${TARGET_COMMIT}"
fi
if [[ -f "$PWA_READY" && -f "$RELEASE/web/dist/client/index.html" ]]; then
  echo "Using cached PWA build for ${TARGET_COMMIT}"
else
  echo "Building PWA"
  runuser -u financeapp -- env HOME=/opt/financeapp/shared PATH="$BUILD_PATH" VITE_API_URL=/api/v1 \
    "$NPM_PATH" --prefix "$RELEASE/web" run build
  [[ -f "$RELEASE/web/dist/client/index.html" ]] || { echo "PWA build did not produce dist/client/index.html" >&2; exit 1; }
  runuser -u financeapp -- touch "$PWA_READY"
fi

for migration_path in \
  "$RELEASE/server/pyproject.toml" \
  "$RELEASE/server/alembic.ini" \
  "$RELEASE/server/alembic/env.py"; do
  runuser -u financeapp -- test -r "$migration_path" || {
    echo "Migration prerequisite is not readable by financeapp: ${migration_path}" >&2
    exit 1
  }
done
runuser -u financeapp -- test -x "$RELEASE/server/.venv/bin/python" || {
  echo "Migration Python is not executable by financeapp: ${RELEASE}/server/.venv/bin/python" >&2
  exit 1
}

BACKUP="${BACKUPS}/pre-update-$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_COMMIT:-initial}.dump"
update_failed() {
  local failure_status=$?
  trap - ERR
  set +e
  echo "Deployment failed; restoring the previous application release" >&2
  if [[ -n "$CURRENT_RELEASE" && -d "$CURRENT_RELEASE" ]]; then
    ln -sfn "$CURRENT_RELEASE" "${CURRENT}.new"
    mv -Tf "${CURRENT}.new" "$CURRENT"
    restart_stack || true
    health_check || echo "Previous application release is not healthy; the database migration may require manual recovery." >&2
  fi
  if [[ -s "$BACKUP" ]] && "$PG_RESTORE_BIN" --list "$BACKUP" >/dev/null 2>&1; then
    echo "Database backup: ${BACKUP}" >&2
  else
    rm -f -- "$BACKUP"
    echo "No complete database backup was produced." >&2
  fi
  exit "$failure_status"
}
trap update_failed ERR

systemctl stop financeapp-worker financeapp-api 2>/dev/null || true
echo "Creating PostgreSQL backup at ${BACKUP}"
"$PG_DUMP_BIN" --format=custom --no-owner --file="$BACKUP"
"$PG_RESTORE_BIN" --list "$BACKUP" >/dev/null
chmod 0600 "$BACKUP"
chown root:root "$BACKUP"

echo "Applying database migrations"
run_release_migrations

if [[ -n "$CURRENT_RELEASE" ]]; then
  ln -sfn "$CURRENT_RELEASE" "$PREVIOUS"
fi
ln -sfn "$RELEASE" "${CURRENT}.new"
mv -Tf "${CURRENT}.new" "$CURRENT"
restart_stack
health_check
install -m 0755 "$RELEASE/ops/proxmox/update.sh" /usr/local/sbin/financeapp-update
install -m 0755 "$RELEASE/ops/proxmox/configure-tailscale.sh" /usr/local/sbin/financeapp-configure-tailscale
install -m 0755 "$RELEASE/ops/proxmox/configure-lan.sh" /usr/local/sbin/financeapp-configure-lan
install -m 0755 "$RELEASE/ops/proxmox/backup.sh" /usr/local/sbin/financeapp-backup
trap - ERR

echo "FinanceApp is healthy at ${TARGET_COMMIT}."
if [[ "$INITIAL" != "yes" ]]; then
  echo "Database backup: ${BACKUP}"
fi

prune_old_releases "$RELEASE"
mapfile -t backup_candidates < <(find "$BACKUPS" -mindepth 1 -maxdepth 1 -type f -name 'pre-update-*.dump' -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
for backup_index in "${!backup_candidates[@]}"; do
  if (( backup_index >= ${KEEP_BACKUPS:-7} )); then
    rm -f -- "${backup_candidates[$backup_index]}"
  fi
done

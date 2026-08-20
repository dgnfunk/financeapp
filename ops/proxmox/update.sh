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
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
exec 9>"$LOCK"
flock -n 9 || { echo "Another FinanceApp update is running" >&2; exit 1; }

health_check() {
  local attempt
  psql -v ON_ERROR_STOP=1 -Atc 'select 1' >/dev/null
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1/api/v1/health | jq -e '.status == "ok"' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_stack() {
  systemctl restart financeapp-api financeapp-worker nginx
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

git -C "$SOURCE" remote set-url origin "$FINANCEAPP_REPO_URL"
runuser -u financeapp -- git -C "$SOURCE" fetch --prune --tags origin
if [[ -z "$REF" ]]; then
  REF="origin/${FINANCEAPP_BRANCH}"
fi
TARGET_COMMIT="$(git -C "$SOURCE" rev-parse --verify "${REF}^{commit}")"
CURRENT_COMMIT=""
[[ -L "$CURRENT" ]] && CURRENT_COMMIT="$(basename "$(readlink -f "$CURRENT")")"

if [[ "$CHECK" == "yes" ]]; then
  echo "Installed: ${CURRENT_COMMIT:-none}"
  echo "Available: ${TARGET_COMMIT} (${REF})"
  [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]] && echo "Status: current" || echo "Status: update available"
  exit 0
fi
if [[ "$CURRENT_COMMIT" == "$TARGET_COMMIT" ]]; then
  if [[ "$FORCE" == "yes" ]]; then
    echo "Refusing to rebuild the active release in place. Deploy another ref or roll back first." >&2
    exit 1
  fi
  echo "FinanceApp is already current at ${TARGET_COMMIT}."
  exit 0
fi

RELEASE="${RELEASES}/${TARGET_COMMIT}"
if [[ ! -d "$RELEASE" ]]; then
  echo "Preparing release ${TARGET_COMMIT}"
  runuser -u financeapp -- git -C "$SOURCE" worktree add --detach "$RELEASE" "$TARGET_COMMIT"
fi

echo "Installing Python dependencies"
rm -rf -- "$RELEASE/server/.venv"
runuser -u financeapp -- python3 -m venv "$RELEASE/server/.venv"
runuser -u financeapp -- "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check --no-cache-dir --upgrade pip
if [[ "${INSTALL_AI:-no}" == "yes" ]]; then
  runuser -u financeapp -- "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check --no-cache-dir "${RELEASE}/server[ai]"
else
  runuser -u financeapp -- "$RELEASE/server/.venv/bin/pip" install --disable-pip-version-check --no-cache-dir "$RELEASE/server"
fi

echo "Building PWA"
runuser -u financeapp -- env HOME=/opt/financeapp/shared npm --prefix "$RELEASE/web" ci --no-audit --no-fund
runuser -u financeapp -- env HOME=/opt/financeapp/shared VITE_API_URL=/api/v1 npm --prefix "$RELEASE/web" run build

BACKUP="${BACKUPS}/pre-update-$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_COMMIT:-initial}.dump"
update_failed() {
  echo "Deployment failed; restoring the previous application release" >&2
  if [[ -n "$CURRENT_COMMIT" && -d "${RELEASES}/${CURRENT_COMMIT}" ]]; then
    ln -sfn "${RELEASES}/${CURRENT_COMMIT}" "${CURRENT}.new"
    mv -Tf "${CURRENT}.new" "$CURRENT"
    restart_stack || true
  fi
  if [[ -s "$BACKUP" ]] && pg_restore --list "$BACKUP" >/dev/null 2>&1; then
    echo "Database backup: ${BACKUP}" >&2
  else
    rm -f -- "$BACKUP"
    echo "No complete database backup was produced." >&2
  fi
}
trap update_failed ERR

systemctl stop financeapp-worker financeapp-api 2>/dev/null || true
echo "Creating PostgreSQL backup at ${BACKUP}"
pg_dump --format=custom --no-owner --file="$BACKUP"
pg_restore --list "$BACKUP" >/dev/null
chmod 0640 "$BACKUP"
chown root:financeapp "$BACKUP"

echo "Applying database migrations"
runuser -u financeapp -- env "DATABASE_URL=${DATABASE_URL}" "PYTHONPATH=${RELEASE}/server" \
  "$RELEASE/server/.venv/bin/python" -m alembic -c "$RELEASE/server/alembic.ini" upgrade head

if [[ -n "$CURRENT_COMMIT" ]]; then
  ln -sfn "${RELEASES}/${CURRENT_COMMIT}" "$PREVIOUS"
fi
ln -sfn "$RELEASE" "${CURRENT}.new"
mv -Tf "${CURRENT}.new" "$CURRENT"
install -m 0755 "$RELEASE/ops/proxmox/update.sh" /usr/local/sbin/financeapp-update
install -m 0755 "$RELEASE/ops/proxmox/configure-tailscale.sh" /usr/local/sbin/financeapp-configure-tailscale
restart_stack
health_check
trap - ERR

echo "FinanceApp is healthy at ${TARGET_COMMIT}."
if [[ "$INITIAL" != "yes" ]]; then
  echo "Database backup: ${BACKUP}"
fi

# Keep the current release, the rollback release, and a small bounded history.
mapfile -t candidates < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
kept=0
for candidate in "${candidates[@]}"; do
  if [[ "$candidate" == "$(readlink -f "$CURRENT")" || ( -L "$PREVIOUS" && "$candidate" == "$(readlink -f "$PREVIOUS")" ) ]]; then
    continue
  fi
  kept=$((kept + 1))
  if (( kept > ${KEEP_RELEASES:-3} )); then
    git -C "$SOURCE" worktree remove --force "$candidate" 2>/dev/null || rm -rf -- "$candidate"
  fi
done

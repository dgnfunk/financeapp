#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LXC="$ROOT/ops/proxmox/financeapp-lxc.sh"
INSTALL="$ROOT/ops/proxmox/install.sh"
UPDATE="$ROOT/ops/proxmox/update.sh"
TAILSCALE="$ROOT/ops/proxmox/configure-tailscale.sh"
SCRIPTS=("$LXC" "$INSTALL" "$UPDATE" "$TAILSCALE")

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

require_text() {
  local file="$1" text="$2" reason="$3"
  grep -Fq -- "$text" "$file" || fail "$reason"
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

# Literal source-code invariants intentionally use single-quoted shell strings.
# shellcheck disable=SC2016
require_text "$LXC" 'REUSE_SAVED_CONFIG="${REUSE_SAVED_CONFIG:-yes}"' "resume must reuse saved configuration by default"
require_text "$LXC" 'TUN_CONFIG_CHANGED=no' "resume must reconcile the TUN mapping"
require_text "$LXC" 'Saved installation uses' "resume must reject repository or branch mismatches"
# shellcheck disable=SC2016
require_text "$LXC" 'DB_SSLMODE=${DB_SSLMODE}' "PostgreSQL SSL mode must survive resume"
require_text "$INSTALL" 'chmod -R a+rX' "Node must be traversable by the financeapp user"
require_text "$INSTALL" '/usr/local/bin/npm --version' "installation must validate npm as financeapp"
require_text "$INSTALL" 'MIN_MEMORY_MB=1800' "installation must fail early on insufficient memory"
require_text "$INSTALL" 'MIN_FREE_DISK_MB=2048' "deployment must persist a disk-space floor"
require_text "$UPDATE" 'systemctl is-active --quiet redis-server nginx financeapp-api financeapp-worker' "health check must validate all services"
require_text "$UPDATE" 'redis-cli ping' "health check must validate Redis"
require_text "$UPDATE" 'pg_database_size(current_database())' "disk preflight must include backup size"
require_text "$UPDATE" 'KEEP_BACKUPS:-7' "database dumps need bounded retention"
require_text "$UPDATE" '-rebuild-' "--force must build an isolated release"
require_text "$UPDATE" 'Discarding an incomplete or mismatched release directory' "resume must repair corrupt partial releases"
# shellcheck disable=SC2016
require_order "$UPDATE" 'health_check' 'install -m 0755 "$RELEASE/ops/proxmox/update.sh"' "administrative scripts must only change after health succeeds"
# shellcheck disable=SC2016
require_text "$TAILSCALE" 'curl -fsS "${ORIGIN}/api/v1/health"' "Tailscale configuration must verify the public tailnet origin"
require_text "$INSTALL" 'listen 127.0.0.1:80;' "Nginx must remain private to the LXC"

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${SCRIPTS[@]}" "$ROOT/scripts/test-proxmox-scripts.sh"
else
  echo "[WARN] shellcheck is unavailable; CI must run it."
fi

echo "[OK] Proxmox deployment scripts passed syntax and invariant checks."

#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }

# Compatibility dispatcher: an older updater always refreshes this command,
# so the first release containing LAN support can enable it without requiring
# a second forced deployment to install the new friendly command.
case "${1:-}" in
  --lan-enable)
    shift
    exec /opt/financeapp/current/ops/proxmox/configure-lan.sh enable "$@"
    ;;
  --lan-disable)
    exec /opt/financeapp/current/ops/proxmox/configure-lan.sh disable
    ;;
  --lan-status)
    exec /opt/financeapp/current/ops/proxmox/configure-lan.sh status
    ;;
esac

command -v tailscale >/dev/null || { echo "Tailscale is not installed" >&2; exit 1; }
tailscale status >/dev/null 2>&1 || {
  echo "This LXC is not connected to Tailscale. Run: tailscale up" >&2
  exit 1
}

DNS_NAME="$(tailscale status --json | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
[[ -n "$DNS_NAME" ]] || { echo "Tailscale did not return a MagicDNS hostname" >&2; exit 1; }
ORIGIN="https://${DNS_NAME}"
ENV_FILE=/etc/financeapp/financeapp.env
ENV_BACKUP="$(mktemp)"
cp --preserve=mode,ownership "$ENV_FILE" "$ENV_BACKUP"
restore_env() {
  local status=$?
  cp --preserve=mode,ownership "$ENV_BACKUP" "$ENV_FILE"
  systemctl restart financeapp-api >/dev/null 2>&1 || true
  rm -f "$ENV_BACKUP"
  exit "$status"
}
trap restore_env ERR

sed -i \
  -e "s|^WEBAUTHN_RP_ID=.*|WEBAUTHN_RP_ID=${DNS_NAME}|" \
  -e "s|^WEBAUTHN_ORIGIN=.*|WEBAUTHN_ORIGIN=${ORIGIN}|" \
  "$ENV_FILE"
systemctl restart financeapp-api
systemctl is-active --quiet financeapp-api nginx
tailscale serve --bg --yes --https=443 http://127.0.0.1:80
trap - ERR
rm -f "$ENV_BACKUP"

for _attempt in {1..20}; do
  if curl -fsS "${ORIGIN}/api/v1/health" | jq -e '.status == "ok"' >/dev/null; then
    echo "FinanceApp is available privately at ${ORIGIN}"
    exit 0
  fi
  sleep 1
done
echo "FinanceApp services did not become healthy" >&2
false

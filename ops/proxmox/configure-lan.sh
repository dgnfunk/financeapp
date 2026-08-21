#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root" >&2; exit 1; }

# The first upgraded release reaches this script through the compatibility
# dispatcher. Install the friendly command immediately for subsequent use.
if [[ "${BASH_SOURCE[0]}" != "/usr/local/sbin/financeapp-configure-lan" ]]; then
  install -m 0755 "${BASH_SOURCE[0]}" /usr/local/sbin/financeapp-configure-lan
fi

MODE="${1:-status}"
REQUESTED_IP="${2:-}"
NGINX_SITE=/etc/nginx/sites-available/financeapp
LAN_LISTENERS=/etc/nginx/financeapp-listeners.conf
INCLUDE_LINE='  include /etc/nginx/financeapp-listeners.conf;'

usage() {
  cat <<'EOF'
Usage: financeapp-configure-lan enable [LAN_IPV4]
       financeapp-configure-lan disable
       financeapp-configure-lan status

Enables plain HTTP only on the LXC eth0 address. Tailscale HTTPS remains
available independently through the loopback listener.
EOF
}

detect_lan_ip() {
  local detected
  detected="$(ip -4 -o addr show dev eth0 scope global | awk 'NR == 1 {split($4, address, "/"); print address[1]}')"
  [[ -n "$detected" ]] || { echo "No global IPv4 address was found on eth0" >&2; exit 1; }
  printf '%s\n' "$detected"
}

validate_lan_ip() {
  local candidate="$1"
  [[ "$candidate" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || {
    echo "Invalid LAN IPv4 address: ${candidate}" >&2
    exit 1
  }
  ip -4 -o addr show dev eth0 scope global |
    awk '{split($4, address, "/"); print address[1]}' |
    grep -Fqx "$candidate" || {
      echo "${candidate} is not assigned to eth0" >&2
      exit 1
    }
}

show_status() {
  local configured
  configured="$(awk '$1 == "listen" && $2 ~ /^[0-9.]+:80;$/ {sub(/:80;$/, "", $2); print $2; exit}' "$LAN_LISTENERS" 2>/dev/null || true)"
  if [[ -n "$configured" ]]; then
    echo "FinanceApp LAN HTTP is enabled at http://${configured}"
  else
    echo "FinanceApp LAN HTTP is disabled. Tailscale/loopback access is unchanged."
  fi
}

case "$MODE" in
  status)
    show_status
    exit 0
    ;;
  enable | disable) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for required_command in awk curl grep install ip jq nginx sed systemctl; do
  command -v "$required_command" >/dev/null || {
    echo "Missing required command: ${required_command}" >&2
    exit 1
  }
done
[[ -f "$NGINX_SITE" ]] || { echo "FinanceApp Nginx site is missing: ${NGINX_SITE}" >&2; exit 1; }

SITE_BACKUP="$(mktemp)"
LISTENER_BACKUP="$(mktemp)"
HAD_LISTENER=no
cp --preserve=mode,ownership "$NGINX_SITE" "$SITE_BACKUP"
if [[ -e "$LAN_LISTENERS" ]]; then
  cp --preserve=mode,ownership "$LAN_LISTENERS" "$LISTENER_BACKUP"
  HAD_LISTENER=yes
fi
rollback() {
  local status=$?
  trap - ERR
  cp --preserve=mode,ownership "$SITE_BACKUP" "$NGINX_SITE"
  if [[ "$HAD_LISTENER" == "yes" ]]; then
    cp --preserve=mode,ownership "$LISTENER_BACKUP" "$LAN_LISTENERS"
  else
    rm -f -- "$LAN_LISTENERS"
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx >/dev/null 2>&1 || true
  fi
  rm -f -- "$SITE_BACKUP" "$LISTENER_BACKUP"
  exit "$status"
}
trap rollback ERR

if ! grep -Fqx "$INCLUDE_LINE" "$NGINX_SITE"; then
  sed -i '/^[[:space:]]*listen 127\.0\.0\.1:80;[[:space:]]*$/a\  include /etc/nginx/financeapp-listeners.conf;' "$NGINX_SITE"
fi
grep -Fqx "$INCLUDE_LINE" "$NGINX_SITE" || {
  echo "Could not add the managed LAN listener include to ${NGINX_SITE}" >&2
  false
}

if [[ "$MODE" == "enable" ]]; then
  LAN_IP="${REQUESTED_IP:-$(detect_lan_ip)}"
  validate_lan_ip "$LAN_IP"
  TEMPORARY_LISTENER="$(mktemp)"
  printf 'listen %s:80;\n' "$LAN_IP" >"$TEMPORARY_LISTENER"
  install -o root -g root -m 0644 "$TEMPORARY_LISTENER" "$LAN_LISTENERS"
  rm -f -- "$TEMPORARY_LISTENER"
else
  install -o root -g root -m 0644 /dev/null "$LAN_LISTENERS"
fi

nginx -t
systemctl reload nginx

if [[ "$MODE" == "enable" ]]; then
  curl -fsS "http://${LAN_IP}/api/v1/health" | jq -e '.status == "ok"' >/dev/null
fi

trap - ERR
rm -f -- "$SITE_BACKUP" "$LISTENER_BACKUP"
show_status

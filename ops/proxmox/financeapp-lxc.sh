#!/usr/bin/env bash
set -Eeuo pipefail

APP="FinanceApp"
DEFAULT_REPO="${FINANCEAPP_REPO_URL:-}"
BRANCH="${FINANCEAPP_BRANCH:-main}"
CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null || true)}"
CT_HOSTNAME="${CT_HOSTNAME:-financeapp}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-4096}"
SWAP="${SWAP:-512}"
DISK="${DISK:-12}"
BRIDGE="${BRIDGE:-vmbr0}"
IP_CONFIG="${IP_CONFIG:-dhcp}"
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
ENABLE_TAILSCALE="${ENABLE_TAILSCALE:-yes}"
INSTALL_AI="${INSTALL_AI:-no}"
RESUME_EXISTING="${RESUME_EXISTING:-no}"

TEMP_FILES=()
cleanup() {
  local file
  for file in "${TEMP_FILES[@]:-}"; do
    [[ -n "$file" ]] && rm -f -- "$file"
  done
}
trap cleanup EXIT
trap 'echo "[ERROR] ${APP} installation failed at line ${LINENO}." >&2' ERR

die() { echo "[ERROR] $*" >&2; exit 1; }
info() { echo "[INFO] $*"; }
ok() { echo "[OK] $*"; }
start_container() {
  local start_log
  start_log="$(mktemp)"
  TEMP_FILES+=("$start_log")

  if pct start "$CTID" --debug >"$start_log" 2>&1; then
    return 0
  fi

  echo >&2
  echo "[ERROR] Proxmox could not start LXC ${CTID}. Debug output follows:" >&2
  cat "$start_log" >&2
  echo >&2
  echo "[INFO] Generated container configuration:" >&2
  pct config "$CTID" >&2 || true
  echo >&2
  echo "[INFO] Host diagnostics:" >&2
  printf 'Proxmox: ' >&2
  pveversion >&2 || true
  printf 'Kernel: ' >&2
  uname -srmo >&2 || true
  printf 'Host architecture: ' >&2
  dpkg --print-architecture >&2 || uname -m >&2 || true
  if [[ -c /dev/net/tun ]]; then
    echo "TUN device: available" >&2
  else
    echo "TUN device: missing (a Tailscale bind mount can prevent LXC startup)" >&2
  fi
  echo >&2
  echo "Copy this complete diagnostic block when reporting the failure." >&2
  return 1
}
prompt_default() {
  local variable="$1" label="$2" default="$3" value
  read -r -p "$label [$default]: " value
  printf -v "$variable" '%s' "${value:-$default}"
}
prompt_required() {
  local variable="$1" label="$2" value="${!1:-}"
  while [[ -z "$value" ]]; do
    read -r -p "$label: " value
  done
  printf -v "$variable" '%s' "$value"
}

[[ $EUID -eq 0 ]] || die "Run this script as root in the Proxmox VE shell."
for command in pveversion pct pveam pvesh pvesm curl openssl base64; do
  command -v "$command" >/dev/null || die "Missing required Proxmox command: $command"
done
[[ -n "$CTID" && "$CTID" =~ ^[0-9]+$ ]] || die "Could not determine a valid CT ID."
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
case "$HOST_ARCH" in
  amd64 | arm64) ;;
  *) die "Unsupported or undetected Proxmox host architecture: ${HOST_ARCH:-unknown}." ;;
esac

echo
echo "${APP} — Debian LXC installer"
echo "The application and Redis will live in this LXC; PostgreSQL remains external."
echo

if [[ -z "$DEFAULT_REPO" ]]; then
  read -r -p "Public Git repository URL (https://github.com/OWNER/REPO.git): " DEFAULT_REPO
fi
[[ "$DEFAULT_REPO" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]] ||
  die "FINANCEAPP_REPO_URL must be a public HTTPS GitHub repository."
[[ "$BRANCH" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "Invalid Git branch name."

prompt_default CTID "Container ID" "$CTID"
[[ "$CTID" =~ ^[0-9]+$ ]] || die "Container ID ${CTID} is invalid."
if [[ -e "/etc/pve/lxc/${CTID}.conf" && "$RESUME_EXISTING" != "yes" ]]; then
  die "Container ID ${CTID} already exists. Set RESUME_EXISTING=yes only to resume a container created by this installer."
fi
if [[ ! -e "/etc/pve/lxc/${CTID}.conf" && "$RESUME_EXISTING" == "yes" ]]; then
  die "Cannot resume because container ${CTID} does not exist."
fi
prompt_default CT_HOSTNAME "Hostname" "$CT_HOSTNAME"
prompt_default CORES "CPU cores" "$CORES"
prompt_default MEMORY "RAM in MiB" "$MEMORY"
prompt_default DISK "Disk in GiB" "$DISK"
prompt_default BRIDGE "Network bridge" "$BRIDGE"
prompt_required DB_HOST "PostgreSQL host or DNS name"
prompt_default DB_PORT "PostgreSQL port" "$DB_PORT"
prompt_required DB_NAME "PostgreSQL database"
prompt_required DB_USER "PostgreSQL user"
[[ "$CT_HOSTNAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "Invalid LXC hostname."
[[ "$CORES" =~ ^[0-9]+$ && "$MEMORY" =~ ^[0-9]+$ && "$DISK" =~ ^[0-9]+$ ]] || die "CPU, RAM, and disk values must be integers."
[[ "$DB_HOST" =~ ^[A-Za-z0-9.-]+$ && "$DB_PORT" =~ ^[0-9]+$ ]] || die "Invalid PostgreSQL host or port."
[[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ && "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "Invalid PostgreSQL database or user."
read -r -s -p "PostgreSQL password for ${DB_USER}: " DB_PASSWORD
echo
[[ -n "$DB_PASSWORD" && "$DB_PASSWORD" != *$'\n'* ]] || die "A non-empty single-line database password is required."

ROOT_STORAGE="${ROOT_STORAGE:-$(pvesm status -content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" {print $1; exit}')}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-$(pvesm status -content vztmpl 2>/dev/null | awk 'NR > 1 && $3 == "active" {print $1; exit}')}"
[[ -n "$ROOT_STORAGE" ]] || die "No active Proxmox storage supports rootdir content."
[[ -n "$TEMPLATE_STORAGE" ]] || die "No active Proxmox storage supports vztmpl content."

REPO_SLUG="${DEFAULT_REPO#https://github.com/}"
REPO_SLUG="${REPO_SLUG%.git}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}"
INSTALLER_FILE="$(mktemp)"
CONFIG_FILE="$(mktemp)"
TEMP_FILES+=("$INSTALLER_FILE" "$CONFIG_FILE")

info "Downloading the versioned container installer from ${REPO_SLUG}@${BRANCH}"
curl -fsSL --retry 3 "${RAW_BASE}/ops/proxmox/install.sh" -o "$INSTALLER_FILE"
grep -q "FINANCEAPP_LXC_INSTALLER" "$INSTALLER_FILE" || die "Downloaded installer is invalid."

MASTER_TOKEN="$(openssl rand -hex 32)"
DOCUMENT_KEY_B64="$(openssl rand -base64 32 | tr -d '\n')"
printf '%s' "$DB_PASSWORD" | base64 | tr -d '\n' >"${CONFIG_FILE}.password"
TEMP_FILES+=("${CONFIG_FILE}.password")
DB_PASSWORD_B64="$(<"${CONFIG_FILE}.password")"
cat >"$CONFIG_FILE" <<EOF
FINANCEAPP_REPO_URL=${DEFAULT_REPO}
FINANCEAPP_BRANCH=${BRANCH}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD_B64=${DB_PASSWORD_B64}
MASTER_TOKEN=${MASTER_TOKEN}
DOCUMENT_KEY_B64=${DOCUMENT_KEY_B64}
ENABLE_TAILSCALE=${ENABLE_TAILSCALE}
INSTALL_AI=${INSTALL_AI}
EOF
chmod 600 "$CONFIG_FILE"

if [[ "$RESUME_EXISTING" == "yes" ]]; then
  CT_ARCH="$(pct config "$CTID" | awk '$1 == "arch:" {print $2}')"
  [[ "$CT_ARCH" == "$HOST_ARCH" ]] ||
    die "Container ${CTID} is ${CT_ARCH:-unknown}, but this Proxmox host is ${HOST_ARCH}. Create a new container with a matching template; architecture cannot be repaired by resume."
  info "Resuming existing LXC ${CTID} and applying Debian 13 systemd features"
  pct set "$CTID" --features nesting=1,keyctl=1 --onboot 1
else
  info "Locating the latest Debian 13 ${HOST_ARCH} container template"
  pveam update >/dev/null
  TEMPLATE_NAME="$(pveam available --section system | awk -v arch="$HOST_ARCH" '$2 ~ /^debian-13-standard_/ && $2 ~ ("_" arch "\\.tar\\.(zst|xz|gz)$") {print $2}' | sort -V | tail -n 1)"
  [[ -n "$TEMPLATE_NAME" ]] || die "No Debian 13 ${HOST_ARCH} standard template is available."
  TEMPLATE_FILE="${TEMPLATE_NAME##*/}"
  if ! pveam list "$TEMPLATE_STORAGE" | awk '{print $1}' | grep -q "/${TEMPLATE_FILE}$"; then
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE_FILE"
  fi
  TEMPLATE_VOLUME="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE_FILE}"

  NET0="name=eth0,bridge=${BRIDGE},ip=${IP_CONFIG}"
  info "Creating unprivileged LXC ${CTID}"
  pct create "$CTID" "$TEMPLATE_VOLUME" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" \
    --memory "$MEMORY" \
    --swap "$SWAP" \
    --rootfs "${ROOT_STORAGE}:${DISK}" \
    --net0 "$NET0" \
    --unprivileged 1 \
    --features nesting=1,keyctl=1 \
    --onboot 1 \
    --start 0
fi

if [[ "$ENABLE_TAILSCALE" == "yes" ]]; then
  if ! grep -q '^lxc\.mount\.entry: /dev/net/tun ' "/etc/pve/lxc/${CTID}.conf"; then
    cat >>"/etc/pve/lxc/${CTID}.conf" <<'EOF'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
EOF
  fi
fi

if ! pct status "$CTID" | grep -q 'status: running'; then
  start_container
fi
info "Waiting for network connectivity"
for _attempt in {1..60}; do
  if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then break; fi
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null || die "The container has no network connectivity."

pct push "$CTID" "$INSTALLER_FILE" /root/financeapp-install.sh --perms 700
pct push "$CTID" "$CONFIG_FILE" /root/financeapp-install.env --perms 600
info "Installing ${APP} inside the container"
pct exec "$CTID" -- bash /root/financeapp-install.sh /root/financeapp-install.env
pct exec "$CTID" -- rm -f /root/financeapp-install.sh /root/financeapp-install.env

LXC_IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
ok "${APP} installed in LXC ${CTID} (${LXC_IP})."
echo
echo "Initial owner token (store it now; it is not shown again):"
echo "$MASTER_TOKEN"
echo
if [[ "$ENABLE_TAILSCALE" == "yes" ]]; then
  echo "Finish private HTTPS access with:"
  echo "  pct enter ${CTID}"
  echo "  tailscale up"
  echo "  financeapp-configure-tailscale"
else
  echo "LAN access: http://${LXC_IP}"
fi
echo
echo "Future updates inside the LXC: financeapp-update"

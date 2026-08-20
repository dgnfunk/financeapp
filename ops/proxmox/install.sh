#!/usr/bin/env bash
# FINANCEAPP_LXC_INSTALLER
set -Eeuo pipefail
umask 027

CONFIG_PATH="${1:-/root/financeapp-install.env}"
[[ -r "$CONFIG_PATH" ]] || { echo "Missing installer configuration" >&2; exit 1; }
# Values are generated or validated by financeapp-lxc.sh.
# shellcheck disable=SC1090
source "$CONFIG_PATH"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get dist-upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq nginx openssl redis-server postgresql-client \
  python3 python3-dev python3-venv build-essential libpq-dev xz-utils

install_node() {
  local architecture node_arch sums archive version
  architecture="$(dpkg --print-architecture)"
  case "$architecture" in
    amd64) node_arch="x64" ;;
    arm64) node_arch="arm64" ;;
    *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;;
  esac
  sums="$(curl -fsSL --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)"
  archive="$(awk -v arch="linux-${node_arch}.tar.xz" '$2 ~ arch {print $2; exit}' <<<"$sums")"
  [[ -n "$archive" ]] || { echo "Could not resolve Node.js 22 archive" >&2; exit 1; }
  version="${archive%%-linux-*}"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v22.x/${archive}" -o "/tmp/${archive}"
  (cd /tmp && grep " ${archive}$" <<<"$sums" | sha256sum -c -)
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "/tmp/${archive}" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/node" /usr/local/bin/node
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/npm" /usr/local/bin/npm
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/npx" /usr/local/bin/npx
  rm -f "/tmp/${archive}"
}
install_node

if [[ "${ENABLE_TAILSCALE:-yes}" == "yes" ]]; then
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg
  curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    -o /etc/apt/sources.list.d/tailscale.list
  apt-get update
  apt-get install -y tailscale
fi

id financeapp >/dev/null 2>&1 || useradd --system --home-dir /opt/financeapp --shell /usr/sbin/nologin financeapp
usermod -a -G financeapp www-data
install -d -o financeapp -g financeapp -m 0750 \
  /opt/financeapp /opt/financeapp/releases /opt/financeapp/shared \
  /var/lib/financeapp/documents /var/backups/financeapp
install -d -o root -g financeapp -m 0750 /etc/financeapp

if [[ ! -d /opt/financeapp/source/.git ]]; then
  runuser -u financeapp -- git clone --branch "$FINANCEAPP_BRANCH" --single-branch \
    "$FINANCEAPP_REPO_URL" /opt/financeapp/source
fi

DB_PASSWORD="$(printf '%s' "$DB_PASSWORD_B64" | base64 -d)"
export DB_USER DB_PASSWORD DB_HOST DB_PORT DB_NAME
PG_DSN="$(python3 - <<'PY'
import os
from urllib.parse import quote
print(f"postgresql://{quote(os.environ['DB_USER'], safe='')}:{quote(os.environ['DB_PASSWORD'], safe='')}@{os.environ['DB_HOST']}:{os.environ['DB_PORT']}/{quote(os.environ['DB_NAME'], safe='')}")
PY
)"
DATABASE_URL="${PG_DSN/postgresql:\/\//postgresql+psycopg:\/\/}"

cat >/etc/financeapp/financeapp.env <<EOF
DATABASE_URL=${DATABASE_URL}
REDIS_URL=redis://127.0.0.1:6379/0
MASTER_TOKEN=${MASTER_TOKEN}
DOCUMENT_KEY_B64=${DOCUMENT_KEY_B64}
DOCUMENT_DIR=/var/lib/financeapp/documents
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b-q4_K_M
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost
EOF
chmod 0640 /etc/financeapp/financeapp.env
chown root:financeapp /etc/financeapp/financeapp.env

{
  printf 'PGHOST=%q\n' "$DB_HOST"
  printf 'PGPORT=%q\n' "$DB_PORT"
  printf 'PGDATABASE=%q\n' "$DB_NAME"
  printf 'PGUSER=%q\n' "$DB_USER"
  printf 'PGPASSWORD=%q\n' "$DB_PASSWORD"
} >/etc/financeapp/postgres.env
chmod 0600 /etc/financeapp/postgres.env

cat >/etc/financeapp/deploy.conf <<EOF
FINANCEAPP_REPO_URL=${FINANCEAPP_REPO_URL}
FINANCEAPP_BRANCH=${FINANCEAPP_BRANCH}
INSTALL_AI=${INSTALL_AI:-no}
KEEP_RELEASES=3
EOF
chmod 0644 /etc/financeapp/deploy.conf

install -m 0755 /opt/financeapp/source/ops/proxmox/update.sh /usr/local/sbin/financeapp-update
install -m 0755 /opt/financeapp/source/ops/proxmox/configure-tailscale.sh /usr/local/sbin/financeapp-configure-tailscale

cat >/etc/systemd/system/financeapp-api.service <<'EOF'
[Unit]
Description=FinanceApp API
After=network-online.target redis-server.service
Wants=network-online.target
Requires=redis-server.service

[Service]
Type=simple
User=financeapp
Group=financeapp
EnvironmentFile=/etc/financeapp/financeapp.env
WorkingDirectory=/opt/financeapp/current/server
ExecStart=/opt/financeapp/current/server/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/financeapp

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/financeapp-worker.service <<'EOF'
[Unit]
Description=FinanceApp document worker
After=network-online.target redis-server.service financeapp-api.service
Requires=redis-server.service

[Service]
Type=simple
User=financeapp
Group=financeapp
EnvironmentFile=/etc/financeapp/financeapp.env
WorkingDirectory=/opt/financeapp/current/server
ExecStart=/opt/financeapp/current/server/.venv/bin/python -m app.worker
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/financeapp

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/nginx/sites-available/financeapp <<'EOF'
server {
  listen 127.0.0.1:80;
  server_name _;
  server_tokens off;
  client_max_body_size 25m;
  root /opt/financeapp/current/web/dist/client;
  index index.html;

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Permissions-Policy "camera=(self), microphone=(self), geolocation=()" always;
  add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;

  location /api/ {
    proxy_pass http://127.0.0.1:8000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location / { try_files $uri $uri/ /index.html; }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/financeapp /etc/nginx/sites-enabled/financeapp
nginx -t

systemctl daemon-reload
systemctl enable redis-server nginx financeapp-api financeapp-worker >/dev/null
systemctl start redis-server

if ! PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 -Atc 'select 1' >/dev/null; then
  LXC_IP="$(hostname -I | awk '{print $1}')"
  echo "PostgreSQL rejected the LXC connection. Permit ${LXC_IP}/32 in pg_hba.conf." >&2
  exit 1
fi

/usr/local/sbin/financeapp-update --initial
apt-get autoremove -y
apt-get clean

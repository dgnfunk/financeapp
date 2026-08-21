#!/usr/bin/env bash
# FINANCEAPP_LXC_INSTALLER
set -Eeuo pipefail
umask 027

CONFIG_PATH="${1:-/root/financeapp-install.env}"
[[ -r "$CONFIG_PATH" ]] || { echo "Missing installer configuration" >&2; exit 1; }
# Values are generated or validated by financeapp-lxc.sh.
# shellcheck disable=SC1090
source "$CONFIG_PATH"

: "${FINANCEAPP_REPO_URL:?Missing FINANCEAPP_REPO_URL}"
: "${FINANCEAPP_BRANCH:?Missing FINANCEAPP_BRANCH}"
: "${POSTGRES_DB:?Missing POSTGRES_DB}"
: "${POSTGRES_USER:?Missing POSTGRES_USER}"
: "${POSTGRES_PASSWORD_B64:?Missing POSTGRES_PASSWORD_B64}"
: "${MASTER_TOKEN:?Missing MASTER_TOKEN}"
: "${DOCUMENT_KEY_B64:?Missing DOCUMENT_KEY_B64}"
[[ "${CONFIG_VERSION:-}" == "2" ]] || { echo "Unsupported installer configuration version" >&2; exit 1; }
[[ "$POSTGRES_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid POSTGRES_DB" >&2; exit 1; }
[[ "$POSTGRES_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid POSTGRES_USER" >&2; exit 1; }
[[ "$POSTGRES_USER" != "postgres" ]] || { echo "POSTGRES_USER cannot be postgres" >&2; exit 1; }
[[ "$POSTGRES_USER" != pg_* ]] || { echo "POSTGRES_USER cannot use the reserved pg_ prefix" >&2; exit 1; }
[[ "$POSTGRES_DB" != "postgres" && "$POSTGRES_DB" != "template0" && "$POSTGRES_DB" != "template1" ]] || {
  echo "POSTGRES_DB uses a reserved name" >&2
  exit 1
}
POSTGRES_MAJOR=17
PG_BIN_DIR="/usr/lib/postgresql/${POSTGRES_MAJOR}/bin"
POSTGRES_CLUSTER_SERVICE="postgresql@${POSTGRES_MAJOR}-main.service"

MEMORY_MB="$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
MIN_MEMORY_MB=1800
[[ "${INSTALL_AI:-no}" != "yes" ]] || MIN_MEMORY_MB=8700
(( MEMORY_MB >= MIN_MEMORY_MB )) || {
  echo "Insufficient LXC memory: ${MEMORY_MB} MiB available, ${MIN_MEMORY_MB} MiB required for this profile." >&2
  exit 1
}
FREE_DISK_MB="$(df -Pm / | awk 'NR == 2 {print $4}')"
(( FREE_DISK_MB >= 2048 )) || {
  echo "Insufficient free disk: ${FREE_DISK_MB} MiB available; at least 2048 MiB is required before installation." >&2
  exit 1
}

export DEBIAN_FRONTEND=noninteractive
INSTALL_STATE=/var/lib/financeapp-installer
install -d -o root -g root -m 0700 "$INSTALL_STATE"
if [[ "${CONSOLE_AUTOLOGIN:-yes}" == "yes" ]]; then
  GETTY_OVERRIDE=/etc/systemd/system/container-getty@1.service.d/override.conf
  install -d -o root -g root -m 0755 "$(dirname "$GETTY_OVERRIDE")"
  cat >"$GETTY_OVERRIDE" <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF
  chmod 0644 "$GETTY_OVERRIDE"
  systemctl daemon-reload
  systemctl try-restart container-getty@1.service >/dev/null 2>&1 || true
else
  rm -f /etc/systemd/system/container-getty@1.service.d/override.conf
  systemctl daemon-reload
  systemctl try-restart container-getty@1.service >/dev/null 2>&1 || true
fi

TAILSCALE_READY="${INSTALL_STATE}/tailscale-v1"
if [[ ! -f "$TAILSCALE_READY" ]]; then
  # A previous interrupted run may have left the Tailscale source enabled with
  # a keyring created under this installer's restrictive umask. Bootstrap only
  # from Debian repositories, then recreate the source and public key below.
  rm -f /etc/apt/sources.list.d/tailscale.list
  if [[ -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]]; then
    chown root:root /usr/share/keyrings/tailscale-archive-keyring.gpg
    chmod 0644 /usr/share/keyrings/tailscale-archive-keyring.gpg
  fi
fi

BASE_READY="${INSTALL_STATE}/base-packages-v2"
for base_command in curl git jq nginx redis-server python3 gcc xz; do
  command -v "$base_command" >/dev/null 2>&1 || rm -f "$BASE_READY"
done
if [[ ! -f "$BASE_READY" ]]; then
  apt-get update
  apt-get dist-upgrade -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl git jq nginx openssl redis-server \
    python3 python3-dev python3-venv build-essential libpq-dev xz-utils
  touch "$BASE_READY"
else
  echo "Using cached base package stage"
fi

POSTGRES_READY="${INSTALL_STATE}/postgresql-local-17-v1"
if ! dpkg-query -W -f='${Status}' postgresql-17 2>/dev/null | grep -Fq 'install ok installed' ||
  [[ ! -x "$PG_BIN_DIR/psql" || ! -x "$PG_BIN_DIR/pg_dump" || ! -x "$PG_BIN_DIR/pg_restore" ]] ||
  ! pg_lsclusters --no-header | awk '$1 == 17 && $2 == "main" {found=1} END {exit !found}'; then
  rm -f "$POSTGRES_READY"
fi
if [[ ! -f "$POSTGRES_READY" ]]; then
  apt-get update
  apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17
else
  echo "Using cached local PostgreSQL 17 stage"
fi
if ! pg_lsclusters --no-header | awk '$1 == 17 && $2 == "main" {found=1} END {exit !found}'; then
  echo "Creating missing PostgreSQL ${POSTGRES_MAJOR}/main cluster"
  pg_createcluster "$POSTGRES_MAJOR" main --start-conf=auto
fi
for postgres_binary in postgres psql pg_dump pg_restore pg_isready; do
  [[ -x "${PG_BIN_DIR}/${postgres_binary}" ]] || {
    echo "Missing PostgreSQL ${POSTGRES_MAJOR} binary: ${PG_BIN_DIR}/${postgres_binary}" >&2
    exit 1
  }
done
pg_lsclusters --no-header | awk '$1 == 17 && $2 == "main" {found=1} END {exit !found}' || {
  echo "PostgreSQL ${POSTGRES_MAJOR}/main cluster was not created" >&2
  exit 1
}
touch "$POSTGRES_READY"

POSTGRES_PASSWORD="$(printf '%s' "$POSTGRES_PASSWORD_B64" | base64 -d)"
[[ -n "$POSTGRES_PASSWORD" ]] || { echo "Local PostgreSQL password is empty" >&2; exit 1; }
POSTGRES_CONFIG="/etc/postgresql/${POSTGRES_MAJOR}/main/postgresql.conf"
POSTGRES_DATA="/var/lib/postgresql/${POSTGRES_MAJOR}/main"
set_postgres_config_value() {
  local setting="$1" literal="$2" temporary
  temporary="$(mktemp "${POSTGRES_CONFIG}.financeapp.XXXXXX")"
  awk -v key="$setting" -v replacement="${setting} = ${literal}" '
    BEGIN {
      pattern = "^[[:space:]]*#?[[:space:]]*" key "[[:space:]]*="
      replaced = 0
    }
    $0 ~ pattern {
      if (!replaced) print replacement
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print replacement }
  ' "$POSTGRES_CONFIG" >"$temporary"
  chown --reference="$POSTGRES_CONFIG" "$temporary"
  chmod --reference="$POSTGRES_CONFIG" "$temporary"
  mv "$temporary" "$POSTGRES_CONFIG"
}
# pg_conftool misclassifies a numeric IPv4 address as an unquoted number and
# re-quotes already quoted input. Write the two fixed literals exactly instead.
set_postgres_config_value listen_addresses "'127.0.0.1'"
set_postgres_config_value password_encryption "'scram-sha-256'"
validate_postgres_setting() {
  local setting="$1" expected="$2" actual
  if ! actual="$(runuser -u postgres -- "$PG_BIN_DIR/postgres" \
    -D "$POSTGRES_DATA" -C "$setting" -c "config_file=${POSTGRES_CONFIG}" 2>&1)"; then
    echo "Invalid PostgreSQL configuration while reading ${setting}:" >&2
    echo "$actual" >&2
    exit 1
  fi
  [[ "$actual" == "$expected" ]] || {
    echo "Unexpected PostgreSQL ${setting}: expected ${expected}, got ${actual}" >&2
    exit 1
  }
}
validate_postgres_setting listen_addresses 127.0.0.1
validate_postgres_setting password_encryption scram-sha-256
PG_HBA="/etc/postgresql/${POSTGRES_MAJOR}/main/pg_hba.conf"
HBA_RULE="host ${POSTGRES_DB} ${POSTGRES_USER} 127.0.0.1/32 scram-sha-256"
grep -Fqx "$HBA_RULE" "$PG_HBA" || printf '%s\n' "$HBA_RULE" >>"$PG_HBA"
systemctl enable "$POSTGRES_CLUSTER_SERVICE" >/dev/null
if ! systemctl restart "$POSTGRES_CLUSTER_SERVICE"; then
  echo "PostgreSQL cluster ${POSTGRES_MAJOR}/main failed to start. Diagnostics:" >&2
  pg_lsclusters >&2 || true
  journalctl -u "$POSTGRES_CLUSTER_SERVICE" --no-pager -n 80 >&2 || true
  exit 1
fi
for _ in {1..30}; do
  if "$PG_BIN_DIR/pg_isready" --quiet --host /var/run/postgresql --port 5432; then break; fi
  sleep 1
done
if ! "$PG_BIN_DIR/pg_isready" --quiet --host /var/run/postgresql --port 5432; then
  echo "PostgreSQL cluster ${POSTGRES_MAJOR}/main started but did not become ready." >&2
  pg_lsclusters >&2 || true
  journalctl -u "$POSTGRES_CLUSTER_SERVICE" --no-pager -n 80 >&2 || true
  exit 1
fi

runuser -u postgres -- "$PG_BIN_DIR/psql" -v ON_ERROR_STOP=1 \
  --set=db_user="$POSTGRES_USER" --set=db_password="$POSTGRES_PASSWORD" postgres <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'db_user', :'db_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user') \gexec
SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'db_user', :'db_password'
) \gexec
SQL
runuser -u postgres -- "$PG_BIN_DIR/psql" -v ON_ERROR_STOP=1 \
  --set=db_name="$POSTGRES_DB" --set=db_user="$POSTGRES_USER" postgres <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db_name', :'db_user') \gexec
SQL

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
  chmod 0755 /usr/local/lib/nodejs
  chmod -R a+rX "/usr/local/lib/nodejs/${version}-linux-${node_arch}"
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/node" /usr/local/bin/node
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/npm" /usr/local/bin/npm
  ln -sfn "/usr/local/lib/nodejs/${version}-linux-${node_arch}/bin/npx" /usr/local/bin/npx
  rm -f "/tmp/${archive}"
}
NODE_READY="${INSTALL_STATE}/node-v2"
if [[ -f "$NODE_READY" ]] &&
  ! env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/npm --version >/dev/null 2>&1; then
  rm -f "$NODE_READY"
fi
if [[ ! -f "$NODE_READY" ]]; then
  install_node
  /usr/local/bin/node --version
  env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/npm --version
  touch "$NODE_READY"
else
  echo "Using cached Node.js stage"
fi

if [[ "${ENABLE_TAILSCALE:-yes}" == "yes" ]]; then
  if [[ -f "$TAILSCALE_READY" ]] &&
    { ! command -v tailscale >/dev/null 2>&1 || ! test -r /usr/share/keyrings/tailscale-archive-keyring.gpg; }; then
    rm -f "$TAILSCALE_READY"
  fi
  if [[ ! -f "$TAILSCALE_READY" ]]; then
    TAILSCALE_KEYRING_TMP="$(mktemp)"
    TAILSCALE_SOURCE_TMP="$(mktemp)"
    curl -fsSL --retry 3 https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
      -o "$TAILSCALE_KEYRING_TMP"
    curl -fsSL --retry 3 https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
      -o "$TAILSCALE_SOURCE_TMP"
    install -o root -g root -m 0644 "$TAILSCALE_KEYRING_TMP" \
      /usr/share/keyrings/tailscale-archive-keyring.gpg
    install -o root -g root -m 0644 "$TAILSCALE_SOURCE_TMP" \
      /etc/apt/sources.list.d/tailscale.list
    rm -f "$TAILSCALE_KEYRING_TMP" "$TAILSCALE_SOURCE_TMP"
    apt-get update
    apt-get install -y tailscale
    touch "$TAILSCALE_READY"
  else
    echo "Using cached Tailscale stage"
  fi
fi

id financeapp >/dev/null 2>&1 || useradd --system --home-dir /opt/financeapp --shell /usr/sbin/nologin financeapp
usermod -a -G financeapp www-data
install -d -o financeapp -g financeapp -m 0750 \
  /opt/financeapp /opt/financeapp/releases /opt/financeapp/shared \
  /var/lib/financeapp/documents
install -d -o root -g financeapp -m 0750 /etc/financeapp
install -d -o root -g root -m 0700 /var/backups/financeapp /var/backups/financeapp/daily
runuser -u financeapp -- env HOME=/opt/financeapp/shared PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/npm --version

if [[ ! -d /opt/financeapp/source/.git ]]; then
  runuser -u financeapp -- git clone --branch "$FINANCEAPP_BRANCH" --single-branch \
    "$FINANCEAPP_REPO_URL" /opt/financeapp/source
else
  runuser -u financeapp -- git -C /opt/financeapp/source remote set-url origin "$FINANCEAPP_REPO_URL"
  runuser -u financeapp -- git -C /opt/financeapp/source fetch --prune --tags origin
  runuser -u financeapp -- git -C /opt/financeapp/source checkout "$FINANCEAPP_BRANCH"
  runuser -u financeapp -- git -C /opt/financeapp/source merge --ff-only "origin/${FINANCEAPP_BRANCH}"
fi

export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
PG_DSN="$(python3 - <<'PY'
import os
from urllib.parse import quote
print(f"postgresql://{quote(os.environ['POSTGRES_USER'], safe='')}:{quote(os.environ['POSTGRES_PASSWORD'], safe='')}@127.0.0.1:5432/{quote(os.environ['POSTGRES_DB'], safe='')}?sslmode=disable")
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
  printf 'PGHOST=%q\n' 127.0.0.1
  printf 'PGPORT=%q\n' 5432
  printf 'PGDATABASE=%q\n' "$POSTGRES_DB"
  printf 'PGUSER=%q\n' "$POSTGRES_USER"
  printf 'PGPASSWORD=%q\n' "$POSTGRES_PASSWORD"
  printf 'PGSSLMODE=%q\n' disable
  printf 'POSTGRES_MAJOR=%q\n' "$POSTGRES_MAJOR"
  printf 'PG_BIN_DIR=%q\n' "$PG_BIN_DIR"
} >/etc/financeapp/postgres.env
chmod 0600 /etc/financeapp/postgres.env

cat >/etc/financeapp/deploy.conf <<EOF
FINANCEAPP_REPO_URL=${FINANCEAPP_REPO_URL}
FINANCEAPP_BRANCH=${FINANCEAPP_BRANCH}
INSTALL_AI=${INSTALL_AI:-no}
POSTGRES_MAJOR=${POSTGRES_MAJOR}
PG_BIN_DIR=${PG_BIN_DIR}
KEEP_RELEASES=3
KEEP_BACKUPS=7
MIN_FREE_DISK_MB=2048
EOF
chmod 0644 /etc/financeapp/deploy.conf

install -m 0755 /opt/financeapp/source/ops/proxmox/update.sh /usr/local/sbin/financeapp-update
install -m 0755 /opt/financeapp/source/ops/proxmox/configure-tailscale.sh /usr/local/sbin/financeapp-configure-tailscale
install -m 0755 /opt/financeapp/source/ops/proxmox/backup.sh /usr/local/sbin/financeapp-backup

cat >/etc/systemd/system/financeapp-api.service <<'EOF'
[Unit]
Description=FinanceApp API
After=network-online.target postgresql@17-main.service redis-server.service
Wants=network-online.target
Requires=postgresql@17-main.service redis-server.service

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
After=network-online.target postgresql@17-main.service redis-server.service financeapp-api.service
Requires=postgresql@17-main.service redis-server.service

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

cat >/etc/systemd/system/financeapp-backup.service <<'EOF'
[Unit]
Description=FinanceApp daily PostgreSQL backup
After=postgresql@17-main.service
Requires=postgresql@17-main.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/financeapp-backup
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/backups/financeapp
EOF

cat >/etc/systemd/system/financeapp-backup.timer <<'EOF'
[Unit]
Description=Run FinanceApp PostgreSQL backup daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
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
systemctl enable "$POSTGRES_CLUSTER_SERVICE" redis-server nginx financeapp-api financeapp-worker financeapp-backup.timer >/dev/null
systemctl start "$POSTGRES_CLUSTER_SERVICE" redis-server

if ! PGPASSWORD="$POSTGRES_PASSWORD" PGSSLMODE=disable "$PG_BIN_DIR/psql" \
  -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -Atc 'select 1' >/dev/null; then
  echo "Local PostgreSQL rejected the generated FinanceApp credentials." >&2
  exit 1
fi

/usr/local/sbin/financeapp-update --initial
/usr/local/sbin/financeapp-backup
systemctl start financeapp-backup.timer
touch "$INSTALL_STATE/install-complete-v2"
apt-get autoremove -y
apt-get clean

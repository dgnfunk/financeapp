#!/bin/sh
set -eu

: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD_FILE:?Set RESTIC_PASSWORD_FILE}"

backup_tmp="$(mktemp -d)"
trap 'find "$backup_tmp" -mindepth 1 -delete; rmdir "$backup_tmp"' EXIT
mkdir -p "$backup_tmp/documents"

docker compose --profile core exec -T postgres pg_dump -U finanzas -d finanzas -Fc > "$backup_tmp/postgres.dump"
docker run --rm \
  -v finanzas-personales_encrypted-documents:/source:ro \
  -v "$backup_tmp/documents:/backup" \
  alpine:3.21 sh -c 'cp -a /source/. /backup/'

restic backup "$backup_tmp" --tag finanzas
restic forget --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune

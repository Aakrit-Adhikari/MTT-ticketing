#!/bin/sh
# Logical backup of the database. Run from the repo root on the Docker host.
# The dump never touches a command line with secrets: credentials are read inside the container.
# A volume is NOT a backup — copy the output OFF this machine and encrypt it (see docs/OPERATIONS.md).
set -eu
mkdir -p backups
out="backups/mtt-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$out"
[ -s "$out" ] || { echo "backup is empty, aborting" >&2; rm -f "$out"; exit 1; }
chmod 600 "$out"
echo "wrote $out ($(wc -c < "$out") bytes). Now encrypt and copy it off-host."

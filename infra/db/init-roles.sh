#!/bin/sh
# Runs once, on first initialisation of an empty data volume (docker-entrypoint-initdb.d).
set -eu
for v in MIGRATOR_DB_PASSWORD APP_DB_PASSWORD; do
  eval "val=\${$v:-}"
  # Restricting the alphabet makes SQL/URL injection impossible and keeps DATABASE_URL simple.
  case "$val" in
    ''|*[!A-Za-z0-9_-]*) echo "init-roles: $v must be set and contain only A-Z a-z 0-9 _ -" >&2; exit 1 ;;
  esac
  [ "${#val}" -ge 24 ] || { echo "init-roles: $v must be at least 24 characters" >&2; exit 1; }
done
sed -e "s/__MIGRATOR_PW__/${MIGRATOR_DB_PASSWORD}/" -e "s/__APP_PW__/${APP_DB_PASSWORD}/" -e "s/__DB__/${POSTGRES_DB}/g" \
  /roles.sql | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"

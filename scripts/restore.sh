#!/bin/sh
# Restore a dump INTO A SCRATCH DATABASE for verification, or into the live one with --live (destructive).
#   scripts/restore.sh backups/file.dump            -> restores into database "<POSTGRES_DB>_restore_test"
#   scripts/restore.sh backups/file.dump --live     -> replaces the live database contents (stop backend first!)
set -eu
dump="${1:?usage: restore.sh <dump-file> [--live]}"
[ -s "$dump" ] || { echo "no such dump: $dump" >&2; exit 1; }
if [ "${2:-}" = "--live" ]; then
  printf 'This OVERWRITES the live database. Type YES to continue: '; read -r a; [ "$a" = "YES" ] || exit 1
  target='"$POSTGRES_DB"'
else
  target='"${POSTGRES_DB}_restore_test"'
fi
docker compose exec -T db sh -c "export PGPASSWORD=\"\$POSTGRES_PASSWORD\"; T=$target;
  if [ \"\$T\" != \"\$POSTGRES_DB\" ]; then dropdb -U \"\$POSTGRES_USER\" --if-exists \"\$T\"; createdb -U \"\$POSTGRES_USER\" -O mtt_migrator \"\$T\"; fi;
  pg_restore -U \"\$POSTGRES_USER\" -d \"\$T\" --clean --if-exists --no-owner --role=mtt_migrator --exit-on-error" < "$dump"
echo "restore finished"

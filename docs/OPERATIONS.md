# Operations: backup, restore, upgrades

> A Docker volume (`pgdata`) is **not** a backup. It dies with the host, and it faithfully stores corruption and mistakes.
> These procedures were written but **not executed** in the authoring environment: do a full drill before relying on them.

## What must be backed up

1. **PostgreSQL** (`scripts/backup.sh`): all business data.
2. **`FIELD_ENCRYPTION_KEY`** and the rest of `.env`: without the key, encrypted passenger fields in the dump are unrecoverable.
   Store it in a password manager / secrets vault, **separately** from the database backups.
3. The `caddy_data` volume is optional (certificates re-issue automatically).

## Backup

```bash
scripts/backup.sh                         # writes backups/mtt-<UTC timestamp>.dump (custom format, mode 600)
```
Then encrypt and copy **off the host**, for example:
```bash
gpg --symmetric --cipher-algo AES256 backups/mtt-YYYYMMDDTHHMMSSZ.dump      # or: age -p -o file.age file.dump
rclone copy backups/mtt-*.dump.gpg remote:agency-backups/                    # any off-site store you control
```
Suggested schedule (cron on the host): daily, keep 14 daily + 12 monthly; alert if a backup is missing or tiny.
`backups/` is git-ignored. Treat these files as sensitive personal data (access-controlled, encrypted at rest).

## Restore drill (do this before go-live and quarterly)

```bash
scripts/restore.sh backups/mtt-YYYYMMDDTHHMMSSZ.dump        # restores into scratch DB "<POSTGRES_DB>_restore_test"
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB}_restore_test" -c "select count(*) from \"Booking\""'
docker compose exec db sh -c 'dropdb -U "$POSTGRES_USER" "${POSTGRES_DB}_restore_test"'
```

## Disaster recovery (replace the live database)

```bash
docker compose stop backend frontend proxy
scripts/restore.sh backups/<file>.dump --live               # asks you to type YES
docker compose --profile ops run --rm migrate               # applies any newer migrations
docker compose up -d backend frontend proxy
BASE_URL=https://YOUR_DOMAIN node scripts/smoke.mjs
```
After a restore, confirm refresh sessions issued after the backup are gone (users simply sign in again).

## Upgrades

```bash
git pull && docker compose build
docker compose --profile ops run --rm migrate              # migrations are forward-only; take a backup first
docker compose up -d backend frontend
```
Never run `prisma migrate dev` against production. `migrate deploy` (used here) only applies committed migrations.

## Rotating secrets
* DB passwords: `ALTER ROLE mtt_app PASSWORD '…'` (and `mtt_migrator`), update `.env`, `docker compose up -d backend`.
  (Role passwords are only read from `.env` on first volume init.)
* JWT secret: update `.env`, `docker compose up -d backend`. All access tokens are invalidated.
* Encryption key: see docs/SECURITY.md (manual re-encryption required).

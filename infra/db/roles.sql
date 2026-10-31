-- Least-privilege database roles. Placeholders are substituted by infra/db/init-roles.sh after validation.
--   mtt_migrator : owns the schema, runs `prisma migrate deploy` (DDL). Used only by the one-shot migrate job.
--   mtt_app      : used by the running API. DML only; cannot create/alter/drop objects.
-- The bootstrap superuser (POSTGRES_USER) is not used by any application container.
CREATE ROLE mtt_migrator LOGIN PASSWORD '__MIGRATOR_PW__';
CREATE ROLE mtt_app LOGIN PASSWORD '__APP_PW__';

REVOKE ALL ON DATABASE "__DB__" FROM PUBLIC;
GRANT CONNECT ON DATABASE "__DB__" TO mtt_migrator, mtt_app;
ALTER DATABASE "__DB__" OWNER TO mtt_migrator;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO mtt_migrator;
GRANT USAGE ON SCHEMA public TO mtt_app;

ALTER DEFAULT PRIVILEGES FOR ROLE mtt_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mtt_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mtt_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mtt_app;

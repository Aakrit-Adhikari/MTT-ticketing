-- Audit and inventory-adjustment records are append-only for the application's database role.
-- The role is created by infra/db/roles.sql at database initialisation; skip quietly if it doesn't exist (e.g. local dev).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mtt_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog", "InventoryAdjustment" FROM mtt_app;
  END IF;
END
$$;

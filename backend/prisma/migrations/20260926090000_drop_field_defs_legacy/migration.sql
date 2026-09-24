-- Go-live preparation (owner decision 2026-09-24, docs/DEPLOYMENT.md §4).
-- The JSON copy of the credential field definitions was kept after
-- 20260924100000_database_first_master_data only as a rollback reference.
-- Nothing reads it; the fields live in credential_template_fields, and in a
-- fresh (production) database the column is always empty. Rollback point:
-- the pg_dump nurseapp_v04_pre-go-live_2026-09-24.dump taken just before.
ALTER TABLE "credential_templates" DROP COLUMN "field_defs_legacy";

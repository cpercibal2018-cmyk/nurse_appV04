-- 01_roles.sql — database roles for V04 (spec §10.7, adapted: see README.md).
--
-- Run ONCE per PostgreSQL server, as a superuser, CONNECTED TO THE APPLICATION
-- DATABASE (it makes that database's owner a member of the migration role):
--
--   psql -U postgres -d nurseapp_v04 -f ops/db/01_roles.sql
--
-- Idempotent. Creates the roles WITHOUT passwords: set each one afterwards at
-- the psql prompt with  \password nurseapp_runtime  (and so on), so no
-- password is ever written into a file, a shell history or a server log.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('nurseapp_migration',    false),  -- prisma migrate deploy; owns the schema objects
    ('nurseapp_runtime',      false),  -- API and worker: data only, no DDL
    ('nurseapp_backup',       true),   -- pg_basebackup / pg_dump: read-only + replication
    ('nurseapp_audit_reader', false)   -- compliance queries: audit tables only
  ) AS t(name, replication) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS %s',
                     r.name, CASE WHEN r.replication THEN 'REPLICATION' ELSE 'NOREPLICATION' END);
    END IF;
  END LOOP;
END $$;

-- The backup role reads every table without owning or writing any (PostgreSQL 14+).
GRANT pg_read_all_data TO nurseapp_backup;

-- The database owner runs 02_grants.sql after every migration. To hand the
-- schema objects to the migration role and set its default privileges, the
-- owner must be a member of it.
DO $$
DECLARE
  owner_name TEXT := (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database());
BEGIN
  IF owner_name NOT IN ('nurseapp_migration', 'nurseapp_runtime', 'nurseapp_backup', 'nurseapp_audit_reader') THEN
    EXECUTE format('GRANT nurseapp_migration TO %I', owner_name);
  END IF;
END $$;

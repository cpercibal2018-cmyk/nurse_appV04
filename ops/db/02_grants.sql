-- 02_grants.sql — privileges for the V04 roles in ONE database (spec §10.7,
-- adapted: see README.md). Run as the database owner, connected to the
-- database, after 01_roles.sql and again after EVERY `prisma migrate deploy`:
--
--   psql -U <database owner> -d nurseapp_v04 -f ops/db/02_grants.sql
--
-- Idempotent. Safe on an empty database (fresh installation) and on one whose
-- objects were created by the owner before the roles existed (it hands them to
-- the migration role).

-- ── extensions the first migration needs, created by the owner ─────────────
-- (the migration role then finds them and never needs CREATE on the database)
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── schema ──────────────────────────────────────────────────────────────────
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nurseapp_migration, nurseapp_runtime, nurseapp_backup, nurseapp_audit_reader;
GRANT CREATE ON SCHEMA public TO nurseapp_migration;

-- ── the migration role owns every schema object ────────────────────────────
-- In PostgreSQL only an object's owner may ALTER or DROP it, so migrations
-- must run as the owner of the objects. Extension members stay with the
-- extension; sequences owned by a table follow the table.
DO $$
DECLARE
  o RECORD;
BEGIN
  FOR o IN
    SELECT CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW'
                          WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' END AS kind,
           format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND pg_get_userbyid(c.relowner) <> 'nurseapp_migration'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO nurseapp_migration', o.kind, o.name);
  END LOOP;

  FOR o IN
    SELECT format('%I.%I', n.nspname, t.typname) AS name
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND t.typrelid = 0
      AND pg_get_userbyid(t.typowner) <> 'nurseapp_migration'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO nurseapp_migration', o.name);
  END LOOP;

  FOR o IN
    SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS name,
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
      AND pg_get_userbyid(p.proowner) <> 'nurseapp_migration'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO nurseapp_migration', o.kind, o.name);
  END LOOP;
END $$;

-- ── runtime: read and write data; no DDL, no TRUNCATE ──────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nurseapp_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nurseapp_runtime;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM nurseapp_runtime;
-- The migration journal belongs to the migration role alone.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM nurseapp_runtime;
  END IF;
END $$;
-- Audit is append-only (A2): the runtime appends through fn_append_audit_entry
-- and reads; the privilege is refused here, and the trigger refuses it again.
-- Break-glass events are never deleted (the trigger already refuses it); the
-- daily job updates their end time, so UPDATE stays.
DO $$
BEGIN
  IF to_regclass('public.audit_entries') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON public.audit_entries FROM nurseapp_runtime;
  END IF;
  IF to_regclass('public.break_glass_events') IS NOT NULL THEN
    REVOKE DELETE ON public.break_glass_events FROM nurseapp_runtime;
  END IF;
END $$;

-- ── audit reader: the audit tables only ─────────────────────────────────────
-- Of the spec's list (audit_entries, audit_batches, audit_snapshots,
-- scfhs_verification_log, grace_period_log, push_delivery_log,
-- idempotency_keys) V04 has audit_entries and idempotency_keys; the
-- audit_chain_breaks view is the chain verification over audit_entries.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_entries', 'audit_chain_breaks', 'idempotency_keys'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO nurseapp_audit_reader', t);
    END IF;
  END LOOP;
END $$;

-- ── objects created by later migrations are usable at once ─────────────────
-- (the table-specific refusals above are re-applied by re-running this file)
ALTER DEFAULT PRIVILEGES FOR ROLE nurseapp_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nurseapp_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nurseapp_migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nurseapp_runtime;

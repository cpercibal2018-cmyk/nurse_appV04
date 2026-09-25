-- verify.sql — confirms the database roles are applied (spec §10.7; README.md).
--
-- Run as a SUPERUSER, connected to the application database, after
-- 01_roles.sql + passwords + 02_grants.sql, and again after every release:
--
--   psql -v ON_ERROR_STOP=1 -U postgres -d nurseapp_v04 -f ops/db/verify.sql
--
-- Read-only (a temporary table holds the results). Prints one row per check —
-- PASS, FAIL or WARN with the offending objects — and exits non-zero when any
-- check FAILs. Run it on every server and every application database.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'verify.sql must run as a superuser (it reads pg_authid to confirm the passwords are set)';
  END IF;
  -- The privilege checks below need the roles to exist.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['nurseapp_migration', 'nurseapp_runtime', 'nurseapp_backup', 'nurseapp_audit_reader']) r
             WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)) THEN
    RAISE EXCEPTION 'database roles: FAILED — missing role(s): % — run 01_roles.sql first (ops/db/README.md)',
      (SELECT string_agg(r, ', ') FROM unnest(ARRAY['nurseapp_migration', 'nurseapp_runtime', 'nurseapp_backup', 'nurseapp_audit_reader']) r
        WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r));
  END IF;
END $$;

CREATE TEMP TABLE role_checks (n int, "check" text, status text, detail text);

WITH
roles(name, replication) AS (VALUES
  ('nurseapp_migration', false), ('nurseapp_runtime', false), ('nurseapp_backup', true), ('nurseapp_audit_reader', false)),
owner AS (SELECT pg_get_userbyid(datdba) AS name FROM pg_database WHERE datname = current_database()),
tabs AS (  -- ordinary tables and views in public (Prisma's journal included)
  SELECT c.oid, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p')),
audit_objects(name) AS (VALUES ('audit_entries'), ('audit_chain_breaks'), ('idempotency_keys'), ('break_glass_events'), ('privileged_sessions'), ('request_audit_log')),
not_migration_owned AS (
  SELECT 'table ' || c.relname AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'p', 'S', 'm') AND pg_get_userbyid(c.relowner) <> 'nurseapp_migration'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND pg_get_userbyid(t.typowner) <> 'nurseapp_migration'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
  UNION ALL
  SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'nurseapp_migration'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
runtime_missing AS (  -- data access the runtime must have (the documented refusals excepted)
  SELECT relname || ':' || priv AS obj FROM tabs CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
   WHERE relname <> '_prisma_migrations' AND relkind <> 'v'
     AND NOT (relname = 'audit_entries' AND priv IN ('UPDATE', 'DELETE'))
     AND NOT (relname = 'break_glass_events' AND priv = 'DELETE')
     AND NOT (relname = 'request_audit_log' AND priv = 'UPDATE')
     AND NOT (relname = 'data_subject_requests' AND priv = 'DELETE')
     AND NOT has_table_privilege('nurseapp_runtime', oid, priv)
  UNION ALL
  SELECT relname || ':SELECT' FROM tabs WHERE relkind = 'v' AND NOT has_table_privilege('nurseapp_runtime', oid, 'SELECT')
  UNION ALL
  SELECT c.relname || ':USAGE' FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     -- CASE: the planner may test this before the relkind filter, and it errors on non-sequences.
     AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege('nurseapp_runtime', c.oid, 'USAGE') ELSE false END),
runtime_forbidden AS (
  SELECT relname || ':TRUNCATE' AS obj FROM tabs WHERE relkind <> 'v' AND has_table_privilege('nurseapp_runtime', oid, 'TRUNCATE')
  UNION ALL SELECT 'audit_entries:' || p FROM unnest(ARRAY['UPDATE', 'DELETE']) p
   WHERE to_regclass('public.audit_entries') IS NOT NULL AND has_table_privilege('nurseapp_runtime', 'public.audit_entries', p)
  UNION ALL SELECT 'break_glass_events:DELETE'
   WHERE to_regclass('public.break_glass_events') IS NOT NULL AND has_table_privilege('nurseapp_runtime', 'public.break_glass_events', 'DELETE')
  UNION ALL SELECT 'request_audit_log:UPDATE'
   WHERE to_regclass('public.request_audit_log') IS NOT NULL AND has_table_privilege('nurseapp_runtime', 'public.request_audit_log', 'UPDATE')
  UNION ALL SELECT 'data_subject_requests:DELETE'
   WHERE to_regclass('public.data_subject_requests') IS NOT NULL AND has_table_privilege('nurseapp_runtime', 'public.data_subject_requests', 'DELETE')
  UNION ALL SELECT '_prisma_migrations:SELECT'
   WHERE to_regclass('public._prisma_migrations') IS NOT NULL AND has_table_privilege('nurseapp_runtime', 'public._prisma_migrations', 'SELECT')
  UNION ALL SELECT 'schema public:CREATE' WHERE has_schema_privilege('nurseapp_runtime', 'public', 'CREATE')
  UNION ALL SELECT 'member of nurseapp_migration' WHERE pg_has_role('nurseapp_runtime', 'nurseapp_migration', 'MEMBER')),
reader_missing AS (
  SELECT a.name AS obj FROM audit_objects a
   WHERE to_regclass('public.' || a.name) IS NOT NULL AND NOT has_table_privilege('nurseapp_audit_reader', ('public.' || a.name)::regclass, 'SELECT')),
reader_forbidden AS (
  SELECT relname || ':SELECT' AS obj FROM tabs
   WHERE relname NOT IN (SELECT name FROM audit_objects) AND has_table_privilege('nurseapp_audit_reader', oid, 'SELECT')
  UNION ALL
  SELECT relname || ':' || priv FROM tabs CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE relkind <> 'v' AND has_table_privilege('nurseapp_audit_reader', oid, priv)),
backup_forbidden AS (
  SELECT relname || ':' || priv AS obj FROM tabs CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
   WHERE relkind <> 'v' AND has_table_privilege('nurseapp_backup', oid, priv)),
privileged_sessions AS (  -- other sessions on this database that can change the schema
  SELECT DISTINCT a.usename || coalesce(' (' || nullif(a.application_name, '') || ')', '') AS who
    FROM pg_stat_activity a JOIN pg_roles r ON r.rolname = a.usename
   WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
     AND (r.rolsuper OR a.usename = (SELECT name FROM owner) OR pg_has_role(a.usename, 'nurseapp_migration', 'MEMBER')))
INSERT INTO role_checks
SELECT 1, 'the four roles exist as plain logins',
  CASE WHEN count(r.oid) = 4 AND bool_and(r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolbypassrls) THEN 'PASS' ELSE 'FAIL' END,
  coalesce(string_agg(CASE WHEN r.oid IS NULL THEN roles.name || ' missing (run 01_roles.sql)'
    WHEN NOT r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls THEN roles.name || ' has extra attributes' END, '; '), '')
FROM roles LEFT JOIN pg_roles r ON r.rolname = roles.name
UNION ALL
SELECT 2, 'each role has a password',
  CASE WHEN count(*) FILTER (WHERE a.rolpassword IS NULL) = 0 THEN 'PASS' ELSE 'FAIL' END,
  coalesce(string_agg(roles.name, ', ') FILTER (WHERE a.rolpassword IS NULL) || ' — set with \password <role>', '')
FROM roles LEFT JOIN pg_authid a ON a.rolname = roles.name
UNION ALL
SELECT 3, 'backup role: replication + pg_read_all_data',
  CASE WHEN coalesce((SELECT rolreplication FROM pg_roles WHERE rolname = 'nurseapp_backup'), false)
        AND pg_has_role('nurseapp_backup', 'pg_read_all_data', 'MEMBER') THEN 'PASS' ELSE 'FAIL' END, ''
UNION ALL
SELECT 4, 'database owner is a member of nurseapp_migration',
  CASE WHEN pg_has_role((SELECT name FROM owner), 'nurseapp_migration', 'MEMBER') THEN 'PASS' ELSE 'FAIL' END,
  'owner: ' || (SELECT name FROM owner)
UNION ALL
SELECT 5, 'nurseapp_migration owns every schema object',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
  coalesce((array_to_string((array_agg(obj ORDER BY obj))[1:5], ', ') || CASE WHEN count(*) > 5 THEN format(' … (%s)', count(*)) ELSE '' END) || ' — run 02_grants.sql', '')
FROM not_migration_owned
UNION ALL
SELECT 6, 'runtime can read and write every data table',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
  coalesce(array_to_string((array_agg(obj ORDER BY obj))[1:5], ', ') || ' — run 02_grants.sql', '')
FROM runtime_missing
UNION ALL
SELECT 7, 'runtime cannot change the schema, truncate, rewrite audit or read the journal',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
  coalesce(array_to_string(array_agg(obj ORDER BY obj), ', ') || ' — run 02_grants.sql', '')
FROM runtime_forbidden
UNION ALL
SELECT 8, 'audit reader reads the audit and security-event tables (D-45)',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(string_agg(obj, ', ') || ' — run 02_grants.sql', '')
FROM reader_missing
UNION ALL
SELECT 9, 'audit reader reads nothing else and writes nothing',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(array_to_string((array_agg(obj ORDER BY obj))[1:5], ', '), '')
FROM reader_forbidden
UNION ALL
SELECT 10, 'backup role writes nothing',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END, coalesce(array_to_string((array_agg(obj ORDER BY obj))[1:5], ', '), '')
FROM backup_forbidden
UNION ALL
SELECT 11, 'no other session is connected with schema rights',
  CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'WARN' END,
  coalesce(string_agg(who, ', ') || ' — if this is the API or worker, point DATABASE_URL at nurseapp_runtime', '')
FROM privileged_sessions;

SELECT n AS "#", "check", status, detail FROM role_checks ORDER BY n;

DO $$
DECLARE
  failed int := (SELECT count(*) FROM role_checks WHERE status = 'FAIL');
BEGIN
  IF failed > 0 THEN
    RAISE EXCEPTION 'database roles: % check(s) FAILED — see the table above and ops/db/README.md', failed;
  END IF;
  RAISE NOTICE 'database roles: all checks passed';
END $$;

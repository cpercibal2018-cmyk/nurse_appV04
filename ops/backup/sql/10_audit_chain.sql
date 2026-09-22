-- ops/backup/sql/10_audit_chain.sql
-- Canonical audit schema (specification Section 9.1, added in rev 2.8.7).
-- Required by the restore drill: the post-restore checklist verifies this
-- table's hash chain, so it must exist before any data is loaded.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_entries (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      INTEGER,
  action        VARCHAR(100) NOT NULL,
  resource      VARCHAR(100) NOT NULL,
  resource_id   VARCHAR(100),
  changes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash VARCHAR(64),
  hash          VARCHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_entries(resource, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_entries(actor_id, created_at DESC);

-- Single supported write path, serialized with a transaction-scoped advisory
-- lock so concurrent writers cannot fork the chain.
CREATE OR REPLACE FUNCTION fn_append_audit_entry(
  p_actor_id    INTEGER,
  p_action      VARCHAR,
  p_resource    VARCHAR,
  p_resource_id VARCHAR,
  p_changes     JSONB
) RETURNS BIGINT AS $$
DECLARE
  v_previous_hash VARCHAR(64);
  v_hash          VARCHAR(64);
  v_id            BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_entries_chain'));

  SELECT hash INTO v_previous_hash
    FROM audit_entries
   ORDER BY id DESC
   LIMIT 1;

  v_hash := encode(
    digest(
      coalesce(v_previous_hash, '') || p_action || p_resource ||
      coalesce(p_resource_id, '') || coalesce(p_changes::text, '') ||
      extract(epoch FROM clock_timestamp())::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO audit_entries
    (actor_id, action, resource, resource_id, changes, previous_hash, hash)
  VALUES
    (p_actor_id, p_action, p_resource, p_resource_id,
     coalesce(p_changes, '{}'::jsonb), v_previous_hash, v_hash)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

-- Chain verification used by the restore drill and the post-restore checklist.
CREATE OR REPLACE VIEW audit_chain_breaks AS
SELECT id, previous_hash, lag(hash) OVER (ORDER BY id) AS expected_previous
  FROM audit_entries;
